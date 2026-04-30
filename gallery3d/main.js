import * as THREE from 'three/webgpu';
import { mrt, output, normalView, pass, mix, uniform } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import Hls from 'hls.js';
import gsap from 'gsap';

// ---- Config ----
const MAX_ITEMS = 50;
const PLANE_WIDTH = 4;
const PLANE_GAP = 1.5;
const MOVE_SPEED = 4;
const SPRINT_MULT = 2.5;

// ---- DOM ----
const overlayEl    = document.getElementById('overlay');
const overlayStatus = document.getElementById('overlay-status');
const engagePrompt = document.getElementById('engage-prompt');
const form         = document.getElementById('form');
const handleInput  = document.getElementById('handle');
const countEl      = document.getElementById('count');
const infoEl       = document.getElementById('info');
const escHintEl    = document.getElementById('esc-hint');
const reticleEl    = document.getElementById('reticle');

// ---- URL proxying ----
// Dev: route through Vite's local proxy.
// Prod: route through a Cloudflare Worker that adds CORS headers to
// cdn.bsky.app + video.bsky.app responses. The Worker maps:
//   <WORKER>/cdn/...   → https://cdn.bsky.app/...
//   <WORKER>/video/... → https://video.bsky.app/...
// Relative URLs inside the HLS playlist resolve against the worker domain
// correctly, so video playback works end-to-end.
const IS_DEV = import.meta.env.DEV;
const CORS_WORKER = 'https://bsky-cors.felixturner.workers.dev';

function proxyUrl(url) {
  if (!url) return url;
  if (IS_DEV) {
    return url
      .replace(/^https:\/\/cdn\.bsky\.app/, '/cdn-bsky')
      .replace(/^https:\/\/video\.bsky\.app/, '/video-bsky');
  }
  return url
    .replace(/^https:\/\/cdn\.bsky\.app/,   `${CORS_WORKER}/cdn`)
    .replace(/^https:\/\/video\.bsky\.app/, `${CORS_WORKER}/video`);
}

