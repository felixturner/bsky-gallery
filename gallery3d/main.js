import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import Hls from 'hls.js';
import gsap from 'gsap';

// ---- Config ----
const HANDLE = 'felixturner.bsky.social';
const MAX_ITEMS = 50;
const PLANE_WIDTH = 4;
const PLANE_GAP = 1.5;     // arc spacing factor
const MOVE_SPEED = 20;     // units per second
const SPRINT_MULT = 2.5;

// ---- DOM ----
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const overlayEl = document.getElementById('overlay');

// ---- URL proxying (dev only) ----
function proxyUrl(url) {
  if (!url) return url;
  return url
    .replace(/^https:\/\/cdn\.bsky\.app/, '/cdn-bsky')
    .replace(/^https:\/\/video\.bsky\.app/, '/video-bsky');
}

// ---- Bluesky fetch ----
async function fetchMedia() {
  const out = [];
  let cursor = null;

  while (out.length < MAX_ITEMS) {
    const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed');
    url.searchParams.set('actor', HANDLE);
    url.searchParams.set('limit', 100);
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    cursor = data.cursor || null;

    for (const fi of data.feed) {
      if (out.length >= MAX_ITEMS) break;
      const post = fi.post;
      let embed = post.embed;
      if (!embed) continue;
      if (embed.$type === 'app.bsky.embed.recordWithMedia#view') embed = embed.media;
      if (!embed) continue;

      if (embed.$type === 'app.bsky.embed.images#view') {
        for (const img of embed.images) {
          if (out.length >= MAX_ITEMS) break;
          out.push({
            type: 'image',
            thumb: proxyUrl(img.thumb),
            full: proxyUrl(img.fullsize),
            aspectRatio: img.aspectRatio,
          });
        }
      } else if (embed.$type === 'app.bsky.embed.video#view') {
        out.push({
          type: 'video',
          thumb: proxyUrl(embed.thumbnail),
          full: proxyUrl(embed.playlist),
          aspectRatio: embed.aspectRatio,
        });
      }
    }
    if (!cursor) break;
  }
  return out;
}

// ---- Texture loaders ----
const textureLoader = new THREE.TextureLoader();

function loadImageTexture(url) {
  return new Promise((resolve) => {
    textureLoader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        resolve(tex);
      },
      undefined,
      (err) => {
        console.warn('img load failed', url, err);
        resolve(null);
      }
    );
  });
}

function makeVideoTexture(playlistUrl) {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.autoplay = true;
  video.preload = 'auto';
  video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(video);

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = playlistUrl;
  } else if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(playlistUrl);
    hls.attachMedia(video);
  } else {
    video.src = playlistUrl;
  }
  video.play().catch(() => {});

  const tex = new THREE.VideoTexture(video);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

// ---- Scene setup ----
function init(items) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  const N = items.length;
  const RADIUS = (N * PLANE_WIDTH * PLANE_GAP) / (2 * Math.PI);

  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, RADIUS * 4);
  camera.position.set(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  // ---- Pointer lock controls (FPS-style mouse look) ----
  const controls = new PointerLockControls(camera, renderer.domElement);

  overlayEl.addEventListener('click', () => controls.lock());
  controls.addEventListener('lock', () => { overlayEl.hidden = true; });
  controls.addEventListener('unlock', () => { overlayEl.hidden = false; });

  // ---- WASD movement ----
  const keys = { w: false, a: false, s: false, d: false, shift: false };
  document.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    keys.w = true; break;
      case 'KeyA': case 'ArrowLeft':  keys.a = true; break;
      case 'KeyS': case 'ArrowDown':  keys.s = true; break;
      case 'KeyD': case 'ArrowRight': keys.d = true; break;
      case 'ShiftLeft': case 'ShiftRight': keys.shift = true; break;
    }
  });
  document.addEventListener('keyup', (e) => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    keys.w = false; break;
      case 'KeyA': case 'ArrowLeft':  keys.a = false; break;
      case 'KeyS': case 'ArrowDown':  keys.s = false; break;
      case 'KeyD': case 'ArrowRight': keys.d = false; break;
      case 'ShiftLeft': case 'ShiftRight': keys.shift = false; break;
    }
  });

  // ---- Build carousel ----
  const planes = [];
  for (let i = 0; i < N; i++) {
    const item = items[i];
    const angle = (i / N) * Math.PI * 2;

    const ar = item.aspectRatio
      ? item.aspectRatio.width / item.aspectRatio.height
      : 1;
    const w = PLANE_WIDTH;
    const h = w / ar;

    const geometry = new THREE.PlaneGeometry(w, h);
    const material = new THREE.MeshBasicMaterial({
      color: 0x222222,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(Math.cos(angle) * RADIUS, 0, Math.sin(angle) * RADIUS);
    mesh.lookAt(0, 0, 0);
    mesh.userData.item = item;
    mesh.userData.fullLoaded = false;
    scene.add(mesh);
    planes.push(mesh);

    const applyMap = (tex) => {
      material.map = tex;
      material.color.setHex(0xffffff);
      material.needsUpdate = true;
    };

    if (item.thumb) {
      loadImageTexture(item.thumb).then((tex) => { if (tex) applyMap(tex); });
    }

    if (item.type === 'video') {
      const vtex = makeVideoTexture(item.full);
      const video = vtex.image;
      const swap = () => applyMap(vtex);
      if (video.readyState >= 2) swap();
      else video.addEventListener('loadeddata', swap, { once: true });
    }
  }

  // ---- Click to upgrade hovered image to fullsize ----
  // While pointer is locked the cursor sits at screen-center; raycast from there.
  const raycaster = new THREE.Raycaster();
  const center = new THREE.Vector2(0, 0);

  renderer.domElement.addEventListener('mousedown', () => {
    if (!controls.isLocked) return;
    raycaster.setFromCamera(center, camera);
    const hits = raycaster.intersectObjects(planes, false);
    if (hits.length) {
      const plane = hits[0].object;
      const item = plane.userData.item;
      if (item.type === 'image' && !plane.userData.fullLoaded && item.full) {
        plane.userData.fullLoaded = true;
        loadImageTexture(item.full).then((tex) => {
          if (tex) {
            plane.material.map = tex;
            plane.material.needsUpdate = true;
          }
        });
      }
    }
  });

  // ---- Render loop ----
  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);

    if (controls.isLocked) {
      const speed = MOVE_SPEED * (keys.shift ? SPRINT_MULT : 1) * dt;
      if (keys.w) controls.moveForward(speed);
      if (keys.s) controls.moveForward(-speed);
      if (keys.a) controls.moveRight(-speed);
      if (keys.d) controls.moveRight(speed);
    }

    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

// ---- Boot ----
(async () => {
  try {
    statusEl.textContent = `Fetching @${HANDLE}…`;
    const items = await fetchMedia();
    countEl.textContent = items.length;
    statusEl.textContent = `Loading ${items.length} planes…`;
    init(items);
    setTimeout(() => { statusEl.hidden = true; }, 800);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    console.error(err);
  }
})();
