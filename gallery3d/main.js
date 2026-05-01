import * as THREE from 'three/webgpu';
const { Timer } = THREE;
import { mrt, output, normalView, pass, mix, uniform } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
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

// ---- Bluesky fetch (paginated) ----
function parseFeedToMedia(feed, out) {
  for (const fi of feed) {
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

    // groupId: stable per-post key so multi-image posts can share frame
    // styling and target sizing in the gallery.
    const meta = { authorHandle, displayName, postUrl, postText, date, groupId: post.uri };

    if (embed.$type === 'app.bsky.embed.images#view') {
      for (const img of embed.images) {
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
}

function createPaginator(source) {
  let cursor = null;
  let exhausted = false;

  async function fetchNextPage() {
    if (exhausted) return [];
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
    if (!cursor) exhausted = true;
    const out = [];
    parseFeedToMedia(data.feed, out);
    return out;
  }

  return { fetchNextPage, get isExhausted() { return exhausted; } };
}

// Pull pages until we have at least minCount items (or the feed runs out).
async function fetchInitialMedia(source, minCount) {
  const paginator = createPaginator(source);
  const items = [];
  while (items.length < minCount && !paginator.isExhausted) {
    const more = await paginator.fetchNextPage();
    items.push(...more);
    if (more.length === 0) break;
  }
  return { paginator, items };
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

// Track all video elements created in the scene + the mesh each belongs to,
// so we can set per-video volume based on camera distance each frame.
const galleryVideos = []; // [{ video, mesh }]

function makeVideoTexture(playlistUrl, mesh) {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.autoplay = true;
  video.preload = 'auto';
  // Offscreen at intrinsic size — the 1px×1px sizing previously here can
  // interact badly with WebGPU's copyExternalImageToTexture upload path on
  // some browsers (textures end up smaller than the video frame, producing
  // partial-coverage rendering).
  video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;';
  document.body.appendChild(video);

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = playlistUrl;
  } else if (Hls.isSupported()) {
    // Force the highest available variant from the start. WebGPU's
    // VideoTexture is allocated at the first frame's dimensions and doesn't
    // reallocate when the source upgrades mid-stream — so we pin to the
    // largest level from the very first segment.
    const hls = new Hls({
      abrEwmaDefaultEstimate: 100_000_000, // 100 Mbps initial estimate → top tier
      capLevelToPlayerSize: false,
    });
    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      if (data.levels.length > 1) hls.currentLevel = data.levels.length - 1;
    });
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
  if (mesh) galleryVideos.push({ video, mesh });
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
      const vtex = makeVideoTexture(item.full, mesh);
      const video = vtex.image;
      const swap = () => applyMap(vtex);
      if (video.readyState >= 2) swap();
      else video.addEventListener('loadeddata', swap, { once: true });
    }
  }

  return { planes, startPos: new THREE.Vector3(0, 0, 0) };
}

// ---- Picture frame GLB ----
// Loaded once and cached. We measure its natural bounding box so each clone
// can be stretched to match the artwork it surrounds.
let frameTemplate = null;
let frameSize = null; // THREE.Vector3 of natural bbox size

async function loadFrameTemplate() {
  if (frameTemplate) return frameTemplate;
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(`${ASSET_BASE}models/fancy_picture_frame.glb`);
  frameTemplate = gltf.scene;
  const bbox = new THREE.Box3().setFromObject(frameTemplate);
  frameSize = new THREE.Vector3();
  bbox.getSize(frameSize);
  console.log('Frame natural size:', frameSize);
  return frameTemplate;
}

// ---- People GLB ----
// Each top-level child of people.glb is treated as one person template; we
// clone N of them per room and fade them out when the camera gets close.
let peopleTemplates = null;

async function loadPeopleTemplates() {
  if (peopleTemplates !== null) return peopleTemplates;
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(`${ASSET_BASE}models/people.glb`);
  if (gltf.scene.children.length === 0) {
    peopleTemplates = [gltf.scene];
  } else {
    // Fisher-Yates shuffle, then take 10
    const all = gltf.scene.children.slice();
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    peopleTemplates = all.slice(0, 10);
  }
  console.log(`Loaded ${peopleTemplates.length} people templates`);
  return peopleTemplates;
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

function ellipsizeLine(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 0 && ctx.measureText(s + '…').width > maxWidth) {
    s = s.slice(0, -1);
  }
  return s + '…';
}

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
  const innerW = PLACARD_PX_W - padX * 2;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#111';

  // Display name (bold, top) — single line, ellipsised if too long
  ctx.font = '700 48px Inter, system-ui, -apple-system, sans-serif';
  ctx.fillText(ellipsizeLine(ctx, item.displayName, innerW), padX, padY);

  // Body: alt text (preferred) or post text, cropped to 3 lines
  ctx.font = '400 32px Inter, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#444';
  const body =
    (item.alt && item.alt.trim()) ||
    (item.postText && item.postText.trim()) ||
    'Untitled';
  const lines = wrapTextLines(ctx, body, innerW, 3);
  let by = padY + 70;
  for (const line of lines) {
    ctx.fillText(line, padX, by);
    by += 42;
  }

  // Footer divider
  const footerY = PLACARD_PX_H - padY - 40;
  ctx.fillStyle = '#e6e6e6';
  ctx.fillRect(padX, footerY, innerW, 1);

  // Date (left of footer)
  ctx.font = '500 28px Inter, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#666';
  ctx.fillText(item.date, padX, footerY + 14);

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

async function loadPBRSet(prefix, repeat = 2) {
  // ARM = AO (R) + Roughness (G) + Metalness (B), packed into one JPEG.
  // Three.js samples the right channel per slot when the same texture is
  // assigned to aoMap / roughnessMap / metalnessMap. EXRLoader produces
  // float textures and does NOT auto-generate mipmaps; we enable them
  // explicitly below so the normal map filters cleanly at grazing angles.
  const [diff, arm, norm] = await Promise.all([
    _texLoader.loadAsync(`${prefix}_diff_1k.jpg`),
    _texLoader.loadAsync(`${prefix}_arm_1k.jpg`),
    _exrLoader.loadAsync(`${prefix}_nor_gl_1k.exr`),
  ]);
  diff.colorSpace = THREE.SRGBColorSpace;
  norm.generateMipmaps = true;
  norm.minFilter = THREE.LinearMipmapLinearFilter;
  norm.magFilter = THREE.LinearFilter;
  norm.needsUpdate = true;
  for (const t of [diff, norm, arm]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = _maxAniso;
  }
  return { diff, norm, arm };
}

// ---- Gallery layout (endless treadmill of alternating rooms) ----
// 3 rooms always loaded along -Z; crossing a doorway recycles the trailing
// room to the front of the line. Big and small rooms alternate by feedIdx
// (even = small, odd = big). When the feed is exhausted, the next room to
// be built becomes a forced-small terminal room with a closed far wall.
const ROOM_W = 14;
const ROOM_H = 5;
const ROOM_DEPTHS = { small: 12, big: 16 };
const DOOR_W = 2.6;
const DOOR_H = 3.2;
const WALL_T = 0.2;
const WALL_LIFT = 0.02; // bottom of walls sits this far above the floor; same gap above
const WALL_TILE_M = 3.5;
const FLOOR_TILE_M = 1.0;