const ASSET_BASE = import.meta.env.BASE_URL; // '/' in dev, '/bsky-gallery/3d/' in prod

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Detect handle / profile URL / feed URL / list URL / AT-URI
function parseSource(input) {
  const s = (input || '').trim();

  let m = s.match(/bsky\.app\/profile\/([^\/]+)\/feed\/([^\/?#]+)/i);
  if (m) return { type: 'feed', handle: m[1], rkey: m[2] };

  m = s.match(/bsky\.app\/profile\/([^\/]+)\/lists\/([^\/?#]+)/i);
  if (m) return { type: 'list', handle: m[1], rkey: m[2] };

  m = s.match(/bsky\.app\/profile\/([^\/?#]+)/i);
  if (m) return { type: 'handle', actor: m[1] };

  if (s.startsWith('at://')) {
    if (s.includes('/app.bsky.feed.generator/')) return { type: 'feed', uri: s };
    if (s.includes('/app.bsky.graph.list/'))     return { type: 'list', uri: s };
  }

  return { type: 'handle', actor: s.replace(/^@/, '') };
}

const XRPC = 'https://public.api.bsky.app/xrpc';
const ENDPOINT = {
  handle: { path: 'app.bsky.feed.getAuthorFeed', param: 'actor' },
  feed:   { path: 'app.bsky.feed.getFeed',       param: 'feed'  },
  list:   { path: 'app.bsky.feed.getListFeed',   param: 'list'  },
};

async function resolveHandleToDid(handle) {
  if (handle.startsWith('did:')) return handle;
  const url = new URL(`${XRPC}/com.atproto.identity.resolveHandle`);
  url.searchParams.set('handle', handle);
  const res = await fetch(url);
  if (!res.ok) throw new Error('PROFILE_NOT_FOUND');
  return (await res.json()).did;
}

async function resolveSource(parsed) {
  if (parsed.type === 'handle') return { type: 'handle', uri: parsed.actor };
  if (parsed.uri) return parsed;
  const did = await resolveHandleToDid(parsed.handle);
  const collection = parsed.type === 'feed'
    ? 'app.bsky.feed.generator'
    : 'app.bsky.graph.list';
  return { type: parsed.type, uri: `at://${did}/${collection}/${parsed.rkey}` };
}

function setOverlayStatus(msg, kind) {
  overlayStatus.textContent = msg;
  overlayStatus.classList.toggle('notice', kind === 'notice');
  overlayStatus.classList.toggle('error',  kind === 'error');
}

// ---- Bluesky fetch ----
async function fetchMedia(source) {
  const out = [];
  let cursor = null;

  while (out.length < MAX_ITEMS) {
    const cfg = ENDPOINT[source.type];
    const url = new URL(`${XRPC}/${cfg.path}`);
    url.searchParams.set(cfg.param, source.uri);
    url.searchParams.set('limit', 100);
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 400 && /not found|could not find/i.test(body)) {
        throw new Error('PROFILE_NOT_FOUND');
      }
      throw new Error(`API ${res.status}`);
    }
    const data = await res.json();
    cursor = data.cursor || null;

    for (const fi of data.feed) {
      if (out.length >= MAX_ITEMS) break;
      const post = fi.post;
      let embed = post.embed;
      if (!embed) continue;
      if (embed.$type === 'app.bsky.embed.recordWithMedia#view') embed = embed.media;
      if (!embed) continue;

      const rkey = post.uri.split('/').pop();
      const authorHandle = post.author.handle;
      const displayName = post.author.displayName || authorHandle;
      const postUrl = `https://bsky.app/profile/${authorHandle}/post/${rkey}`;
      const postText = (post.record && post.record.text) || '';
      const date = new Date(post.indexedAt).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
      });

      const meta = { authorHandle, displayName, postUrl, postText, date };

      if (embed.$type === 'app.bsky.embed.images#view') {
        for (const img of embed.images) {
          if (out.length >= MAX_ITEMS) break;
          out.push({
            type: 'image',
            thumb: proxyUrl(img.thumb),
            full: proxyUrl(img.fullsize),
            aspectRatio: img.aspectRatio,
            alt: img.alt || '',
            ...meta,
          });
        }
      } else if (embed.$type === 'app.bsky.embed.video#view') {
        out.push({
          type: 'video',
          thumb: proxyUrl(embed.thumbnail),
          full: proxyUrl(embed.playlist),
          aspectRatio: embed.aspectRatio,
          alt: embed.alt || '',
          ...meta,
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

// ---- Mode (carousel | gallery) ----
const MODE = (new URL(window.location).searchParams.get('mode') || 'gallery');
const DEV_MODE = new URL(window.location).searchParams.get('dev') === 'true';

// ---- Carousel layout ----
function buildCarousel(scene, items) {
  const N = items.length;
  const RADIUS = (N * PLANE_WIDTH * PLANE_GAP) / (2 * Math.PI);
  scene.background = new THREE.Color(0x111111);

  const planes = [];
  for (let i = 0; i < N; i++) {
    const item = items[i];
    const angle = (i / N) * Math.PI * 2;
    const ar = item.aspectRatio ? item.aspectRatio.width / item.aspectRatio.height : 1;
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

  return { planes, startPos: new THREE.Vector3(0, 0, 0) };
}

// ---- Museum placard (rendered to canvas, used as a texture) ----
function wrapTextLines(ctx, text, maxWidth, maxLines) {
  if (!text) return [];
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const test = cur ? cur + ' ' + words[i] : words[i];
    if (ctx.measureText(test).width <= maxWidth) {
      cur = test;
    } else {
      if (cur) lines.push(cur);
      cur = words[i];
      if (lines.length >= maxLines) {
        // Anything left → ellipsize the last line
        let last = lines[maxLines - 1];
        const ellipsis = '…';
        let withEllipsis = last + ellipsis;
        while (ctx.measureText(withEllipsis).width > maxWidth && last.length > 1) {
          last = last.slice(0, -1);
          withEllipsis = last + ellipsis;
        }
        lines[maxLines - 1] = withEllipsis;
        return lines;
      }
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines;
}

function drawExternalLinkIcon(ctx, x, y, size, color = '#111') {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Box (open top-right corner)
  ctx.beginPath();
  ctx.moveTo(x + size * 0.55, y + size * 0.1);
  ctx.lineTo(x + size * 0.15, y + size * 0.1);
  ctx.lineTo(x + size * 0.15, y + size * 0.85);
  ctx.lineTo(x + size * 0.85, y + size * 0.85);
  ctx.lineTo(x + size * 0.85, y + size * 0.45);
  ctx.stroke();
  // Arrow square (top-right)
  ctx.beginPath();
  ctx.moveTo(x + size * 0.5, y + size * 0.1);
  ctx.lineTo(x + size * 0.9, y + size * 0.1);
  ctx.lineTo(x + size * 0.9, y + size * 0.5);
  ctx.stroke();
  // Arrow diagonal
  ctx.beginPath();
  ctx.moveTo(x + size * 0.4, y + size * 0.6);
  ctx.lineTo(x + size * 0.9, y + size * 0.1);
  ctx.stroke();
  ctx.restore();
}

const PLACARD_PX_W = 720;
const PLACARD_PX_H = 360;

function makePlacardTexture(item) {
  const canvas = document.createElement('canvas');
  canvas.width = PLACARD_PX_W;
  canvas.height = PLACARD_PX_H;
  const ctx = canvas.getContext('2d');

  // Card background
  ctx.fillStyle = '#eeeeee';
  ctx.fillRect(0, 0, PLACARD_PX_W, PLACARD_PX_H);

  const padX = 36;
  const padY = 32;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#111';

  // Display name (bold, top)
  ctx.font = '700 36px Inter, system-ui, -apple-system, sans-serif';
  ctx.fillText(item.displayName, padX, padY);

  // Body: alt text (preferred) or post text, cropped to 3 lines
  ctx.font = '400 26px Inter, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#444';
  const body =
    (item.alt && item.alt.trim()) ||
    (item.postText && item.postText.trim()) ||
    'Untitled';
  const lines = wrapTextLines(ctx, body, PLACARD_PX_W - padX * 2, 3);
  let by = padY + 56;
  for (const line of lines) {
    ctx.fillText(line, padX, by);
    by += 34;
  }

  // Footer divider
  const footerY = PLACARD_PX_H - padY - 36;
  ctx.fillStyle = '#e6e6e6';
  ctx.fillRect(padX, footerY, PLACARD_PX_W - padX * 2, 1);

  // Date (left of footer)
  ctx.font = '500 22px Inter, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#666';
  ctx.fillText(item.date, padX, footerY + 12);

  // External-link icon (right of footer)
  const ICON_SIZE = 28;
  const iconX = PLACARD_PX_W - padX - ICON_SIZE;
  const iconY = footerY + 8;
  drawExternalLinkIcon(ctx, iconX, iconY, ICON_SIZE, '#111');

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---- PBR texture loader (PolyHaven-style sets) ----
const _exrLoader = new EXRLoader();
const _texLoader = new THREE.TextureLoader();

// Set after renderer is created so we know the GPU's max anisotropy.
let _maxAniso = 8;

function loadPBRSet(prefix, repeat = 2) {
  const diff = _texLoader.load(`${prefix}_diff_1k.jpg`);
  diff.colorSpace = THREE.SRGBColorSpace;

  // ARM = AO (R) + Roughness (G) + Metalness (B), packed into one JPEG.
  // Three.js samples the right channel per slot when the same texture is
  // assigned to aoMap / roughnessMap / metalnessMap.
  const arm = _texLoader.load(`${prefix}_arm_1k.jpg`);

  // EXRLoader produces float textures and does NOT auto-generate mipmaps;
  // explicitly enable so the normal map filters cleanly at grazing angles.
  const norm = _exrLoader.load(`${prefix}_nor_gl_1k.exr`, (tex) => {
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
  });

  for (const t of [diff, norm, arm]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = _maxAniso;
  }
  return { diff, norm, arm };
}

// ---- Gallery layout (rooms with doorways, partition walls, spot lights) ----
function buildGallery(scene, items) {
  scene.background = new THREE.Color(0x161616);
  const ambient = new THREE.AmbientLight(0xffffff, 1.8);
  scene.add(ambient);

  const ROOM_H = 5;
  const DOOR_W = 2.6;
  const DOOR_H = 3.2;
  const WALL_T = 0.2;

  // Wall + floor PBR textures (PolyHaven 1k sets in /public/textures).
  // Texture.repeat stays at 1 — per-mesh UV scaling controls tile density.
  const wallTex  = loadPBRSet(`${ASSET_BASE}textures/plastered_wall_04_1k/textures/plastered_wall_04`, 1);
  const floorTex = loadPBRSet(`${ASSET_BASE}textures/concrete_floor_worn_001_1k/textures/concrete_floor_worn_001`, 1);
  const WALL_TILE_M  = 3.5;  // 1 texture tile per 3.5m of wall
  const FLOOR_TILE_M = 1.0;  // 1 texture tile per 1m of floor

  const wallMat = new THREE.MeshStandardMaterial({
    map: wallTex.diff,
    normalMap: wallTex.norm,
    aoMap: wallTex.arm,
    aoMapIntensity: 0.5,        // soften AO so crevices aren't so dark
    roughnessMap: wallTex.arm,
    metalnessMap: wallTex.arm,
    metalness: 0,
    roughness: 1,
  });
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex.diff,
    normalMap: floorTex.norm,
    aoMap: floorTex.arm,
    roughnessMap: floorTex.arm,
    metalnessMap: floorTex.arm,
    metalness: 0,
    roughness: 1,
  });
  // Ceiling stays cheap & flat — most users never look up
  const ceilMat = new THREE.MeshLambertMaterial({ color: 0xffffff });

  // Linear gallery: rooms in a row along -Z, sharing N/S walls between them.
  // All rooms share width so the shared walls fit cleanly. Depth varies.
  const ROOM_W = 14;
  const rooms = [
    { d: 12 },
    { d: 16 },
    { d: 12 },
  ];

  // Wall surfaces collected for media placement.
  // { position: Vec3, normal: Vec3 (toward viewer side), width, height, capacity }
  const surfaces = [];

  function addBox(w, h, d, x, y, z, mat, tileM /* meters per texture tile */) {
    const geom = new THREE.BoxGeometry(w, h, d);
    if (tileM) {
      // BoxGeometry has 6 faces × 4 verts × 2 uv components = 48 floats.
      // Face order: [+X, -X, +Y, -Y, +Z, -Z]. Each face's UV currently spans
      // 0-1. Scale per face by (faceWidth/tileM, faceHeight/tileM) so tile
      // density is constant regardless of mesh size — small walls don't get
      // tiny tiles, big walls don't get oversize tiles.
      const uv = geom.attributes.uv.array;
      const f = [
        [d / tileM, h / tileM], [d / tileM, h / tileM], // ±X
        [w / tileM, d / tileM], [w / tileM, d / tileM], // ±Y
        [w / tileM, h / tileM], [w / tileM, h / tileM], // ±Z
      ];
      for (let face = 0; face < 6; face++) {
        const [sx, sy] = f[face];
        const start = face * 8;
        for (let v = 0; v < 4; v++) {
          uv[start + v * 2 + 0] *= sx;
          uv[start + v * 2 + 1] *= sy;
        }
      }
      geom.attributes.uv.needsUpdate = true;
    }
    // aoMap on MeshStandardMaterial samples from the uv1 channel; clone uv → uv1
    geom.setAttribute('uv1', geom.attributes.uv);
    const m = new THREE.Mesh(geom, mat);
    m.position.set(x, y, z);
    scene.add(m);
    return m;
  }

  // X-axis wall (fixed Z) — built ONCE; `sides` lists which faces get media surfaces
  function buildXWall(centerX, z, length, hasDoor, sides) {
    if (!hasDoor) {
      addBox(length, ROOM_H, WALL_T, centerX, ROOM_H / 2, z, wallMat, WALL_TILE_M);
      for (const s of sides) {
        surfaces.push({
          position: new THREE.Vector3(centerX, ROOM_H / 2, z + s * WALL_T / 2),
          normal: new THREE.Vector3(0, 0, s),
          width: length, height: ROOM_H, capacity: 3,
        });
      }
    } else {
      const sideW = (length - DOOR_W) / 2;
      const topH = ROOM_H - DOOR_H;
      addBox(sideW, ROOM_H, WALL_T, centerX - DOOR_W / 2 - sideW / 2, ROOM_H / 2, z, wallMat, WALL_TILE_M);
      addBox(sideW, ROOM_H, WALL_T, centerX + DOOR_W / 2 + sideW / 2, ROOM_H / 2, z, wallMat, WALL_TILE_M);
      addBox(DOOR_W, topH, WALL_T, centerX, DOOR_H + topH / 2, z, wallMat, WALL_TILE_M);
      for (const s of sides) {
        surfaces.push({
          position: new THREE.Vector3(centerX - DOOR_W / 2 - sideW / 2, ROOM_H / 2, z + s * WALL_T / 2),
          normal: new THREE.Vector3(0, 0, s),
          width: sideW, height: ROOM_H, capacity: 1,
        });
        surfaces.push({
          position: new THREE.Vector3(centerX + DOOR_W / 2 + sideW / 2, ROOM_H / 2, z + s * WALL_T / 2),
          normal: new THREE.Vector3(0, 0, s),
          width: sideW, height: ROOM_H, capacity: 1,
        });
      }
    }
  }

  // Z-axis wall (fixed X) — owned by a single room
  function buildZWall(x, centerZ, length, normalSign) {
    addBox(WALL_T, ROOM_H, length, x, ROOM_H / 2, centerZ, wallMat, WALL_TILE_M);
    surfaces.push({
      position: new THREE.Vector3(x + normalSign * WALL_T / 2, ROOM_H / 2, centerZ),
      normal: new THREE.Vector3(normalSign, 0, 0),
      width: length, height: ROOM_H, capacity: 3,
    });
  }

  let zCursor = 0; // north edge of current room
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    const cz = zCursor - r.d / 2;

    // Floor + ceiling (floor uses small tiles, ceiling stays untextured)
    addBox(ROOM_W, 0.1, r.d, 0, -0.05, cz, floorMat, FLOOR_TILE_M);
    addBox(ROOM_W, 0.1, r.d, 0, ROOM_H + 0.05, cz, ceilMat);

    // East + west walls (each room owns its own; no sharing)
    buildZWall( ROOM_W / 2, cz, r.d, -1);
    buildZWall(-ROOM_W / 2, cz, r.d, +1);

    // One partition wall per room, alternating orientation
    const PART_H = 3.4;
    const PART_T = 0.18;
    if (i % 2 === 0) {
      const partW = ROOM_W * 0.55;
      const partZ = cz;            // centered front-to-back in the room
      addBox(partW, PART_H, PART_T, 0, PART_H / 2, partZ, wallMat, WALL_TILE_M);
      surfaces.push({
        position: new THREE.Vector3(0, PART_H / 2, partZ + PART_T / 2),
        normal: new THREE.Vector3(0, 0, +1), width: partW, height: PART_H, capacity: 2,
      });
      surfaces.push({
        position: new THREE.Vector3(0, PART_H / 2, partZ - PART_T / 2),
        normal: new THREE.Vector3(0, 0, -1), width: partW, height: PART_H, capacity: 2,
      });
    } else {
      const partD = r.d * 0.55;
      const partX = -ROOM_W * 0.18;
      addBox(PART_T, PART_H, partD, partX, PART_H / 2, cz, wallMat, WALL_TILE_M);
      surfaces.push({
        position: new THREE.Vector3(partX + PART_T / 2, PART_H / 2, cz),
        normal: new THREE.Vector3(+1, 0, 0), width: partD, height: PART_H, capacity: 2,
      });
      surfaces.push({
        position: new THREE.Vector3(partX - PART_T / 2, PART_H / 2, cz),
        normal: new THREE.Vector3(-1, 0, 0), width: partD, height: PART_H, capacity: 2,
      });
    }

    zCursor -= r.d;
  }

  // Build N/S walls at boundaries — each one ONCE, no z-fighting.
  // North outer wall of room 0 (solid, surface only on the room-0 side)
  buildXWall(0, 0, ROOM_W, false, [-1]);
  // Between every pair of rooms: door wall, surfaces on both sides
  let zb = 0;
  for (let i = 0; i < rooms.length - 1; i++) {
    zb -= rooms[i].d;
    buildXWall(0, zb, ROOM_W, true, [+1, -1]);
  }
  // South outer wall of last room (solid, surface only on its side)
  zb -= rooms[rooms.length - 1].d;
  buildXWall(0, zb, ROOM_W, false, [+1]);

  // ---- Place media onto surfaces ----
  // Each surface has a capacity (2 or 3); spread items along its width.
  const planes = [];
  const artworks = [];        // for spotlight pooling
  let itemIdx = 0;
  const MEDIA_BASE_HEIGHT = 1.6;     // hung at eye level
  const MEDIA_MAX_W = 2.8;            // cap so multiple fit on one surface
  const MEDIA_MAX_H = 2.6;

  for (const surf of surfaces) {
    if (itemIdx >= items.length) break;
    const n = Math.min(surf.capacity, items.length - itemIdx);
    if (n === 0) continue;

    // Distribute n media along the surface's width axis
    // Surface width axis is perpendicular to normal in the XZ plane.
    const widthAxis = new THREE.Vector3(-surf.normal.z, 0, surf.normal.x); // 90° CCW around Y

    // Reserve some margin
    const usable = surf.width - 0.6;
    const slot = usable / n;
    const startOffset = -usable / 2 + slot / 2;

    for (let k = 0; k < n; k++) {
      const item = items[itemIdx++];
      const ar = item.aspectRatio ? item.aspectRatio.width / item.aspectRatio.height : 1;
      let mw = Math.min(MEDIA_MAX_W, slot * 0.8);
      let mh = mw / ar;
      if (mh > MEDIA_MAX_H) {
        mh = MEDIA_MAX_H;
        mw = mh * ar;
      }
      // Center vertically on this surface (eye-level for tall walls; centered for partitions)
      const cy = surf.height < ROOM_H ? surf.height / 2 : MEDIA_BASE_HEIGHT;

      const along = startOffset + k * slot;
      const px = surf.position.x + widthAxis.x * along;
      const pz = surf.position.z + widthAxis.z * along;

      // Artwork: box mesh (canvas-frame look) protruding from the wall
      const FRAME_DEPTH = 0.06;
      const offset = FRAME_DEPTH / 2 + 0.005; // half-depth + tiny gap to avoid z-fighting
      const fx = px + surf.normal.x * offset;
      const fz = pz + surf.normal.z * offset;

      const sideMat  = new THREE.MeshLambertMaterial({ color: 0xffffff });
      // Basic so the image renders at true colors regardless of lighting.
      // Trade-off: it doesn't catch spotlights, but stays vibrant.
      const frontMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      // Box face order: [+x, -x, +y, -y, +z (front), -z (back)]
      const boxMats = [sideMat, sideMat, sideMat, sideMat, frontMat, sideMat];
      const boxGeom = new THREE.BoxGeometry(mw, mh, FRAME_DEPTH);
      const mesh = new THREE.Mesh(boxGeom, boxMats);
      mesh.position.set(fx, cy, fz);
      // Face the surface normal direction (so +Z front faces out)
      mesh.lookAt(fx + surf.normal.x, cy, fz + surf.normal.z);
      mesh.userData.item = item;
      mesh.userData.fullLoaded = false;
      // Spotlight anchor: positioned in front + above, scaled to media size.
      // Bigger pieces get a higher anchor and a wider cone so the halo fits.
      const mediaSize = Math.max(mw, mh);
      const forwardDist = 1.4 + mediaSize * 0.2;       // bigger art → push light further out
      const headroom    = 0.5 + mediaSize * 0.4;       // bigger art → light hangs higher above top
      mesh.userData.lightAnchor = new THREE.Vector3(
        fx + surf.normal.x * forwardDist,
        cy + mh / 2 + headroom,
        fz + surf.normal.z * forwardDist
      );
      mesh.userData.lightTarget   = new THREE.Vector3(fx, cy, fz);
      mesh.userData.lightAngle    = Math.min(Math.PI / 4, Math.atan2(mediaSize * 0.7, forwardDist));
      mesh.userData.lightDistance = 5 + mediaSize * 1.5;
      scene.add(mesh);
      planes.push(mesh);
      artworks.push(mesh);

      const applyMap = (tex) => {
        frontMat.map = tex;
        frontMat.color.setHex(0xffffff);
        frontMat.needsUpdate = true;
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

      // ----- Placard: small textured plane, hung to the right -----
      const placardTex = makePlacardTexture(item);
      const PLACARD_W = 0.375;                                 // 50% bigger
      const PLACARD_H = PLACARD_W * (PLACARD_PX_H / PLACARD_PX_W);
      const placardGeom = new THREE.PlaneGeometry(PLACARD_W, PLACARD_H);
      const placardMat = new THREE.MeshStandardMaterial({
        map: placardTex,
        roughness: 1,
        metalness: 0,
      });
      const placard = new THREE.Mesh(placardGeom, placardMat);
      // Flush against the wall (1mm in front to avoid z-fighting), to the
      // right of the artwork, vertically centered to the image.
      placard.position.set(
        mw / 2 + PLACARD_W / 2 + 0.08,
        0,
        -FRAME_DEPTH / 2 - 0.004
      );
      placard.userData.item = item;
      mesh.add(placard);
      planes.push(placard);
    }
  }

  // Player starts just inside the first room, looking south
  const startPos = new THREE.Vector3(0, 1.6, -1.2);
  return { planes, artworks, startPos, ambient };
}

// ---- Scene setup (shared by both modes) ----
function init(items) {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 200);
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  _maxAniso = 16;
  console.log('devicePixelRatio:', window.devicePixelRatio, '→ using', renderer.getPixelRatio());

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
  aoPass.resolutionScale  = 0.5;
  aoPass.distanceExponent.value = 1;
  aoPass.distanceFallOff.value  = 0.1;
  aoPass.radius.value     = 1.0;
  aoPass.scale.value      = 1.5;
  aoPass.thickness.value  = 1;

  const aoTexture = aoPass.getTextureNode();
  const denoisedAO = denoise(aoTexture, sceneDepth, sceneNormal, camera).r;
  const softenedAO = denoisedAO.pow(0.5);
  const composited = mix(sceneColor, sceneColor.mul(softenedAO), aoEnabled);

  const postProcessing = new THREE.PostProcessing(renderer);
  postProcessing.outputNode = composited;

  // ---- IBL environment ----
  // PMREMGenerator stays alive so we can process HDRs on demand when the user
  // picks one from the GUI. Each environment is cached after first compute.
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const rgbeLoader = new RGBELoader();
  const envCache = new Map(); // key → THREE.Texture

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
      return;
    }
    if (key === 'procedural') {
      const tex = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      envCache.set(key, tex);
      scene.environment = tex;
      return;
    }
    rgbeLoader.load(key, (hdr) => {
      const tex = pmremGenerator.fromEquirectangular(hdr).texture;
      hdr.dispose();
      envCache.set(key, tex);
      scene.environment = tex;
    });
  }

  // Default environment
  const DEFAULT_ENV = `${ASSET_BASE}hdr/studio_small_08_1k.hdr`;
  applyEnv(DEFAULT_ENV);

  const built = MODE === 'carousel' ? buildCarousel(scene, items) : buildGallery(scene, items);
  const planes = built.planes;
  const artworks = built.artworks || [];
  const ambient = built.ambient || null;
  camera.position.copy(built.startPos);
  // Face -Z by default (looking into the gallery / into the carousel center)
  if (MODE === 'gallery') camera.lookAt(0, 1.6, -10);

  // ---- Spotlight pool (gallery mode only) ----
  // Forward-renderer is unhappy with many lights, so we keep a fixed-size pool
  // of SpotLights and retarget them each frame to the nearest visible artworks.
  const lightSettings = {
    maxLights: 6,
    intensity: 12,
  };
  const toggles = {
    spotlights: true,
    gtao:       true,
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

    if (DEV_MODE) {
      const gui = new GUI({ title: 'Lighting' });

      gui.add(toggles, 'spotlights').name('Spotlights')
        .onChange((v) => rebuildPool(v ? lightSettings.maxLights : 0));
      gui.add(toggles, 'gtao').name('GTAO')
        .onChange((v) => { aoEnabled.value = v ? 1 : 0; });

      gui.add(lightSettings, 'maxLights', 0, 50, 1).name('Max Spotlights')
        .onFinishChange((v) => { if (toggles.spotlights) rebuildPool(v); });
      gui.add(lightSettings, 'intensity', 0, 50, 0.5).name('Spotlight Intensity');

      if (ambient) {
        gui.add(ambient, 'intensity', 0, 5, 0.05).name('Ambient');
      }
      const envSelect = { current: DEFAULT_ENV };
      gui.add(envSelect, 'current', ENV_OPTIONS).name('Environment').onChange(applyEnv);
      gui.add(scene, 'environmentIntensity', 0, 3, 0.05).name('Env Intensity');
    }
  }

  const LIGHT_LERP_RATE = 8; // ~125ms fade in/out

  function updateLightPool(dt) {
    if (lightPool.length === 0) return;

    // Proximity-only: nearest N artworks get lights, regardless of camera
    // facing. Avoids the pop-in/out at frustum edges, and "lights you can't
    // see" cost the same in the shader anyway.
    const visible = artworks.slice().sort((a, b) =>
      a.position.distanceToSquared(camera.position) -
      b.position.distanceToSquared(camera.position)
    );
    const topVisible = new Set(visible.slice(0, lightPool.length));

    // 2. Decide each slot's target: keep if its artwork is still in topVisible,
    //    otherwise mark for fade-out.
    const claimed = new Set();
    for (const slot of lightPool) {
      if (slot.userData.artwork && topVisible.has(slot.userData.artwork)) {
        claimed.add(slot.userData.artwork);
        slot.userData.targetIntensity = lightSettings.intensity;
      } else {
        slot.userData.targetIntensity = 0;
      }
    }

    // 3. Release slots whose intensity has fully decayed, then assign any
    //    newly-visible artworks to free slots.
    for (const slot of lightPool) {
      if (slot.userData.targetIntensity === 0 && slot.intensity < 0.02) {
        slot.userData.artwork = null;
      }
    }
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

    // 4. Smoothly lerp every slot's intensity toward its target.
    const k = Math.min(1, dt * LIGHT_LERP_RATE);
    for (const slot of lightPool) {
      const target = slot.userData.targetIntensity ?? 0;
      slot.intensity += (target - slot.intensity) * k;
    }
  }

  const controls = new PointerLockControls(camera, renderer.domElement);
  // Only the engage prompt locks; clicks on the form/input do not.
  engagePrompt.addEventListener('click', () => controls.lock());
  controls.addEventListener('lock', () => { overlayEl.hidden = true; });
  // TEMP: keep the scene visible after Esc so the GUI is interactable.
  // Click on the canvas to re-engage pointer lock.
  // controls.addEventListener('unlock', () => { overlayEl.hidden = false; });
  renderer.domElement.addEventListener('click', () => {
    if (!controls.isLocked) controls.lock();
  });

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

  const raycaster = new THREE.Raycaster();
  const center = new THREE.Vector2(0, 0);
  renderer.domElement.addEventListener('mousedown', () => {
    if (!controls.isLocked) return;
    raycaster.setFromCamera(center, camera);
    const hits = raycaster.intersectObjects(planes, false);
    if (hits.length) {
      const plane = hits[0].object;
      const item = plane.userData.item;
      // Click whatever you're looking at → open the post on Bluesky.
      if (item.postUrl) window.open(item.postUrl, '_blank', 'noopener');
    }
  });

  // ---- Stats (dev only) ----
  let stats = null;
  if (DEV_MODE) {
    stats = new Stats();
    stats.dom.style.cssText = 'position:fixed;top:0;left:0;z-index:1000;';
    document.body.appendChild(stats.dom);
  }

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
    if (MODE === 'gallery') updateLightPool(dt);
    postProcessing.render();
    stats?.update();
  }
  // WebGPU init is async — wait until the renderer is ready before kicking
  // off the animation loop.
  renderer.init().then(animate);

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

// ---- Boot / handle handling ----
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
    const items = await fetchMedia(source);
    countEl.textContent = items.length;
    init(items);
    sceneLoaded = true;
    // Swap modal content from form → engage prompt
    form.hidden = true;
    setOverlayStatus('');
    engagePrompt.hidden = false;
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

// On first load, honor ?handle=… so links are shareable (matches 2D gallery).
// If no URL param, the input stays empty and waits for user input.
(() => {
  const initial = new URL(window.location).searchParams.get('handle');
  if (initial) {
    handleInput.value = initial;
    loadFor(initial, { pushUrl: false });
  } else {
    handleInput.focus();
  }
})();
