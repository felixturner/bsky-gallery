// Three.js texture helpers — image loading, video texture w/ HLS, PBR sets.
// Module-level state: a shared galleryVideos array (so the main animate loop
// can manage volume + play state per frame) and a configurable max
// anisotropy (set after the renderer is up).

import * as THREE from 'three/webgpu';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import Hls from 'hls.js';

const _texLoader = new THREE.TextureLoader();
const _exrLoader = new EXRLoader();

let _maxAniso = 8;
export function setMaxAniso(v) { _maxAniso = v; }

// Track all <video> elements created in the scene + the mesh each belongs to
// so the main animate loop can manage volume + play state per frame, and
// gallery teardown can pull them out of the DOM cleanly.
export const galleryVideos = [];

// Shared "Out on Loan" placeholder used when a thumb fails to load.
// Dark museum-card aesthetic with centred italic text. Marked
// skipMapDispose so consumers' teardown paths don't free it.
let _fallbackTex = null;
function getFallbackTexture() {
  if (_fallbackTex) return _fallbackTex;
  const W = 720, H = 540;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#eeeeee';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#999';
  ctx.font = 'italic 600 64px Fraunces, Georgia, serif';
  ctx.fillText('Out on Loan', W / 2, H / 2);
  _fallbackTex = new THREE.CanvasTexture(canvas);
  _fallbackTex.colorSpace = THREE.SRGBColorSpace;
  _fallbackTex.minFilter = THREE.LinearFilter;
  _fallbackTex.magFilter = THREE.LinearFilter;
  _fallbackTex.needsUpdate = true;
  _fallbackTex.userData.skipMapDispose = true;
  return _fallbackTex;
}

export function loadImageTexture(url) {
  return new Promise((resolve) => {
    _texLoader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        resolve(tex);
      },
      undefined,
      () => {
        // Failed to load — hand back the shared "missing image" texture
        // so the artwork shows a placeholder instead of staying white.
        resolve(getFallbackTexture());
      }
    );
  });
}

export function makeVideoTexture(playlistUrl, mesh) {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.autoplay = true;
  video.preload = 'auto';
  // Offscreen at intrinsic size — the 1px×1px sizing that used to be here can
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
    // Stash the instance so teardown can call hls.destroy() and free the
    // worker + MSE buffers (otherwise GC can't reclaim the chain).
    video._hls = hls;
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

// PolyHaven-style PBR set: diffuse JPEG, ARM (AO/Roughness/Metalness packed
// into one JPEG; Three samples the right channel per slot when the same
// texture is assigned to aoMap / roughnessMap / metalnessMap), and an EXR
// normal map (which doesn't auto-mipmap, so we enable it explicitly).
export async function loadPBRSet(prefix, repeat = 2) {
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