const SLOT_COUNT = 5;
// Recycle bookkeeping: keep at least LOOKAHEAD rooms south of the player
// and LOOKBEHIND north of them. Crossing into the trigger zone recycles
// the trailing slot to the leading end and snaps currentSlotIdx back to
// the anchor (slots.length - 1 - LOOKAHEAD), so voids past the loaded
// chain are always at least LOOKAHEAD rooms away from the camera.
const LOOKAHEAD  = 2;
const LOOKBEHIND = 2;
const MIN_ROOM_ITEMS = 5;     // remaining-items threshold below which the next room becomes terminal
const PREFETCH_AHEAD = 30;    // when buffer ahead drops below this, fetch a new page

const MEDIA_BASE_HEIGHT = 1.6;
const MEDIA_MAX_W = 2.8;
const MEDIA_MAX_H = 2.6;
const FRAME_DEPTH = 0.06;

const PEOPLE_PER_ROOM  = 2;
const PEOPLE_STANDOFF  = 2.0;  // metres in front of the artwork
const PEOPLE_FADE_NEAR = 2.0;  // fully invisible at this camera distance
const PEOPLE_FADE_FAR  = 4.0;  // fully visible beyond this distance

// Place PEOPLE_PER_ROOM cloned people in front of random artworks.
// Materials are cloned per-instance so opacity is independent; textures
// stay shared with the GLB template (marked skipMapDispose so disposal
// doesn't free them).
function placePeopleInRoom(group, artworks) {
  if (!peopleTemplates || peopleTemplates.length === 0 || artworks.length === 0) return [];
  const people = [];

  // Shuffle artworks and take up to PEOPLE_PER_ROOM
  const candidates = artworks.slice();
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const targets = candidates.slice(0, Math.min(PEOPLE_PER_ROOM, candidates.length));

  for (const art of targets) {
    const tpl = peopleTemplates[Math.floor(Math.random() * peopleTemplates.length)];
    const inner = tpl.clone(true);
    // The GLB lays the 20 templates out in a row (node translations
    // [0,0,0], [10,0,0], [20,0,0], …). Clone() preserves the node's
    // translation, so without this each clone lands far from the wrapper.
    inner.position.set(0, 0, 0);
    inner.scale.setScalar(0.2);
    const person = new THREE.Group();
    person.add(inner);

    const fadeMaterials = [];
    person.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      // Geometries are shared with the GLB template (Three.js Mesh.clone
      // doesn't deep-copy them) — disposal would invalidate every other
      // clone's render pipeline.
      o.userData.skipGeomDispose = true;
      const wrapMat = (m) => {
        const c = m.clone();
        c.transparent = true;
        c.depthWrite = false;
        c.opacity = 1;
        c.map = null;
        if (c.color) c.color.setHex(0x252525);
        c.userData.skipMapDispose = true;
        fadeMaterials.push(c);
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(wrapMat) : wrapMat(o.material);
    });
    person.userData.fadeMaterials = fadeMaterials;

    // The artwork stores lightAnchor (in front + above the surface) and
    // lightTarget (the surface centre) in world coords — use them to
    // derive the in-room "forward" direction without re-deriving normals.
    const artPos = art.userData.lightTarget;
    const lightAnchor = art.userData.lightAnchor;
    const forward = new THREE.Vector3().subVectors(lightAnchor, artPos);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) continue;
    forward.normalize();
    const worldX = artPos.x + forward.x * PEOPLE_STANDOFF;
    const worldZ = artPos.z + forward.z * PEOPLE_STANDOFF;
    person.position.set(worldX, 0, worldZ - group.position.z);

    const lookTarget = new THREE.Vector3(artPos.x, person.position.y, artPos.z - group.position.z);
    person.lookAt(lookTarget);

    group.add(person);
    people.push(person);
  }
  return people;
}

function defaultRoomType(feedIdx) {
  return feedIdx % 2 === 0 ? 'small' : 'big';
}

// Big rooms appear at feedIdx 1, 3, 5, ... — alternate which side the
// jutting partition sits on, so consecutive big rooms feel different.
function bigPartitionSide(feedIdx) {
  return ((feedIdx - 1) / 2) % 2 === 0 ? 'left' : 'right';
}

