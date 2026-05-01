// Legacy "carousel" mode — planes arranged on a circle around the player,
// activated via ?mode=carousel. Kept as a comparison layout to the gallery.

import * as THREE from 'three/webgpu';
import { loadImageTexture, makeVideoTexture } from './textures.js';

const PLANE_WIDTH = 4;
const PLANE_GAP   = 1.5;

export function buildCarousel(scene, items) {
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

    const material = new THREE.MeshBasicMaterial({
      color: 0x222222,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    mesh.position.set(Math.cos(angle) * RADIUS, 0, Math.sin(angle) * RADIUS);
    mesh.lookAt(0, 0, 0);
    mesh.userData.item = item;
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
