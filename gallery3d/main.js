// Entry point. Wires DOM ↔ scene: hooks up the form/handle, runs the
// engage flow (load feed → build scene → swap to click-to-enter), and
// hosts the per-frame animate loop (movement, postprocessing, audio).
//
// Heavy lifting lives in src/:
//   bsky-feed.js       — feed source resolution + paginated media fetch
//   textures.js        — image / video / PBR texture helpers
//   placard.js         — Canvas2D museum-label texture
//   people.js          — GLB-loaded characters placed in front of artwork
//   room-builder.js    — geometry of a single room
//   gallery-manager.js — sliding window of rooms + recycle / collide / update
//   carousel.js        — legacy ?mode=carousel layout

import * as THREE from 'three/webgpu';
const { Timer } = THREE;
import { mrt, output, normalView, pass, mix, uniform, screenUV, smoothstep, vec2 } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import {
  parseSource, resolveSource, fetchInitialMedia, fetchSourceName,
} from './src/bsky-feed.js';
import { setMaxAniso, loadPBRSet, galleryVideos } from './src/textures.js';
import { loadPeopleTemplates } from './src/people.js';
import { createGalleryManager } from './src/gallery-manager.js';
import { buildCarousel } from './src/carousel.js';
import { createTour } from './src/tour.js';

// ---- Config ----
const MOVE_SPEED  = 4;
const SPRINT_MULT = 2.5;
// Pre-fills the handle field when no ?list=/?feed=/?handle= is supplied, so
// the gallery is one tap from loading on a fresh visit.
const DEFAULT_BOOT_INPUT = 'https://bsky.app/profile/felixturner.bsky.social/lists/3mkolikdciy2c';
// Drag-look sensitivity (rad/pixel) is derived from the camera FOV + viewport
// so a finger-drag tracks the content ~1:1; see computeLookSens(). It depends
// only on FOV (fixed) and height, so it's recomputed on resize, not per frame.
const LOOK_DRAG_THRESH = 6;                     // px before a press counts as a drag (vs tap)
const LOOK_MAX_PITCH  = Math.PI * 40 / 180;     // clamp vertical look to ±40°
const CAROUSEL_INITIAL_COUNT = 50;
const GALLERY_INITIAL_COUNT  = 70; // enough for SLOT_COUNT rooms + margin

// ---- DOM ----
const overlayEl     = document.getElementById('overlay');
const overlayStatus = document.getElementById('overlay-status');
const engagePrompt  = document.getElementById('engage-prompt');
const form          = document.getElementById('form');
const handleInput   = document.getElementById('handle');
const repostsRow    = document.getElementById('reposts-row');
const repostsToggle = document.getElementById('reposts');
const countEl       = document.getElementById('count');
const infoEl        = document.getElementById('info');
const escHintEl     = document.getElementById('esc-hint');
const reticleEl     = document.getElementById('reticle');
const navControls   = document.getElementById('nav-controls');
const navPrev       = document.getElementById('nav-prev');
const navNext       = document.getElementById('nav-next');
const tapHintEl     = document.getElementById('tap-hint');
const mobileExitEl  = document.getElementById('mobile-exit');

const ASSET_BASE = import.meta.env.BASE_URL; // '/' in dev, '/bsky-gallery/3d/' in prod
const MODE = (new URL(window.location).searchParams.get('mode') || 'gallery');
const DEV_MODE = new URL(window.location).searchParams.get('dev') === 'true';