// UV-tiled box helper; identical math to the old buildGallery's addBox but
// parented to a passed-in object instead of the scene root.
function makeRoomBox(parent, w, h, d, x, y, z, mat, tileM) {
  const geom = new THREE.BoxGeometry(w, h, d);
  if (tileM) {
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
  geom.setAttribute('uv1', geom.attributes.uv);
  const m = new THREE.Mesh(geom, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

// Build a room as a self-contained Group whose center sits at (0,0,groupZ).
// All walls are owned per-room: adjacent rooms have their walls back-to-back
// (~2*WALL_T thick total), no z-fighting and trivial disposal on recycle.
// Returned surface positions are in WORLD coords (groupZ already baked in)
// since populateRoom consumes them as world-space anchors.
function buildRoom({ type, partitionSide, openNorth, openSouth, groupZ }, mats) {
  const { wallMat, floorMat, ceilMat } = mats;
  const d = ROOM_DEPTHS[type];

  const group = new THREE.Group();
  group.position.set(0, 0, groupZ);
  const surfaces = [];
  // World-space X/Z bounds of every wall section, used for player collision.
  const wallAABBs = [];
  function pushAABB(centerX, centerZ, w, dz) {
    wallAABBs.push({
      minX: centerX - w / 2, maxX: centerX + w / 2,
      minZ: centerZ - dz / 2, maxZ: centerZ + dz / 2,
    });
  }

  makeRoomBox(group, ROOM_W, 0.1, d, 0, -0.05, 0, floorMat, FLOOR_TILE_M);
  // Ceiling sits one extra WALL_LIFT above the wall tops so the floor/wall
  // and wall/ceiling reveals are symmetric.
  makeRoomBox(group, ROOM_W, 0.1, d, 0, ROOM_H + 0.05 + 2 * WALL_LIFT, 0, ceilMat);

  // East + west walls (room-local x = ±ROOM_W/2). Small rooms have shorter
  // side walls (d = 12) — drop their capacity to 2 so pieces aren't cramped
  // (especially when a slot is doubled into halves).
  const sideCapacity = type === 'small' ? 2 : 3;
  makeRoomBox(group, WALL_T, ROOM_H, d, ROOM_W / 2, ROOM_H / 2 + WALL_LIFT, 0, wallMat, WALL_TILE_M);
  pushAABB(ROOM_W / 2, groupZ, WALL_T, d);
  surfaces.push({
    position: new THREE.Vector3(ROOM_W / 2 - WALL_T / 2, ROOM_H / 2, groupZ),
    normal: new THREE.Vector3(-1, 0, 0),
    width: d, height: ROOM_H, capacity: sideCapacity,
  });
  makeRoomBox(group, WALL_T, ROOM_H, d, -ROOM_W / 2, ROOM_H / 2 + WALL_LIFT, 0, wallMat, WALL_TILE_M);
  pushAABB(-ROOM_W / 2, groupZ, WALL_T, d);
  surfaces.push({
    position: new THREE.Vector3(-ROOM_W / 2 + WALL_T / 2, ROOM_H / 2, groupZ),
    normal: new THREE.Vector3(+1, 0, 0),
    width: d, height: ROOM_H, capacity: sideCapacity,
  });

  // North/south end walls. localZ is the wall's outer face (room boundary);
  // the wall body is inset half-thickness so two adjacent rooms' walls abut
  // without overlap. sNormal points from wall into THIS room's interior.
  function addEndWall(localZ, sNormal, hasDoor) {
    // Wall body inset half-thickness inward from boundary, so two adjacent
    // rooms' walls abut without overlap. Surface sits on the wall's inner
    // (room-facing) face, half a thickness further inward from the center.
    const wallCenterZ = localZ + sNormal * (WALL_T / 2);
    const surfaceWorldZ = groupZ + wallCenterZ + sNormal * (WALL_T / 2);
    if (!hasDoor) {
      makeRoomBox(group, ROOM_W, ROOM_H, WALL_T, 0, ROOM_H / 2 + WALL_LIFT, wallCenterZ, wallMat, WALL_TILE_M);
      pushAABB(0, groupZ + wallCenterZ, ROOM_W, WALL_T);
      surfaces.push({
        position: new THREE.Vector3(0, ROOM_H / 2, surfaceWorldZ),
        normal: new THREE.Vector3(0, 0, sNormal),
        width: ROOM_W, height: ROOM_H, capacity: 3,
      });
    } else {
      const sideW = (ROOM_W - DOOR_W) / 2;
      const topH = ROOM_H - DOOR_H;
      makeRoomBox(group, sideW, ROOM_H, WALL_T,
        -DOOR_W / 2 - sideW / 2, ROOM_H / 2 + WALL_LIFT, wallCenterZ, wallMat, WALL_TILE_M);
      pushAABB(-DOOR_W / 2 - sideW / 2, groupZ + wallCenterZ, sideW, WALL_T);
      makeRoomBox(group, sideW, ROOM_H, WALL_T,
        +DOOR_W / 2 + sideW / 2, ROOM_H / 2 + WALL_LIFT, wallCenterZ, wallMat, WALL_TILE_M);
      pushAABB(+DOOR_W / 2 + sideW / 2, groupZ + wallCenterZ, sideW, WALL_T);
      // Transom above the doorway: no AABB — player walks under it.
      makeRoomBox(group, DOOR_W, topH, WALL_T,
        0, DOOR_H + topH / 2 + WALL_LIFT, wallCenterZ, wallMat, WALL_TILE_M);
      surfaces.push({
        position: new THREE.Vector3(-DOOR_W / 2 - sideW / 2, ROOM_H / 2, surfaceWorldZ),
        normal: new THREE.Vector3(0, 0, sNormal),
        width: sideW, height: ROOM_H, capacity: 1,
      });
      surfaces.push({
        position: new THREE.Vector3(+DOOR_W / 2 + sideW / 2, ROOM_H / 2, surfaceWorldZ),
        normal: new THREE.Vector3(0, 0, sNormal),
        width: sideW, height: ROOM_H, capacity: 1,
      });
    }
  }
  // North = +d/2 (toward zCursor=0); inside-facing surface points -Z (sNormal=-1).
  addEndWall(+d / 2, -1, openNorth);
  addEndWall(-d / 2, +1, openSouth);

  // Partition wall — small rooms get the wide cross partition; big rooms get
  // a side-jutting one whose side alternates by feedIdx.
  const PART_H = 3.4;
  const PART_T = 0.18;
  if (type === 'small') {
    const partW = ROOM_W * 0.55;
    makeRoomBox(group, partW, PART_H, PART_T, 0, PART_H / 2 + WALL_LIFT, 0, wallMat, WALL_TILE_M);
    pushAABB(0, groupZ, partW, PART_T);
    surfaces.push({
      position: new THREE.Vector3(0, PART_H / 2, groupZ + PART_T / 2),
      normal: new THREE.Vector3(0, 0, +1), width: partW, height: PART_H, capacity: 2,
    });
    surfaces.push({
      position: new THREE.Vector3(0, PART_H / 2, groupZ - PART_T / 2),
      normal: new THREE.Vector3(0, 0, -1), width: partW, height: PART_H, capacity: 2,
    });
  } else {
    const partD = d * 0.55;
    const xSign = partitionSide === 'right' ? +1 : -1;
    const partX = xSign * ROOM_W * 0.18;
    // Open face of the partition points toward the room's larger side
    const xNormal = -xSign;
    makeRoomBox(group, PART_T, PART_H, partD, partX, PART_H / 2 + WALL_LIFT, 0, wallMat, WALL_TILE_M);
    pushAABB(partX, groupZ, PART_T, partD);
    surfaces.push({
      position: new THREE.Vector3(partX + xNormal * PART_T / 2, PART_H / 2, groupZ),
      normal: new THREE.Vector3(xNormal, 0, 0), width: partD, height: PART_H, capacity: 2,
    });
    surfaces.push({
      position: new THREE.Vector3(partX - xNormal * PART_T / 2, PART_H / 2, groupZ),
      normal: new THREE.Vector3(-xNormal, 0, 0), width: partD, height: PART_H, capacity: 2,
    });
  }

  return { group, surfaces, wallAABBs };
}

// Hang media on the supplied surfaces. Items are pulled from `items` starting
// at index 0 (caller slices). Artwork meshes are parented to `group`. Spotlight
// anchors are stored in WORLD coords on the mesh — valid until the room is
// disposed (rooms don't move once positioned).
function populateRoom(group, surfaces, items, videoEntries) {
  const planes = [];
  const artworks = [];
  let idx = 0;

  // Placard dimensions are needed both during the doubled-pair layout pass
  // (to compute unit footprints) and per-item placement, so hoist them.
  const PLACARD_W = 0.32;
  const PLACARD_H = PLACARD_W * (PLACARD_PX_H / PLACARD_PX_W);
  const PAIR_INTER_GAP = 0.10; // gap between two units inside a doubled slot

  // Per-post-group decisions: items from the same bsky post share frame
  // styling and a target height, so a multi-image post reads as a set.
  const groupDecisions = new Map();
  function decisionsFor(item) {
    const key = item.groupId || item.postUrl || idx;
    let d = groupDecisions.get(key);
    if (!d) {
      d = {
        // Videos always get a frame; images are framed 50% of the time.
        hasFrame:    item.type === 'video' ? true : Math.random() < 0.5,
        frameColor:  Math.random() < 0.5 ? 0xbbbbbb : 0x111111,
        frameT:      0.04 + Math.random() * 0.04,
        // Separate target heights per slot type — a multi-image post can
        // straddle full and half slots; we don't want a small first
        // sibling to shrink larger ones (or vice-versa).
        targetHFull: null,
        targetHHalf: null,
      };
      groupDecisions.set(key, d);
    }
    return d;
  }

  for (const surf of surfaces) {
    if (idx >= items.length) break;
    const widthAxis = new THREE.Vector3(-surf.normal.z, 0, surf.normal.x);
    const usable = surf.width - 0.6;
    const N = surf.capacity;            // slot count
    const slot = usable / N;
    const startOffset = -usable / 2 + slot / 2;

    // Build placements: singles use slot center; doubled get along set
    // later by the pair-layout pass after sizes are known.
    const placements = [];
    let pairCounter = 0;
    for (let k = 0; k < N && idx < items.length; k++) {
      const remaining = items.length - idx;
      const slotCenter = startOffset + k * slot;
      // Partition surfaces (shorter than ROOM_H) have narrow slots — labels
      // get squeezed even with the centred-pair layout, so skip doubling.
      const isPartition = surf.height < ROOM_H;
      const doubleUp = !isPartition && remaining >= 2 && Math.random() < 0.18;
      if (doubleUp) {
        const pid = pairCounter++;
        placements.push({ item: items[idx++], slotW: slot / 2, along: 0, isHalf: true, pairSide: 'left',  pairId: pid, pairCenter: slotCenter });
        placements.push({ item: items[idx++], slotW: slot / 2, along: 0, isHalf: true, pairSide: 'right', pairId: pid, pairCenter: slotCenter });
      } else {
        placements.push({ item: items[idx++], slotW: slot,     along: slotCenter, isHalf: false });
      }
    }

    // Size in two passes so multi-image sets stay uniform per slot type.
    // Pass A: compute each placement's natural max height in its own slot.
    // Pass B: per group, set targetH{Full,Half} = min of members' naturals;
    //         then assign every member the group's target.
    for (const p of placements) {
      const ar = p.item.aspectRatio ? p.item.aspectRatio.width / p.item.aspectRatio.height : 1;
      const slotMul = p.isHalf ? 0.6 : 0.8;
      const maxAllowedW = Math.min(MEDIA_MAX_W, p.slotW * slotMul);
      let mw = maxAllowedW;
      let mh = mw / ar;
      if (mh > MEDIA_MAX_H) {
        mh = MEDIA_MAX_H;
        mw = mh * ar;
        if (mw > maxAllowedW) { mw = maxAllowedW; mh = mw / ar; }
      }
      p.naturalMh = mh;
      p.ar = ar;
    }
    for (const p of placements) {
      const groupDec = decisionsFor(p.item);
      const tKey = p.isHalf ? 'targetHHalf' : 'targetHFull';
      if (groupDec[tKey] == null || p.naturalMh < groupDec[tKey]) {
        groupDec[tKey] = p.naturalMh;
      }
    }
    for (const p of placements) {
      const groupDec = decisionsFor(p.item);
      const tKey = p.isHalf ? 'targetHHalf' : 'targetHFull';
      p.mh = groupDec[tKey];
      p.mw = p.mh * p.ar;
    }

    // Layout doubled pairs: each unit = label + labelGap + frame + image +
    // frame. Pack two units left-aligned with PAIR_INTER_GAP between them,
    // then center the whole pair on slotCenter. Eliminates the inside-gap
    // label collision that wide-aspect pairs otherwise produced.
    for (let i = 0; i + 1 < placements.length; i++) {
      const p = placements[i], q = placements[i + 1];
      if (p.pairId === undefined || p.pairId !== q.pairId) continue;
      const pDec = decisionsFor(p.item);
      const qDec = decisionsFor(q.item);
      const pExt = pDec.hasFrame ? pDec.frameT : 0;
      const qExt = qDec.hasFrame ? qDec.frameT : 0;
      const HALF_LABEL_GAP = 0.10;
      const u1 = p.mw + 2 * pExt + HALF_LABEL_GAP + PLACARD_W;
      const u2 = q.mw + 2 * qExt + HALF_LABEL_GAP + PLACARD_W;
      const total = u1 + PAIR_INTER_GAP + u2;
      const origin = p.pairCenter - total / 2;
      // The label sits at mesh-local +X = "smaller along" side of the
      // image, so within each unit the label comes first along the axis.
      // Image center = unit_left + PLACARD_W + labelGap + frameT + mw/2
      p.along = origin + PLACARD_W + HALF_LABEL_GAP + pExt + p.mw / 2;
      q.along = origin + u1 + PAIR_INTER_GAP + PLACARD_W + HALF_LABEL_GAP + qExt + q.mw / 2;
      i++; // skip the partner
    }

    for (const __placement of placements) {
      const { item, slotW, along, isHalf, pairSide, mw, mh, ar } = __placement;
      const groupDec = decisionsFor(item);
      const cy = surf.height < ROOM_H ? surf.height / 2 : MEDIA_BASE_HEIGHT;

      const px = surf.position.x + widthAxis.x * along;
      const pz = surf.position.z + widthAxis.z * along;

      // Push the canvas off the wall by a small gap so AO settles in the
      // crack between the back of the canvas and the wall.
      const WALL_GAP = 0.04;
      const offset = FRAME_DEPTH / 2 + WALL_GAP;
      const fx = px + surf.normal.x * offset;
      const fz = pz + surf.normal.z * offset;

      const sideMat  = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const frontMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      const boxMats  = [sideMat, sideMat, sideMat, sideMat, frontMat, sideMat];
      const boxGeom  = new THREE.BoxGeometry(mw, mh, FRAME_DEPTH);
      const mesh = new THREE.Mesh(boxGeom, boxMats);
      // Convert world XZ to group-local (group sits at (0,0,group.position.z))
      mesh.position.set(fx, cy, fz - group.position.z);
      mesh.lookAt(fx + surf.normal.x, cy, (fz - group.position.z) + surf.normal.z);
      mesh.userData.item = item;
      mesh.userData.fullLoaded = false;

      const mediaSize = Math.max(mw, mh);
      const forwardDist = 1.4 + mediaSize * 0.2;
      const headroom    = 0.5 + mediaSize * 0.4;
      mesh.userData.lightAnchor = new THREE.Vector3(
        fx + surf.normal.x * forwardDist,
        cy + mh / 2 + headroom,
        fz + surf.normal.z * forwardDist
      );
      mesh.userData.lightTarget   = new THREE.Vector3(fx, cy, fz);
      mesh.userData.lightAngle    = Math.min(Math.PI / 4, Math.atan2(mediaSize * 0.7, forwardDist));
      mesh.userData.lightDistance = 5 + mediaSize * 1.5;
      group.add(mesh);
      planes.push(mesh);
      artworks.push(mesh);

      // ---- Generative frame (50% of artworks get one) ----
      // Decision lives at the post-group level so a multi-image post reads
      // as a coherent set (same frame on every image, or none).
      if (groupDec.hasFrame) {
        const FRAME_T = groupDec.frameT;
        const FRAME_FWD = 0.015;                                  // protrudes 1.5cm forward of canvas
        const frameDepth = FRAME_DEPTH + FRAME_FWD;
        const frameZ = FRAME_FWD / 2;                             // back stays flush with canvas back
        const frameMat = new THREE.MeshStandardMaterial({
          color: groupDec.frameColor, roughness: 0.55, metalness: 0,
        });
        const horizGeomT = new THREE.BoxGeometry(mw + 2 * FRAME_T, FRAME_T, frameDepth);
        const horizGeomB = new THREE.BoxGeometry(mw + 2 * FRAME_T, FRAME_T, frameDepth);
        const vertGeomL  = new THREE.BoxGeometry(FRAME_T, mh, frameDepth);
        const vertGeomR  = new THREE.BoxGeometry(FRAME_T, mh, frameDepth);
        const fTop = new THREE.Mesh(horizGeomT, frameMat);
        const fBot = new THREE.Mesh(horizGeomB, frameMat);
        const fLft = new THREE.Mesh(vertGeomL,  frameMat);
        const fRgt = new THREE.Mesh(vertGeomR,  frameMat);
        const layoutFrame = (w, h) => {
          fTop.geometry.dispose();
          fBot.geometry.dispose();
          fLft.geometry.dispose();
          fRgt.geometry.dispose();
          fTop.geometry = new THREE.BoxGeometry(w + 2 * FRAME_T, FRAME_T, frameDepth);
          fBot.geometry = new THREE.BoxGeometry(w + 2 * FRAME_T, FRAME_T, frameDepth);
          fLft.geometry = new THREE.BoxGeometry(FRAME_T, h, frameDepth);
          fRgt.geometry = new THREE.BoxGeometry(FRAME_T, h, frameDepth);
          fTop.position.set(0,  h / 2 + FRAME_T / 2, frameZ);
          fBot.position.set(0, -h / 2 - FRAME_T / 2, frameZ);
          fLft.position.set(-w / 2 - FRAME_T / 2, 0, frameZ);
          fRgt.position.set( w / 2 + FRAME_T / 2, 0, frameZ);
        };
        layoutFrame(mw, mh);
        mesh.add(fTop, fBot, fLft, fRgt);
        mesh.userData.relayoutFrame = layoutFrame;
      }

      const applyMap = (tex) => {
        frontMat.map = tex;
        frontMat.color.setHex(0xffffff);
        frontMat.needsUpdate = true;
      };
      if (item.thumb) {
        loadImageTexture(item.thumb).then((tex) => {
          if (!tex) return;
          if (!mesh.parent) { tex.dispose(); return; } // room recycled mid-load
          applyMap(tex);
        });
      }
      let placard = null;

      if (item.type === 'video') {
        let activeTex = makeVideoTexture(item.full, mesh);
        const video = activeTex.image;
        const swap = () => applyMap(activeTex);
        // Prefer requestVideoFrameCallback so we don't apply the texture
        // until the browser has actually presented a decoded frame at its
        // final dimensions (loadeddata can fire before HLS has settled on
        // a variant).
        if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
          video.requestVideoFrameCallback(() => swap());
        } else if (video.readyState >= 2) {
          swap();
        } else {
          video.addEventListener('loadeddata', swap, { once: true });
        }
        // Bsky's declared aspectRatio is sometimes wrong (e.g. portrait video
        // tagged as landscape). Once the real video dimensions are known,
        // resize the box if it disagrees with what we built.
        video.addEventListener('loadedmetadata', () => {
          if (!mesh.parent) return; // recycled
          const vw = video.videoWidth, vh = video.videoHeight;
          if (!vw || !vh) return;
          const realAr = vw / vh;
          if (Math.abs(realAr - ar) < 0.05) return; // declared was close enough
          const slotMul = isHalf ? 0.6 : 0.8;
          let newW = Math.min(MEDIA_MAX_W, slotW * slotMul);
          let newH = newW / realAr;
          if (newH > MEDIA_MAX_H) {
            newH = MEDIA_MAX_H;
            newW = newH * realAr;
          }
          mesh.geometry.dispose();
          mesh.geometry = new THREE.BoxGeometry(newW, newH, FRAME_DEPTH);
          if (placard) {
            const _ext = groupDec.hasFrame ? groupDec.frameT : 0;
            const _gap = isHalf ? 0.10 : 0.16;
            placard.position.x = newW / 2 + _ext + PLACARD_W / 2 + _gap;
          }
          mesh.userData.relayoutFrame?.(newW, newH);
        });
        // Recreate the WebGPU VideoTexture only on a *real* dimension change
        // mid-playback (HLS variant switch). The initial 0→N metadata load
        // also fires `resize`, but at that point the texture hasn't been
        // allocated yet — Three.js will pick up the correct dimensions on
        // its first upload, and recreating here just races with that.
        let lastVideoSize = { w: 0, h: 0 };
        video.addEventListener('resize', () => {
          if (!mesh.parent) return; // recycled
          const w = video.videoWidth, h = video.videoHeight;
          if (lastVideoSize.w === 0 && lastVideoSize.h === 0) {
            lastVideoSize = { w, h };
            return; // first metadata load — let initial allocation handle it
          }
          if (w === lastVideoSize.w && h === lastVideoSize.h) return;
          lastVideoSize = { w, h };
          const old = activeTex;
          const fresh = new THREE.VideoTexture(video);
          fresh.colorSpace = THREE.SRGBColorSpace;
          fresh.minFilter = THREE.LinearFilter;
          fresh.magFilter = THREE.LinearFilter;
          fresh.generateMipmaps = false;
          activeTex = fresh;
          applyMap(fresh);
          old.dispose();
        });
        videoEntries.push({ video, mesh, tex: activeTex });
      }

      const placardTex = makePlacardTexture(item);
      const placardGeom = new THREE.PlaneGeometry(PLACARD_W, PLACARD_H);
      // Basic + toneMapped:false so the placard renders the canvas exactly
      // as drawn — IBL was making the light background hotter and the
      // tonemap was eroding the dark text.
      const placardMat = new THREE.MeshBasicMaterial({
        map: placardTex, toneMapped: false,
      });
      placard = new THREE.Mesh(placardGeom, placardMat);
      // Push the placard back to the wall surface (5mm proud to avoid z-
      // fighting). Local -Z is toward the wall — the artwork sits
      // WALL_GAP + FRAME_DEPTH/2 out from the wall, so we negate that.
      const frameSideExt = groupDec.hasFrame ? groupDec.frameT : 0;
      const labelGap = isHalf ? 0.10 : 0.16;
      placard.position.set(
        mw / 2 + frameSideExt + PLACARD_W / 2 + labelGap,
        0,
        -(WALL_GAP + FRAME_DEPTH / 2) + 0.005
      );
      placard.userData.item = item;
      placard.userData.isPlacard = true;
      mesh.add(placard);
      planes.push(placard);
    }
  }

  return { planes, artworks, itemsConsumed: idx };
}

function createGalleryManager(scene, paginator, initialItems, onCountChange, pbr) {
  scene.background = new THREE.Color(0x161616);
  const ambient = new THREE.AmbientLight(0xffffff, 1.8);
  scene.add(ambient);

  // PBR texture sets are loaded by init() and passed in so we can wait
  // for everything before showing the engage prompt.
  const { wallTex, floorTex } = pbr;
  const wallMat = new THREE.MeshStandardMaterial({
    map: wallTex.diff, normalMap: wallTex.norm, aoMap: wallTex.arm,
    aoMapIntensity: 0.5,
    roughnessMap: wallTex.arm, metalnessMap: wallTex.arm,
    metalness: 0, roughness: 1,
  });
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex.diff, normalMap: floorTex.norm, aoMap: floorTex.arm,
    roughnessMap: floorTex.arm, metalnessMap: floorTex.arm,
    metalness: 0, roughness: 1,
  });
  const ceilMat = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
  const mats = { wallMat, floorMat, ceilMat };

  // Feed buffer
  const feedItems = [...initialItems];
  let feedExhausted = paginator.isExhausted;
  let fetchInflight = null;

  function maybeFetch() {
    if (fetchInflight || feedExhausted) return;
    fetchInflight = paginator.fetchNextPage().then((more) => {
      feedItems.push(...more);
      feedExhausted = paginator.isExhausted;
      fetchInflight = null;
      onCountChange?.(feedItems.length, feedExhausted);
    }).catch((e) => {
      console.warn('paginator fetch failed', e);
      feedExhausted = true;
      fetchInflight = null;
    });
  }

  // Per-feedIdx metadata; persists across recycles so backward walks reuse
  // the same room geometry + items.
  const feedIdxMeta = new Map();
  function metaFor(feedIdx) {
    let m = feedIdxMeta.get(feedIdx);
    if (m) return m;
    const type = defaultRoomType(feedIdx);
    m = {
      type,
      partitionSide: type === 'big' ? bigPartitionSide(feedIdx) : null,
      openNorth: feedIdx > 0,
      openSouth: true,
      itemRange: null,
      isTerminal: false,
    };
    feedIdxMeta.set(feedIdx, m);
    return m;
  }

  // Z-position of a feedIdx's room center (sums depths of preceding rooms).
  function feedIdxCenterZ(feedIdx) {
    let z = 0;
    for (let i = 0; i < feedIdx; i++) z -= ROOM_DEPTHS[metaFor(i).type];
    return z - ROOM_DEPTHS[metaFor(feedIdx).type] / 2;
  }

  // Item allocation: each feedIdx gets a contiguous range of feedItems on
  // first build. The range is sticky so backward walks see the same items.
  function allocItemRangeStart() {
    let s = 0;
    for (const meta of feedIdxMeta.values()) {
      if (meta.itemRange && meta.itemRange.end > s) s = meta.itemRange.end;
    }
    return s;
  }

  // Mesh -> slot (for spotlight filtering and collision-free disposal)
  const slots = [];
  let currentSlotIdx = 1; // spawn in middle slot

  function teardownGroup(group, videoEntries) {
    scene.remove(group);
    group.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.userData?.skipGeomDispose) o.geometry?.dispose();
      const mlist = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mlist) {
        if (mat === wallMat || mat === floorMat || mat === ceilMat) continue;
        // skipMapDispose: textures shared with a GLB template (e.g. people)
        // — the template still owns them, don't free yet.
        if (mat.map && !mat.userData?.skipMapDispose) mat.map.dispose();
        mat.dispose();
      }
    });
    for (const e of videoEntries) {
      e.video.pause();
      e.video.remove();
      const gIdx = galleryVideos.findIndex((g) => g.video === e.video);
      if (gIdx >= 0) galleryVideos.splice(gIdx, 1);
    }
  }

  function disposeSlot(slot) {
    teardownGroup(slot.group, slot.videoEntries);
  }

  function buildSlot(feedIdx) {
    const m = metaFor(feedIdx);
    const groupZ = feedIdxCenterZ(feedIdx);
    const { group, surfaces, wallAABBs } = buildRoom({
      type: m.type,
      partitionSide: m.partitionSide,
      openNorth: m.openNorth,
      openSouth: m.openSouth,
      groupZ,
    }, mats);
    scene.add(group);

    if (!m.itemRange) {
      const start = allocItemRangeStart();
      m.itemRange = { start, end: start };
    }

    const videoEntries = [];
    const itemsForThis = feedItems.slice(m.itemRange.start);
    const pop = populateRoom(group, surfaces, itemsForThis, videoEntries);
    m.itemRange.end = m.itemRange.start + pop.itemsConsumed;
    for (const e of videoEntries) galleryVideos.push({ video: e.video, mesh: e.mesh });

    // If feed is exhausted and there isn't enough left for ANOTHER room,
    // this room becomes the terminal cap: forced-small, far wall solid.
    const remaining = feedItems.length - m.itemRange.end;
    if (feedExhausted && remaining < MIN_ROOM_ITEMS && m.openSouth) {
      teardownGroup(group, videoEntries);
      m.openSouth = false;
      m.isTerminal = true;
      m.type = 'small';
      m.partitionSide = null;
      m.itemRange = { start: m.itemRange.start, end: m.itemRange.start };
      return buildSlot(feedIdx);
    }

    const people = placePeopleInRoom(group, pop.artworks);

    return {
      feedIdx,
      group,
      planes: pop.planes,
      artworks: pop.artworks,
      videoEntries,
      people,
      wallAABBs,
      get type()    { return metaFor(feedIdx).type; },
      get d()       { return ROOM_DEPTHS[metaFor(feedIdx).type]; },
      get centerZ() { return group.position.z; },
      get terminal(){ return metaFor(feedIdx).isTerminal; },
    };
  }

  // Initial build: up to SLOT_COUNT slots, stopping if we hit the terminal.
  for (let i = 0; i < SLOT_COUNT; i++) {
    const s = buildSlot(i);
    slots.push(s);
    if (s.terminal) break;
  }
  // If the spawn slot index doesn't exist (e.g. degenerate empty feed),
  // clamp it. Spawn pos is z=-20 — middle of slot 1 normally.
  if (currentSlotIdx >= slots.length) currentSlotIdx = slots.length - 1;

  function ensurePrefetched() {
    const south = slots[slots.length - 1];
    const meta = feedIdxMeta.get(south.feedIdx);
    const itemEnd = meta?.itemRange?.end ?? 0;
    if (feedItems.length - itemEnd < PREFETCH_AHEAD) maybeFetch();
  }

  function recycleForward() {
    if (slots[slots.length - 1].terminal) return;
    const newFeedIdx = slots[slots.length - 1].feedIdx + 1;
    const oldNorth = slots.shift();
    disposeSlot(oldNorth);
    slots.push(buildSlot(newFeedIdx));
  }

  function recycleBackward() {
    const newFeedIdx = slots[0].feedIdx - 1;
    if (newFeedIdx < 0) return false;
    const oldSouth = slots.pop();
    disposeSlot(oldSouth);
    slots.unshift(buildSlot(newFeedIdx));
    return true;
  }

  function detectSlotIdx(camera) {
    const z = camera.position.z;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const halfD = s.d / 2;
      if (z <= s.centerZ + halfD && z >= s.centerZ - halfD) return i;
    }
    return -1;
  }

  const _personWorldPos = new THREE.Vector3();
  function updatePeopleFade(camera) {
    for (const slot of slots) {
      if (!slot.people) continue;
      for (const person of slot.people) {
        person.getWorldPosition(_personWorldPos);
        // Horizontal distance only — camera is at eye height (1.6m) and
        // people are at floor, so a constant y-offset would otherwise pad
        // the 3D distance and skew fade thresholds.
        const dx = camera.position.x - _personWorldPos.x;
        const dz = camera.position.z - _personWorldPos.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        let opacity;
        if (d <= PEOPLE_FADE_NEAR) opacity = 0;
        else if (d >= PEOPLE_FADE_FAR) opacity = 1;
        else {
          const t = (d - PEOPLE_FADE_NEAR) / (PEOPLE_FADE_FAR - PEOPLE_FADE_NEAR);
          opacity = t * t * (3 - 2 * t); // smoothstep
        }
        // Always update — the previous "skip if delta < 0.005" early-out
        // could lock a person at a near-zero opacity (e.g. 0.0018) when the
        // explicit branch tried to snap to 0, leaving a faint ghost.
        person.visible = opacity > 0.001;
        for (const m of person.userData.fadeMaterials) m.opacity = opacity;
      }
    }
  }

  function update(_dt, camera) {
    const newIdx = detectSlotIdx(camera);
    if (newIdx === -1) return;

    // Trigger zones: crossing into them recycles the trailing slot and
    // snaps the player back to the anchor (one room behind the trigger),
    // so voids past the loaded chain stay at least LOOKAHEAD/LOOKBEHIND
    // rooms away from the camera.
    const fwdTrigger  = slots.length - LOOKAHEAD;       // entering this idx (or higher) → recycle south
    const fwdAnchor   = fwdTrigger - 1;                  // post-recycle resting idx
    const backTrigger = LOOKBEHIND - 1;                  // entering this idx (or lower) → recycle north
    const backAnchor  = backTrigger + 1;

    if (newIdx >= fwdTrigger && currentSlotIdx < fwdTrigger) {
      if (!slots[slots.length - 1].terminal) {
        recycleForward();
        currentSlotIdx = fwdAnchor;
      } else {
        currentSlotIdx = newIdx;
      }
    } else if (newIdx <= backTrigger && currentSlotIdx > backTrigger) {
      const ok = recycleBackward();
      currentSlotIdx = ok ? backAnchor : newIdx;
    } else {
      currentSlotIdx = newIdx;
    }

    ensurePrefetched();
    updatePeopleFade(camera);
  }

  // Push the player out of any wall AABB they overlap with their radius.
  // Walks current ± 1 slots so wall sections at slot boundaries collide
  // correctly on either side.
  function collide(pos, radius) {
    const lo = Math.max(0, currentSlotIdx - 1);
    const hi = Math.min(slots.length - 1, currentSlotIdx + 1);
    for (let i = lo; i <= hi; i++) {
      const s = slots[i];
      if (!s.wallAABBs) continue;
      for (const a of s.wallAABBs) {
        const minX = a.minX - radius, maxX = a.maxX + radius;
        const minZ = a.minZ - radius, maxZ = a.maxZ + radius;
        if (pos.x <= minX || pos.x >= maxX || pos.z <= minZ || pos.z >= maxZ) continue;
        const penLeft  = pos.x - minX;
        const penRight = maxX - pos.x;
        const penFront = pos.z - minZ;
        const penBack  = maxZ - pos.z;
        const minPen = Math.min(penLeft, penRight, penFront, penBack);
        if      (minPen === penLeft)  pos.x = minX;
        else if (minPen === penRight) pos.x = maxX;
        else if (minPen === penFront) pos.z = minZ;
        else                          pos.z = maxZ;
      }
    }
  }

  return {
    get planes() {
      const out = [];
      for (const s of slots) for (const p of s.planes) out.push(p);
      return out;
    },
    get currentArtworks() {
      return slots[currentSlotIdx]?.artworks ?? [];
    },
    get currentGroup() {
      return slots[currentSlotIdx]?.group ?? null;
    },
    ambient,
    startPos: new THREE.Vector3(2.5, 1.6, -20),
    update,
    collide,
  };
}


