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
  parseSource, resolveSource, fetchInitialMedia,
} from './src/bsky-feed.js';
import { setMaxAniso, loadPBRSet, galleryVideos } from './src/textures.js';
import { loadPeopleTemplates } from './src/people.js';
import { createGalleryManager } from './src/gallery-manager.js';
import { buildCarousel } from './src/carousel.js';

// ---- Config ----
const MOVE_SPEED  = 4;
const SPRINT_MULT = 2.5;
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

const ASSET_BASE = import.meta.env.BASE_URL; // '/' in dev, '/bsky-gallery/3d/' in prod
const MODE = (new URL(window.location).searchParams.get('mode') || 'gallery');
const DEV_MODE = new URL(window.location).searchParams.get('dev') === 'true';

const _qs = new URL(window.location).searchParams;
const initialDPR = parseFloat(_qs.get('dpr')) || 1;
const initialAA  = _qs.get('aa') !== 'false';

function setOverlayStatus(msg, kind) {
  overlayStatus.textContent = msg;
  overlayStatus.classList.toggle('notice', kind === 'notice');
  overlayStatus.classList.toggle('error',  kind === 'error');
}

// ============================================================
// Scene setup
// ============================================================
async function init({ items, paginator }) {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 200);
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
  // user picks one from the GUI. Each environment is cached after first compute.
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const hdrLoader = new HDRLoader();
  const envCache = new Map();

  const ENV_OPTIONS = {
    'Procedural Room':    'procedural',
    'Solitude Interior':  `${ASSET_BASE}hdr/solitude_interior_1k.hdr`,
    'Photo Studio':       `${ASSET_BASE}hdr/photo_studio_01_1k.hdr`,
    'Studio Small (1k)':  `${ASSET_BASE}hdr/studio_small_08_1k.hdr`,
    'Studio Small (2k)':  `${ASSET_BASE}hdr/studio_small_08_2k.hdr`,
  };
  function applyEnv(key) {
    if (envCache.has(key)) {
      scene.environment = envCache.get(key);
      return Promise.resolve();
    }
    if (key === 'procedural') {
      const tex = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      envCache.set(key, tex);
      scene.environment = tex;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      hdrLoader.load(key, (hdr) => {
        const tex = pmremGenerator.fromEquirectangular(hdr).texture;
        hdr.dispose();
        envCache.set(key, tex);
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
  if (MODE === 'gallery') camera.lookAt(-3, 1.6, -20);

  // ---- Spotlight pool (gallery mode only) ----
  // Forward-renderer is unhappy with many lights, so we keep a fixed-size
  // pool of SpotLights and retarget them each frame to the nearest visible
  // artworks.
  const lightSettings = { maxLights: 6, intensity: 12 };
  const toggles = {
    spotlights: false,
    gtao:       true,
    sound:      true,
    video:      true,
  };
  const lightPool = [];
  function rebuildPool(size) {
    for (const l of lightPool) {
      scene.remove(l);
      scene.remove(l.target);
      l.dispose();
    }
    lightPool.length = 0;
    for (let i = 0; i < size; i++) {
      const l = new THREE.SpotLight(0xffffff, 0, 8, Math.PI / 7, 0.4, 1.6);
      scene.add(l);
      scene.add(l.target);
      lightPool.push(l);
    }
  }

  if (MODE === 'gallery') {
    if (toggles.spotlights) rebuildPool(lightSettings.maxLights);
    aoEnabled.value = toggles.gtao ? 1 : 0;
    if (DEV_MODE) buildDevGui({
      gui: new GUI({ title: 'Render' }),
      renderer, scene, ambient, aoPass, aoEnabled, applyEnv,
      toggles, lightSettings, ENV_OPTIONS, DEFAULT_ENV, rebuildPool,
    });
  }

  // ---- Spotlight assignment + intensity lerp ----
  const LIGHT_LERP_RATE = 8;       // ~125ms fade in/out
  function updateLightPool(dt) {
    if (lightPool.length === 0) return;
    // Gallery mode: only artworks in the room the player is currently in
    // are spotlight candidates. Carousel: use the full set.
    const candidates = MODE === 'gallery'
      ? built.currentArtworks
      : (built.artworks || []);
    // Proximity-only: nearest N artworks get lights, regardless of camera
    // facing — avoids pop-in/out at frustum edges.
    const visible = candidates.slice().sort((a, b) =>
      a.position.distanceToSquared(camera.position) -
      b.position.distanceToSquared(camera.position)
    );
    const topVisible = new Set(visible.slice(0, lightPool.length));
    // Step 1: keep slots that are still on top, mark others for fade-out.
    const claimed = new Set();
    for (const slot of lightPool) {
      if (slot.userData.artwork && topVisible.has(slot.userData.artwork)) {
        claimed.add(slot.userData.artwork);
        slot.userData.targetIntensity = lightSettings.intensity;
      } else {
        slot.userData.targetIntensity = 0;
      }
    }
    // Step 2: release slots whose intensity has fully decayed.
    for (const slot of lightPool) {
      if (slot.userData.targetIntensity === 0 && slot.intensity < 0.02) {
        slot.userData.artwork = null;
      }
    }
    // Step 3: assign newly-visible artworks to free slots.
    const pendingAssign = [...topVisible].filter((a) => !claimed.has(a));
    for (const slot of lightPool) {
      if (pendingAssign.length === 0) break;
      if (!slot.userData.artwork) {
        const a = pendingAssign.shift();
        slot.userData.artwork = a;
        slot.position.copy(a.userData.lightAnchor);
        slot.target.position.copy(a.userData.lightTarget);
        slot.target.updateMatrixWorld();
        slot.angle    = a.userData.lightAngle;
        slot.distance = a.userData.lightDistance;
        slot.userData.targetIntensity = lightSettings.intensity;
        slot.intensity = 0; // start at 0, lerp up
      }
    }
    // Step 4: smoothly lerp every slot's intensity toward its target.
    const k = Math.min(1, dt * LIGHT_LERP_RATE);
    for (const slot of lightPool) {
      const target = slot.userData.targetIntensity ?? 0;
      slot.intensity += (target - slot.intensity) * k;
    }
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

  // ---- Pointer-lock + overlay fade ----
  const controls = new PointerLockControls(camera, renderer.domElement);
  // Engage prompt locks; clicks on the form/input do not. Backdrop and
  // panel content fade together. On unlock (Esc) the backdrop settles at
  // 0.7 dim while the content goes back to full opacity so the click-to-
  // enter prompt is fully readable over the dim gallery.
  engagePrompt.addEventListener('click', () => controls.lock());
  controls.addEventListener('lock', () => {
    overlayEl.style.setProperty('--overlay-bg-opacity', '0');
    overlayEl.style.setProperty('--overlay-content-opacity', '0');
    setTimeout(() => { overlayEl.hidden = true; }, 350);
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

    // Movement
    if (controls.isLocked) {
      const speed = MOVE_SPEED * (keys.shift ? SPRINT_MULT : 1) * dt;
      if (keys.w) controls.moveForward(speed);
      if (keys.s) controls.moveForward(-speed);
      if (keys.a) controls.moveRight(-speed);
      if (keys.d) controls.moveRight(speed);
      if (MODE === 'gallery') built.collide?.(camera.position, 0.3);
    }
    if (MODE === 'gallery') {
      built.update?.(dt, camera);
      updateLightPool(dt);
    }

    // Lock-gain lerp drives ambience + video audio fade in/out together.
    // Footsteps cut by themselves because `moving` requires lock.
    const lockTarget = controls.isLocked ? 1 : 0;
    lockGain += (lockTarget - lockGain) * Math.min(1, dt * LOCK_FADE_RATE);
    updateAudio(dt);

    postProcessing.render();
    stats?.update();
  }
  animate(0);

  // Audio update extracted for readability — runs every frame.
  function updateAudio(dt) {
    const moving = controls.isLocked && (keys.w || keys.s || keys.a || keys.d);
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
      if (video.paused) video.play().catch(() => {});

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
  });
}

// Dev-only render GUI. Exposed knobs: DPR, AA, spotlights, GTAO, sound,
// video, ambient, environment + intensity, GTAO sub-folder.
function buildDevGui({ gui, renderer, scene, ambient, aoPass, aoEnabled,
                       applyEnv, toggles, lightSettings, ENV_OPTIONS,
                       DEFAULT_ENV, rebuildPool }) {
  const renderSettings = { dpr: initialDPR, aa: initialAA };
  gui.add(renderSettings, 'dpr', 0.5, 2, 0.25).name('DPR')
    .onChange((v) => renderer.setPixelRatio(v));
  gui.add(renderSettings, 'aa').name('Antialias (reloads)')
    .onChange((v) => {
      const url = new URL(window.location);
      url.searchParams.set('aa', v ? 'true' : 'false');
      window.location.assign(url.toString());
    });

  gui.add(toggles, 'spotlights').name('Spotlights')
    .onChange((v) => rebuildPool(v ? lightSettings.maxLights : 0));
  gui.add(toggles, 'gtao').name('GTAO')
    .onChange((v) => { aoEnabled.value = v ? 1 : 0; });
  gui.add(toggles, 'sound').name('Sound');
  gui.add(toggles, 'video').name('Video Playback');

  gui.add(lightSettings, 'maxLights', 0, 50, 1).name('Max Spotlights')
    .onFinishChange((v) => { if (toggles.spotlights) rebuildPool(v); });
  gui.add(lightSettings, 'intensity', 0, 50, 0.5).name('Spotlight Intensity');

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

async function loadFor(input, { pushUrl = true } = {}) {
  if (!input) return;
  if (sceneLoaded) {
    // Scene is one-shot; reload the page so a fresh source gets a fresh scene.
    const url = new URL(window.location);
    url.searchParams.set('handle', input);
    window.location.assign(url.toString());
    return;
  }
  if (pushUrl) {
    const url = new URL(window.location);
    url.searchParams.set('handle', input);
    history.replaceState({ handle: input }, '', url);
  }

  const parsed = parseSource(input);
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
    // Reveal the engage prompt with a fade-in: start at opacity 0, then
    // bump to 1 next frame so the CSS transition runs.
    engagePrompt.style.opacity = '0';
    engagePrompt.hidden = false;
    requestAnimationFrame(() => { engagePrompt.style.opacity = '1'; });
    infoEl.hidden = false;
    escHintEl.hidden = false;
    reticleEl.hidden = false;
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
  const raw = handleInput.value.trim();
  if (!raw) return;
  const parsed = parseSource(raw);
  if (parsed.type === 'handle') handleInput.value = parsed.actor;
  loadFor(raw);
});

// On first load, honor ?handle=… so links are shareable (matches 2D).
// We pre-fill the input but don't auto-load — user clicks Go to start.
(() => {
  const initial = new URL(window.location).searchParams.get('handle');
  if (initial) handleInput.value = initial;
  handleInput.focus();
  // Fade the panel (title + form) in. CSS default is opacity 0 so the form
  // doesn't flash before this kicks the transition.
  requestAnimationFrame(() => {
    overlayEl.style.setProperty('--overlay-content-opacity', '1');
  });
})();