const _qs = new URL(window.location).searchParams;
// Mobile/touch nav (approach #3): a yaw look-joystick + tap-a-picture-to-walk
// guided tour instead of pointer-lock + WASD. Auto-on for touch; forced on for
// desktop testing with ?nav=joystick (or the legacy ?nav=buttons alias).
const NAV_TOUR = _qs.get('nav') === 'joystick' || _qs.get('nav') === 'buttons' ||
  (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
// The guided tour only applies to the room-based gallery (not legacy carousel).
const USE_TOUR = NAV_TOUR && MODE === 'gallery';
const initialDPR = parseFloat(_qs.get('dpr')) || 1;
const initialAA  = _qs.get('aa') !== 'false';

function setOverlayStatus(msg, kind) {
  overlayStatus.textContent = msg;
  overlayStatus.classList.toggle('notice', kind === 'notice');
  overlayStatus.classList.toggle('error',  kind === 'error');
}

// On touch, go fullscreen to drop the browser chrome (URL/status bars). Must be
// called from a user gesture (the engage tap). No-ops where unsupported — e.g.
// iPhone Safari has no element fullscreen, so there it's "Add to Home Screen".
function requestFullscreenOnMobile() {
  if (!matchMedia('(pointer: coarse)').matches) return;
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  try { req?.call(el)?.catch?.(() => {}); } catch {}
}

// ============================================================
// Scene setup
// ============================================================
async function init({ items, paginator }) {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 200);
  // Radians of camera rotation per pixel dragged, matched to the projection so
  // the point under the finger stays put (exact at screen centre). Recomputed
  // on resize/orientation change. Square pixels → same value for x and y.
  let lookSens = 0.003;
  const computeLookSens = () => {
    lookSens = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) / Math.min(innerWidth, innerHeight);
  };
  computeLookSens();
  const renderer = new THREE.WebGPURenderer({ antialias: initialAA });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(initialDPR);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  // WebGPU backend init must complete before PMREM, postprocessing, etc.
  await renderer.init();
  setMaxAniso(16);

  // ---- Post-processing pipeline (TSL / WebGPU) ----
  // Single render pass with MRT (color + normal); GTAO + denoise composited
  // in TSL. The aoEnabled uniform toggles AO contribution at zero cost when off.
  const aoEnabled = uniform(1);

  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output: output, normal: normalView }));
  const sceneColor  = scenePass.getTextureNode('output');
  const sceneNormal = scenePass.getTextureNode('normal');
  const sceneDepth  = scenePass.getTextureNode('depth');

  const aoPass = ao(sceneDepth, sceneNormal, camera);
  aoPass.resolutionScale  = 0.35;
  aoPass.distanceExponent.value = 0.7;
  aoPass.distanceFallOff.value  = 0.45;
  aoPass.radius.value     = 0.1;
  aoPass.scale.value      = 2.25;
  aoPass.thickness.value  = 1.4;

  const aoTexture = aoPass.getTextureNode();
  const denoisedAO = denoise(aoTexture, sceneDepth, sceneNormal, camera).r;
  const softenedAO = denoisedAO.pow(0.5);
  const composited = mix(sceneColor, sceneColor.mul(softenedAO), aoEnabled);

  // Vignette: smoothstep on distance from screen centre (max ≈0.707 in the
  // corners), multiplied by VIGNETTE_STRENGTH so the corners only darken
  // to (1 − strength).
  const VIGNETTE_INNER    = 0.45;
  const VIGNETTE_OUTER    = 0.75;
  const VIGNETTE_STRENGTH = 0.45;
  const vignette = smoothstep(VIGNETTE_INNER, VIGNETTE_OUTER,
    screenUV.distance(vec2(0.5, 0.5))
  ).mul(VIGNETTE_STRENGTH);

  const postProcessing = new THREE.RenderPipeline(renderer);
  postProcessing.outputNode = composited.mul(vignette.oneMinus());

  // ---- IBL environment ----
  // PMREMGenerator stays alive so we can process HDRs on demand when the
  // user picks one from the GUI in dev mode. Production only ever uses the
  // default Studio Small env, so we skip the cache + extra options there.
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const hdrLoader = new HDRLoader();
  const envCache = DEV_MODE ? new Map() : null;

  const ENV_OPTIONS = DEV_MODE ? {
    'Procedural Room':       'procedural',
    'Debris Basement':       `${ASSET_BASE}hdr/debris_basement_corridor_1k.hdr`,
    'Solitude Interior':     `${ASSET_BASE}hdr/solitude_interior_1k.hdr`,
    'Photo Studio':          `${ASSET_BASE}hdr/photo_studio_01_1k.hdr`,
    'Studio Small (1k)':     `${ASSET_BASE}hdr/studio_small_08_1k.hdr`,
    'Studio Small (2k)':     `${ASSET_BASE}hdr/studio_small_08_2k.hdr`,
  } : null;
  function applyEnv(key) {
    if (envCache?.has(key)) {
      scene.environment = envCache.get(key);
      return Promise.resolve();
    }
    if (key === 'procedural') {
      const tex = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      envCache?.set(key, tex);
      scene.environment = tex;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      hdrLoader.load(key, (hdr) => {
        const tex = pmremGenerator.fromEquirectangular(hdr).texture;
        hdr.dispose();
        envCache?.set(key, tex);
        scene.environment = tex;
        resolve();
      }, undefined, reject);
    });
  }

  // Wait for all heavy assets — env, PBR sets, GLBs — before building the
  // scene so the user doesn't get dumped into a half-textured gallery.
  const DEFAULT_ENV = `${ASSET_BASE}hdr/studio_small_08_1k.hdr`;
  const [, wallTex, floorTex] = await Promise.all([
    applyEnv(DEFAULT_ENV),
    loadPBRSet(`${ASSET_BASE}textures/plastered_wall_04_1k/textures/plastered_wall_04`, 1),
    loadPBRSet(`${ASSET_BASE}textures/concrete_floor_worn_001_1k/textures/concrete_floor_worn_001`, 1),
    loadPeopleTemplates().catch((e) => console.warn('People GLB load failed:', e)),
  ]);

  const built = MODE === 'carousel'
    ? buildCarousel(scene, items)
    : createGalleryManager(scene, paginator, items, (n, exhausted) => {
        countEl.textContent = exhausted ? `${n}` : `${n}+`;
      }, { wallTex, floorTex });
  const ambient = built.ambient || null;
  camera.position.copy(built.startPos);
  // Face -Z by default (looking into the gallery / into the carousel center)
  if (MODE === 'gallery') camera.lookAt(-3, 1.6, built.startPos.z);

  const toggles = {
    gtao:  true,
    sound: true,
    video: true,
  };

  if (MODE === 'gallery') {
    aoEnabled.value = toggles.gtao ? 1 : 0;
    if (DEV_MODE) buildDevGui({
      gui: new GUI({ title: 'Render' }),
      renderer, scene, ambient, aoPass, aoEnabled, applyEnv,
      toggles, ENV_OPTIONS, DEFAULT_ENV,
    });
  }

  // ---- Audio: ambience + footsteps ----
  // Ambience loop + footsteps when moving, both gated on the sound toggle.
  // A `lockGain` lerps with the pointer-lock state and is multiplied into
  // every audio source's volume so everything fades together on Esc / lock.
  const ambienceAudio = new Audio(`${ASSET_BASE}sfx/ambience.mp3`);
  ambienceAudio.loop = true;
  ambienceAudio.volume = 0;
  const AMBIENCE_TARGET_VOL = 0.25;
  const footstepsAudio = new Audio(`${ASSET_BASE}sfx/footsteps.mp3`);
  footstepsAudio.loop = true;
  footstepsAudio.volume = 0;
  const FOOTSTEPS_TARGET_VOL = 0.5;
  const FOOTSTEPS_FADE_RATE  = 10;     // ~100ms ramp
  const LOCK_FADE_RATE       = 4;      // ~250ms ramp
  let lockGain = 0;
  // Per-video volume falloff: 1 m → silent at 5 m. Behind-plane → mute.
  const AUDIO_FULL_DIST   = 1;
  const AUDIO_SILENT_DIST = 5;
  const _videoWorldPos = new THREE.Vector3();
  const _videoForward  = new THREE.Vector3();

  // Mute everything while the tab is hidden. The render loop (and the audio
  // update it drives) is paused by the browser when backgrounded, so we can't
  // rely on it — handle it directly on visibilitychange, which still fires.
  // On re-show, the resumed loop's updateAudio restores volumes.
  let tabHidden = document.hidden;
  function muteForHidden() {
    if (!ambienceAudio.paused) ambienceAudio.pause();
    if (!footstepsAudio.paused) footstepsAudio.pause();
    for (const { video } of galleryVideos) if (!video.muted) video.muted = true;
  }
  document.addEventListener('visibilitychange', () => {
    tabHidden = document.hidden;
    if (tabHidden) muteForHidden();
  });

  // ---- Pointer-lock + overlay fade ----
  const controls = new PointerLockControls(camera, renderer.domElement);

  // ---- Mobile guided tour (approach #3: drag-to-look + tap-to-walk) ----
  // On touch (or ?nav=joystick) we skip pointer-lock entirely: tapping enters,
  // dragging anywhere rotates the view (orbit-style), and a tap on a picture
  // walks the camera to it.
  const tour = createTour({ camera, built });
  // Debug handle for the forced-tour test path (?nav=…) and dev mode; not
  // exposed to ordinary touch sessions.
  if (DEV_MODE || _qs.get('nav')) window.__dbg = { tour, camera, built };
  let tourEntered = false;
  function fadeOverlayOut() {
    overlayEl.style.setProperty('--overlay-bg-opacity', '0');
    overlayEl.style.setProperty('--overlay-content-opacity', '0');
    setTimeout(() => { overlayEl.hidden = true; }, 350);
  }
  function enterTour() {
    if (tourEntered) return;
    tourEntered = true;
    requestFullscreenOnMobile();
    fadeOverlayOut();
    tapHintEl.hidden = true;
    if (USE_TOUR) mobileExitEl.hidden = false;
    if (toggles.sound) ambienceAudio.play().catch(() => {});
    tour.enter(); // frame the nearest piece so there's an initial subject
  }

  mobileExitEl.addEventListener('click', () => {
    try { document.exitFullscreen?.() ?? document.webkitExitFullscreen?.(); } catch {}
  });

  // Tap a picture → walk to it. Raycast from the tap point; a placard hit
  // resolves to its parent artwork. Ignored mid-walk so taps don't queue.
  const _selectRay = new THREE.Raycaster();
  const _selectNdc = new THREE.Vector2();
  function selectAt(clientX, clientY) {
    if (tour.active) return;
    _selectNdc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    _selectRay.setFromCamera(_selectNdc, camera);
    const hits = _selectRay.intersectObjects(built.planes, false);
    if (!hits.length) return;
    const obj = hits[0].object;
    if (obj.userData.isPlacard) {
      if (tour.parkedLevel === 'placard' && obj.parent === tour.parkedMesh) {
        tour.zoomTo(tour.parkedMesh, 'near');
      } else {
        tour.goToPlacard(obj);
      }
      return;
    }
    if (!obj.userData.faceNormal) return;
    if (tour.parkedMesh === obj) {
      // Already in front of this artwork — toggle near ↔ close.
      tour.zoomTo(obj, tour.parkedLevel === 'near' ? 'close' : 'near');
    } else {
      tour.goToMesh(obj);
    }
  }

  // Drag anywhere to look (yaw free, pitch clamped); a tap that didn't drag
  // is a select. We track yaw/pitch as a YXZ euler so there's no roll and
  // pitch can be clamped; it's re-seeded from the camera at each drag start so
  // it composes correctly after a glide reorients the camera.
  const _lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  let dragPid = null, dragMoved = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
  function onLookDown(e) {
    if (!tourEntered) { enterTour(); return; }
    dragPid = e.pointerId; dragMoved = false;
    downX = lastX = e.clientX; downY = lastY = e.clientY;
    _lookEuler.setFromQuaternion(camera.quaternion, 'YXZ');
  }
  function onLookMove(e) {
    if (e.pointerId !== dragPid) return;
    if (!dragMoved && Math.hypot(e.clientX - downX, e.clientY - downY) > LOOK_DRAG_THRESH) {
      dragMoved = true;
    }
    if (dragMoved && !tour.active) {
      // Content-follows-finger (orbit-style): drag right → view turns left,
      // drag down → look up.
      _lookEuler.y += (e.clientX - lastX) * lookSens;
      _lookEuler.x = Math.max(-LOOK_MAX_PITCH, Math.min(LOOK_MAX_PITCH,
        _lookEuler.x + (e.clientY - lastY) * lookSens));
      camera.quaternion.setFromEuler(_lookEuler);
    }
    lastX = e.clientX; lastY = e.clientY;
  }
  function onLookUp(e) {
    if (e.pointerId !== dragPid) return;
    dragPid = null;
    if (!dragMoved) selectAt(e.clientX, e.clientY); // tap, not a drag → walk
  }

  if (USE_TOUR) {
    engagePrompt.addEventListener('click', enterTour);
    renderer.domElement.addEventListener('pointerdown', onLookDown);
    window.addEventListener('pointermove', onLookMove, { passive: true });
    window.addEventListener('pointerup', onLookUp);
    window.addEventListener('pointercancel', () => { dragPid = null; });
  } else {
    // Desktop: engage prompt locks; clicks on the form/input do not. Backdrop
    // and panel content fade together. On unlock (Esc) the backdrop settles at
    // 0.7 dim while the content goes back to full opacity so the click-to-
    // enter prompt is fully readable over the dim gallery.
    engagePrompt.addEventListener('click', () => controls.lock());
    controls.addEventListener('lock', () => {
      fadeOverlayOut();
      if (toggles.sound) ambienceAudio.play().catch(() => {});
    });
    controls.addEventListener('unlock', () => {
      overlayEl.hidden = false;
      requestAnimationFrame(() => {
        overlayEl.style.setProperty('--overlay-bg-opacity', '0.7');
        overlayEl.style.setProperty('--overlay-content-opacity', '1');
      });
    });
    renderer.domElement.addEventListener('click', () => {
      if (!controls.isLocked) controls.lock();
    });
  }

  // ---- Keyboard ----
  const keys = { w: false, a: false, s: false, d: false, shift: false };
  const keyMap = {
    KeyW: 'w', ArrowUp:    'w',
    KeyS: 's', ArrowDown:  's',
    KeyA: 'a', ArrowLeft:  'a',
    KeyD: 'd', ArrowRight: 'd',
    ShiftLeft: 'shift', ShiftRight: 'shift',
  };
  document.addEventListener('keydown', (e) => { if (keyMap[e.code]) keys[keyMap[e.code]] = true;  });
  document.addEventListener('keyup',   (e) => { if (keyMap[e.code]) keys[keyMap[e.code]] = false; });

  // ---- Click → open post (placard only) ----
  const raycaster = new THREE.Raycaster();
  const screenCenter = new THREE.Vector2(0, 0);
  renderer.domElement.addEventListener('mousedown', () => {
    if (!controls.isLocked) return;
    raycaster.setFromCamera(screenCenter, camera);
    const hits = raycaster.intersectObjects(built.planes, false);
    if (!hits.length) return;
    const plane = hits[0].object;
    // Only the placard label opens the post; clicking the main image does
    // nothing so people can frame screenshots without an accidental tab.
    if (!plane.userData.isPlacard) return;
    const item = plane.userData.item;
    if (item?.postUrl) window.open(item.postUrl, '_blank', 'noopener');
  });

  // ---- Stats (dev only) ----
  let stats = null;
  if (DEV_MODE) {
    stats = new Stats();
    stats.dom.style.cssText = 'position:fixed;top:0;left:0;z-index:1000;';
    document.body.appendChild(stats.dom);
  }

  // ---- Animate loop ----
  const timer = new Timer();
  // Cap render to 60fps on high-refresh-rate displays. Browsers RAF at the
  // display's native rate (often 120Hz) which makes any frame variance feel
  // jerky; a fixed 60Hz target keeps pacing consistent.
  const TARGET_FRAME_MS = 1000 / 60;
  let lastFrameMs = 0;
  function animate(now) {
    requestAnimationFrame(animate);
    if (now - lastFrameMs < TARGET_FRAME_MS - 0.5) return;
    lastFrameMs = now;
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);

    // Movement: mobile tour drives the camera itself; desktop uses WASD.
    if (USE_TOUR) {
      // While walking, the glide owns the camera; when parked, drag-look (handled
      // in the pointer events) owns it.
      if (tourEntered && tour.active) tour.update(dt);
    } else if (controls.isLocked) {
      const speed = MOVE_SPEED * (keys.shift ? SPRINT_MULT : 1) * dt;
      if (keys.w) controls.moveForward(speed);
      if (keys.s) controls.moveForward(-speed);
      if (keys.a) controls.moveRight(-speed);
      if (keys.d) controls.moveRight(speed);
      if (MODE === 'gallery' && !USE_TOUR) built.collide?.(camera.position, 0.3);
    }
    if (MODE === 'gallery') {
      built.update?.(dt, camera);
    }

    // Lock-gain lerp drives ambience + video audio fade in/out together.
    // Footsteps cut by themselves because `moving` requires being "entered".
    const lockTarget = (USE_TOUR ? tourEntered : controls.isLocked) ? 1 : 0;
    lockGain += (lockTarget - lockGain) * Math.min(1, dt * LOCK_FADE_RATE);
    updateAudio(dt);

    postProcessing.render();
    stats?.update();
  }
  animate(0);

  // Audio update extracted for readability — runs every frame.
  function updateAudio(dt) {
    if (tabHidden) { muteForHidden(); return; }
    const moving = USE_TOUR
      ? (tourEntered && tour.walking)
      : (controls.isLocked && (keys.w || keys.s || keys.a || keys.d));
    if (toggles.sound) {
      ambienceAudio.volume = AMBIENCE_TARGET_VOL * lockGain;
      if (lockGain > 0.005) {
        if (ambienceAudio.paused) ambienceAudio.play().catch(() => {});
      } else if (!ambienceAudio.paused) {
        ambienceAudio.pause();
      }
      const fsTarget = moving ? FOOTSTEPS_TARGET_VOL : 0;
      const k = Math.min(1, dt * FOOTSTEPS_FADE_RATE);
      footstepsAudio.volume += (fsTarget - footstepsAudio.volume) * k;
      if (footstepsAudio.volume > 0.01) {
        if (footstepsAudio.paused) footstepsAudio.play().catch(() => {});
      } else if (!footstepsAudio.paused) {
        footstepsAudio.pause();
      }
    } else {
      ambienceAudio.volume = 0;
      footstepsAudio.volume = 0;
      if (!ambienceAudio.paused) ambienceAudio.pause();
      if (!footstepsAudio.paused) footstepsAudio.pause();
    }

    // Per-video state: current room → playing + audio. Adjacent rooms →
    // playing + muted (so HLS stays warm and re-entry is instant). Rooms
    // 2+ slots away → fully paused (HLS decode is the biggest CPU cost
    // and we won't see them anyway).
    if (!galleryVideos.length) return;
    const currentGroup = MODE === 'gallery' ? built.currentGroup : null;
    const activeGroups = MODE === 'gallery' ? built.activeGroups : null;
    for (const { video, mesh } of galleryVideos) {
      const inActive  = MODE !== 'gallery' || activeGroups.has(mesh.parent);
      const inCurrent = MODE !== 'gallery' || mesh.parent === currentGroup;

      if (!toggles.video || !inActive) {
        if (!video.paused) video.pause();
        if (!video.muted)  video.muted = true;
        continue;
      }
      if (video.paused || video.ended) {
        // HLS via MSE doesn't always honour `loop=true` — when the stream
        // ends the player can sit on its last frame even though we want
        // it to restart. Detect that and seek to 0. Otherwise (long pause
        // resume), nudge currentTime to force hls.js to flush stale buffer.
        if (video.ended ||
            (video.duration && video.currentTime >= video.duration - 0.05)) {
          video.currentTime = 0;
        } else if (video.currentTime > 0) {
          video.currentTime = video.currentTime;
        }
        video.play().catch(() => {});
      }

      if (!inCurrent || !toggles.sound) {
        if (!video.muted) video.muted = true;
        continue;
      }
      mesh.getWorldPosition(_videoWorldPos);
      // Mute when the camera is behind the plane (audio can otherwise leak
      // through partition walls).
      mesh.getWorldDirection(_videoForward);
      const fx = camera.position.x - _videoWorldPos.x;
      const fz = camera.position.z - _videoWorldPos.z;
      const inFront = (_videoForward.x * fx + _videoForward.z * fz) > 0;
      const d = camera.position.distanceTo(_videoWorldPos);
      const baseVol = !inFront ? 0 : Math.max(0, Math.min(1,
        1 - (d - AUDIO_FULL_DIST) / (AUDIO_SILENT_DIST - AUDIO_FULL_DIST)
      ));
      const vol = baseVol * lockGain;
      if (vol > 0.005) {
        if (video.muted) video.muted = false;
        video.volume = vol;
      } else if (!video.muted) {
        video.muted = true;
      }
    }
  }

  // ---- Resize ----
  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    computeLookSens(); // viewport height changed → re-match drag sensitivity
  });
}