// ---- Scene setup (shared by both modes) ----
// Initial render settings — DPR can be tweaked live; AA requires a reload
// because antialias is a constructor option on WebGPURenderer.
const _qs = new URL(window.location).searchParams;
const initialDPR = parseFloat(_qs.get('dpr')) || 1;
const initialAA  = _qs.get('aa') !== 'false';

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
  // GLB loads must complete before buildGallery runs (rooms reference them).
  await Promise.all([
    loadFrameTemplate().catch((e) => console.warn('Frame GLB load failed:', e)),
    loadPeopleTemplates().catch((e) => console.warn('People GLB load failed:', e)),
  ]);

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
  aoPass.distanceExponent.value = 0.7;
  aoPass.distanceFallOff.value  = 0.45;
  aoPass.radius.value     = 0.1;
  aoPass.scale.value      = 2.25;
  aoPass.thickness.value  = 1.4;

  const aoTexture = aoPass.getTextureNode();
  const denoisedAO = denoise(aoTexture, sceneDepth, sceneNormal, camera).r;
  const softenedAO = denoisedAO.pow(0.5);
  const composited = mix(sceneColor, sceneColor.mul(softenedAO), aoEnabled);

  const postProcessing = new THREE.RenderPipeline(renderer);
  postProcessing.outputNode = composited;

  // ---- IBL environment ----
  // PMREMGenerator stays alive so we can process HDRs on demand when the user
  // picks one from the GUI. Each environment is cached after first compute.
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const hdrLoader = new HDRLoader();
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

  // Wait for all heavy assets — env, PBR sets — before building the scene
  // so the user doesn't get dumped into a half-textured gallery.
  const DEFAULT_ENV = `${ASSET_BASE}hdr/studio_small_08_1k.hdr`;
  const [, wallTex, floorTex] = await Promise.all([
    applyEnv(DEFAULT_ENV),
    loadPBRSet(`${ASSET_BASE}textures/plastered_wall_04_1k/textures/plastered_wall_04`, 1),
    loadPBRSet(`${ASSET_BASE}textures/concrete_floor_worn_001_1k/textures/concrete_floor_worn_001`, 1),
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
  // Forward-renderer is unhappy with many lights, so we keep a fixed-size pool
  // of SpotLights and retarget them each frame to the nearest visible artworks.
  const lightSettings = {
    maxLights: 6,
    intensity: 12,
  };
  const toggles = {
    spotlights: false,
    gtao:       true,
    sound:      true,
    video:      true,
  };
  const AUDIO_FULL_DIST    = 1; // metres — full volume within this distance
  const AUDIO_SILENT_DIST  = 5; // metres — silent at or beyond this distance
  const _videoWorldPos = new THREE.Vector3();
  const _videoForward  = new THREE.Vector3();
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
      const gui = new GUI({ title: 'Render' });

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

      if (ambient) {
        gui.add(ambient, 'intensity', 0, 5, 0.05).name('Ambient');
      }
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
  }

  const LIGHT_LERP_RATE = 8; // ~125ms fade in/out

  function updateLightPool(dt) {
    if (lightPool.length === 0) return;

    // Gallery mode: only artworks in the room the player is currently in
    // are spotlight candidates. Carousel: use the full set.
    const candidates = MODE === 'gallery'
      ? built.currentArtworks
      : (built.artworks || []);
    // Proximity-only: nearest N artworks get lights, regardless of camera
    // facing. Avoids the pop-in/out at frustum edges, and "lights you can't
    // see" cost the same in the shader anyway.
    const visible = candidates.slice().sort((a, b) =>
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

  // ---- Ambient + footstep audio ----
  // Loaded eagerly; playback gated on engage click (browser autoplay policy).
  const ambienceAudio = new Audio(`${ASSET_BASE}sfx/ambience.mp3`);
  ambienceAudio.loop = true;
  ambienceAudio.volume = 0.25;
  const footstepsAudio = new Audio(`${ASSET_BASE}sfx/footsteps.mp3`);
  footstepsAudio.loop = true;
  // Start silent; volume lerps toward FOOTSTEPS_TARGET_VOL while moving.
  footstepsAudio.volume = 0;
  const FOOTSTEPS_TARGET_VOL = 0.5;
  const FOOTSTEPS_FADE_RATE  = 10; // ~100ms ramp

  const controls = new PointerLockControls(camera, renderer.domElement);
  // Only the engage prompt locks; clicks on the form/input do not.
  engagePrompt.addEventListener('click', () => controls.lock());
  let overlayFaded = false;
  controls.addEventListener('lock', () => {
    if (!overlayFaded) {
      overlayFaded = true;
      // Fade the black overlay to 0 over 0.7s, then take it out of layout.
      overlayEl.style.opacity = '0';
      setTimeout(() => { overlayEl.hidden = true; }, 350);
    } else {
      overlayEl.hidden = true;
    }
    if (toggles.sound) ambienceAudio.play().catch(() => {});
  });
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
    const hits = raycaster.intersectObjects(built.planes, false);
    if (hits.length) {
      const plane = hits[0].object;
      // Only the placard label opens the post; clicking the main image
      // does nothing so people can frame screenshots without an accidental tab.
      if (!plane.userData.isPlacard) return;
      const item = plane.userData.item;
      if (item?.postUrl) window.open(item.postUrl, '_blank', 'noopener');
    }
  });

  // ---- Stats (dev only) ----
  let stats = null;
  if (DEV_MODE) {
    stats = new Stats();
    stats.dom.style.cssText = 'position:fixed;top:0;left:0;z-index:1000;';
    document.body.appendChild(stats.dom);
  }

  const timer = new Timer();
  // Cap render to 60fps even on high-refresh-rate displays. Browsers RAF at the
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

    // Footsteps when moving + ambience while engaged. Both gated on the
    // sound toggle so muting also kills these.
    const moving = controls.isLocked && (keys.w || keys.s || keys.a || keys.d);
    if (toggles.sound) {
      if (controls.isLocked && ambienceAudio.paused) ambienceAudio.play().catch(() => {});
      // Lerp footsteps volume toward target so start/stop is a quick fade.
      const targetVol = moving ? FOOTSTEPS_TARGET_VOL : 0;
      const k = Math.min(1, dt * FOOTSTEPS_FADE_RATE);
      footstepsAudio.volume += (targetVol - footstepsAudio.volume) * k;
      if (footstepsAudio.volume > 0.01) {
        if (footstepsAudio.paused) footstepsAudio.play().catch(() => {});
      } else if (!footstepsAudio.paused) {
        footstepsAudio.pause();
      }
    } else {
      if (!ambienceAudio.paused) ambienceAudio.pause();
      if (!footstepsAudio.paused) footstepsAudio.pause();
      footstepsAudio.volume = 0;
    }

    // Per-video volume falloff. Browsers block unmuted autoplay until a user
    // gesture, so once you've engaged (clicked) the videos can sound.
    // Also: pause videos that aren't in the current room — HLS decode is
    // expensive and the player can't see them.
    if (galleryVideos.length) {
      const currentGroup = MODE === 'gallery' ? built.currentGroup : null;
      for (const { video, mesh } of galleryVideos) {
        const inCurrent = MODE !== 'gallery' || mesh.parent === currentGroup;
        if (inCurrent && toggles.video) {
          if (video.paused) video.play().catch(() => {});
          if (toggles.sound) {
            mesh.getWorldPosition(_videoWorldPos);
            // Mute when the camera is behind the video plane (not looking
            // at the front face) — otherwise a piece on the back of a
            // partition can leak audio through the wall.
            mesh.getWorldDirection(_videoForward);
            const fx = camera.position.x - _videoWorldPos.x;
            const fz = camera.position.z - _videoWorldPos.z;
            const inFront = (_videoForward.x * fx + _videoForward.z * fz) > 0;
            const d = camera.position.distanceTo(_videoWorldPos);
            const vol = !inFront ? 0 : Math.max(0, Math.min(1,
              1 - (d - AUDIO_FULL_DIST) / (AUDIO_SILENT_DIST - AUDIO_FULL_DIST)
            ));
            if (vol > 0) {
              if (video.muted) video.muted = false;
              video.volume = vol;
            } else if (!video.muted) {
              video.muted = true;
            }
          } else if (!video.muted) {
            video.muted = true;
          }
        } else {
          if (!video.paused) video.pause();
          if (!video.muted) video.muted = true;
        }
      }
    }

    postProcessing.render();
    stats?.update();
  }
  animate(0);

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
    // Gallery: ~12 items per room × SLOT_COUNT, with margin so initial slots
    // all get fully populated before async paginator catches up.
    const minCount = MODE === 'carousel' ? MAX_ITEMS : 70;
    const { paginator, items } = await fetchInitialMedia(source, minCount);
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
    const titleEl = overlayEl.querySelector('h1');
    if (titleEl) titleEl.hidden = true;
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
// We pre-fill the input but don't auto-load — user clicks Go to start.
(() => {
  const initial = new URL(window.location).searchParams.get('handle');
  if (initial) handleInput.value = initial;
  handleInput.focus();
})();
