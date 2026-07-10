// People characters loaded from a single GLB. We pick a random subset of
// templates per page-load, clone them per room, and fade them out as the
// camera approaches.

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const ASSET_BASE = import.meta.env.BASE_URL;

export const PEOPLE_FADE_NEAR = 2.0; // fully invisible at this camera distance
export const PEOPLE_FADE_FAR  = 4.0; // fully visible beyond this distance

const PEOPLE_PER_ROOM = 2;
const PEOPLE_STANDOFF = 2.0;         // metres in front of the artwork
const TEMPLATE_PICK   = 10;          // random subset of GLB children per load
const PERSON_SCALE    = 0.2;
const PERSON_TINT     = 0x252525;

// Each top-level child of people.glb is treated as one person template; we
// clone TEMPLATE_PICK random ones per page load.
let peopleTemplates = null;

export async function loadPeopleTemplates() {
  if (peopleTemplates !== null) return peopleTemplates;
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(`${ASSET_BASE}models/people.glb`);
  if (gltf.scene.children.length === 0) {
    peopleTemplates = [gltf.scene];
  } else {
    // Fisher-Yates shuffle, then take TEMPLATE_PICK
    const all = gltf.scene.children.slice();
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    peopleTemplates = all.slice(0, TEMPLATE_PICK);
  }
  return peopleTemplates;
}

// Place PEOPLE_PER_ROOM cloned people in front of random artworks.
// Materials are cloned per-instance so opacity is independent; geometries
// stay shared with the GLB template (marked skipGeomDispose so disposal
// doesn't free them, which would invalidate every other clone).
export function placePeopleInRoom(group, artworks) {
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
    // The GLB lays the templates out in a row (node translations
    // [0,0,0], [10,0,0], [20,0,0], …). Clone() preserves the node's
    // translation, so without this each clone lands far from the wrapper.
    inner.position.set(0, 0, 0);
    inner.scale.setScalar(PERSON_SCALE);
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
        if (c.color) c.color.setHex(PERSON_TINT);
        c.userData.skipMapDispose = true;
        fadeMaterials.push(c);
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(wrapMat) : wrapMat(o.material);
    });
    person.userData.fadeMaterials = fadeMaterials;

    // Use faceNormal to position the person in front of the artwork.
    const artPos = art.getWorldPosition(new THREE.Vector3());
    const faceNormal = art.userData.faceNormal;
    if (!faceNormal) continue;
    const forward = faceNormal.clone();
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