// Dev-only render GUI. Exposed knobs: DPR, AA, GTAO, sound,
// video, ambient, environment + intensity, GTAO sub-folder.
function buildDevGui({ gui, renderer, scene, ambient, aoPass, aoEnabled,
                       applyEnv, toggles, ENV_OPTIONS, DEFAULT_ENV }) {
  const renderSettings = { dpr: initialDPR, aa: initialAA };
  gui.add(renderSettings, 'dpr', 0.5, 2, 0.25).name('DPR')
    .onChange((v) => renderer.setPixelRatio(v));
  gui.add(renderSettings, 'aa').name('Antialias (reloads)')
    .onChange((v) => {
      const url = new URL(window.location);
      url.searchParams.set('aa', v ? 'true' : 'false');
      window.location.assign(url.toString());
    });

  gui.add(toggles, 'gtao').name('GTAO')
    .onChange((v) => { aoEnabled.value = v ? 1 : 0; });
  gui.add(toggles, 'sound').name('Sound');
  gui.add(toggles, 'video').name('Video Playback');

  if (ambient) gui.add(ambient, 'intensity', 0, 5, 0.05).name('Ambient');
  const envSelect = { current: DEFAULT_ENV };
  gui.add(envSelect, 'current', ENV_OPTIONS).name('Environment').onChange(applyEnv);
  gui.add(scene, 'environmentIntensity', 0, 3, 0.05).name('Env Intensity');

  const aoFolder = gui.addFolder('GTAO');
  aoFolder.add(aoPass.radius,            'value', 0.1, 4,    0.05).name('Radius');
  aoFolder.add(aoPass.scale,             'value', 0,   5,    0.05).name('Scale');
  aoFolder.add(aoPass.thickness,         'value', 0,   3,    0.05).name('Thickness');
  aoFolder.add(aoPass.distanceExponent,  'value', 0.1, 5,    0.05).name('Distance Exp');
  aoFolder.add(aoPass.distanceFallOff,   'value', 0,   1,    0.01).name('Distance Falloff');
  aoFolder.add(aoPass, 'resolutionScale', 0.25, 1, 0.25).name('Resolution Scale');
}

// ============================================================
// Boot / handle handling
// ============================================================
let sceneLoaded = false;

// Shareable-URL helpers. The location supports three params:
//   ?handle=<actor>            — bare bsky handle (or full profile URL)
//   ?list=<handle>/<rkey>      — bsky list (shorter than the bsky.app URL)
//   ?feed=<handle>/<rkey>      — bsky feed
// We pick the right one based on parseSource's output and clear the others.
function urlForParsed(parsed, original) {
  const url = new URL(window.location);
  url.searchParams.delete('handle');
  url.searchParams.delete('list');
  url.searchParams.delete('feed');
  if ((parsed.type === 'list' || parsed.type === 'feed')
      && parsed.handle && parsed.rkey) {
    url.searchParams.set(parsed.type, `${parsed.handle}/${parsed.rkey}`);
  } else if (parsed.type === 'handle') {
    url.searchParams.set('handle', parsed.actor);
  } else {
    // AT-URI for a list/feed without a known handle — keep the original.
    url.searchParams.set('handle', original);
  }
  return url;
}

// Read whichever of (?list / ?feed / ?handle) is set and return a string
// suitable for the input field + parseSource. Lists/feeds expand back to
// the bsky.app URL form so the input is human-readable.
function readBootInput() {
  const qs = new URL(window.location).searchParams;
  for (const kind of ['list', 'feed']) {
    const v = qs.get(kind);
    if (!v) continue;
    const m = v.match(/^([^/]+)\/(.+)$/);
    if (m) return `https://bsky.app/profile/${m[1]}/${kind === 'list' ? 'lists' : 'feed'}/${m[2]}`;
  }
  return qs.get('handle') || DEFAULT_BOOT_INPUT;
}

async function loadFor(input, { pushUrl = true } = {}) {
  if (!input) return;
  const parsed = parseSource(input);
  if (sceneLoaded) {
    // Scene is one-shot; reload the page so a fresh source gets a fresh scene.
    window.location.assign(urlForParsed(parsed, input).toString());
    return;
  }
  if (pushUrl) {
    history.replaceState({}, '', urlForParsed(parsed, input));
  }

  const label = parsed.type === 'handle'
    ? `@${parsed.actor}`
    : `${parsed.type}: ${parsed.handle ? parsed.handle + '/' + parsed.rkey : parsed.uri}`;
  setOverlayStatus(`Loading ${label}…`);

  const goBtn = form.querySelector('button');
  goBtn.disabled = true;
  try {
    const source = await resolveSource(parsed);
    const minCount = MODE === 'carousel' ? CAROUSEL_INITIAL_COUNT : GALLERY_INITIAL_COUNT;
    const includeReposts = repostsToggle.checked;
    const { paginator, items } = await fetchInitialMedia(source, minCount, { includeReposts });
    if (items.length === 0 && paginator.isExhausted) {
      setOverlayStatus('No media found.', 'notice');
      return;
    }
    countEl.textContent = paginator.isExhausted ? `${items.length}` : `${items.length}+`;
    setOverlayStatus('Building scene…');
    await init({ items, paginator });
    sceneLoaded = true;

    // Swap modal content from form → engage prompt: hide the title and
    // input so only the CTA + hint show.
    overlayEl.querySelector('h1')?.setAttribute('hidden', '');
    form.hidden = true;
    if (repostsRow) repostsRow.hidden = true;
    setOverlayStatus('');
    overlayEl.classList.add('engage-mode');
    // Mobile tour gets its own CTA copy; the reticle + ESC hint are
    // desktop-only (pointer-lock concepts that don't apply on touch).
    if (USE_TOUR) {
      const cta  = engagePrompt.querySelector('.cta');
      const hint = engagePrompt.querySelector('.hint');
      if (cta)  cta.textContent  = 'Tap to Enter';
      if (hint) hint.textContent = 'Tap a picture to walk to it · drag to look around';
    }
    // Reveal the engage prompt with a fade-in: start at opacity 0, then
    // bump to 1 next frame so the CSS transition runs.
    engagePrompt.style.opacity = '0';
    engagePrompt.hidden = false;
    requestAnimationFrame(() => { engagePrompt.style.opacity = '1'; });
    fetchSourceName(parsed).then((name) => {
      const el = document.getElementById('gallery-name');
      if (el && name) {
        const titled = name.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
        el.textContent = `${titled} Gallery`;
      }
    });
    infoEl.hidden = false;
    if (!USE_TOUR) {
      escHintEl.hidden = false;
      reticleEl.hidden = false;
    }
  } catch (err) {
    if (err.message === 'PROFILE_NOT_FOUND') {
      setOverlayStatus('Bluesky profile not found', 'notice');
    } else {
      console.error(err);
      setOverlayStatus(`Error: ${err.message}`, 'error');
    }
  } finally {
    goBtn.disabled = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = handleInput.value.trim() || handleInput.placeholder;
  const parsed = parseSource(raw);
  if (parsed.type === 'handle') handleInput.value = parsed.actor;
  loadFor(raw);
});

// On first load, honor ?list=… / ?feed=… / ?handle=… so links are shareable.
// We pre-fill the input but don't auto-load — user clicks Go to start.
(() => {
  const initial = readBootInput();
  const qs = new URL(window.location).searchParams;
  const fromUrl = qs.has('handle') || qs.has('list') || qs.has('feed');
  if (initial) {
    if (fromUrl) handleInput.value = initial;
    else handleInput.placeholder = initial;
  }
  handleInput.focus();
  // Fade the panel (title + form) in. CSS default is opacity 0 so the form
  // doesn't flash before this kicks the transition.
  requestAnimationFrame(() => {
    overlayEl.style.setProperty('--overlay-content-opacity', '1');
  });
})();
