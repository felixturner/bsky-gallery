// The gallery's brain: a sliding window of N rooms along -Z that recycles
// in/out as the player crosses doorways. Owns scene materials, the feed
// buffer + paginator, slot allocation, item-range bookkeeping for backwards
// walks, and the per-frame `update` / `collide` API.

import * as THREE from 'three/webgpu';
import {
  ROOM_DEPTHS, ROOM_H,
  defaultRoomType, bigPartitionSide, buildRoom,
} from './room-builder.js';
import { placePeopleInRoom, PEOPLE_FADE_NEAR, PEOPLE_FADE_FAR } from './people.js';
import { loadImageTexture, makeVideoTexture, galleryVideos } from './textures.js';
import { makePlacardTexture, PLACARD_PX_W, PLACARD_PX_H } from './placard.js';

// ---- Layout / treadmill config ----
const SLOT_COUNT = 5;
// Recycle bookkeeping: keep at least LOOKAHEAD rooms south of the player and
// LOOKBEHIND north of them. Crossing into the trigger zone recycles the
// trailing slot to the leading end and snaps currentSlotIdx back to the
// anchor (slots.length - 1 - LOOKAHEAD), so voids past the loaded chain are
// always at least LOOKAHEAD rooms away from the camera.
const LOOKAHEAD  = 2;
const LOOKBEHIND = 2;
const MIN_ROOM_ITEMS = 5;     // remaining-items threshold below which the next room becomes terminal
const PREFETCH_AHEAD = 30;    // when buffer ahead drops below this, fetch a new page

// ---- Media sizing ----
const MEDIA_BASE_HEIGHT = 1.6;
const MEDIA_MAX_W = 2.8;
const MEDIA_MAX_H = 2.6;
const FRAME_DEPTH = 0.06;
const WALL_GAP    = 0.04;     // distance from canvas back to wall surface

// ---- Doubled pair / placard layout ----
const DOUBLE_PROBABILITY = 0.18;  // chance a slot becomes a doubled pair
const HALF_LABEL_PAD     = 0.10;  // base label pad for half pieces
const FULL_LABEL_PAD     = 0.16;  // label pad for full-slot pieces
const PLACARD_W          = 0.32;  // world-space placard width (square ratio comes from PLACARD_PX_*)
const PLACARD_H          = PLACARD_W * (PLACARD_PX_H / PLACARD_PX_W);

// ---- Frame defaults ----
const FRAME_FWD_PROTRUDE = 0.015; // frame protrudes this far forward of canvas
const FRAME_T_MIN = 0.04;
const FRAME_T_MAX = 0.08;
const FRAME_COLOR_LIGHT = 0xbbbbbb;
const FRAME_COLOR_DARK  = 0x111111;

// ---- People fade smoothing ----
const _personWorldPos = new THREE.Vector3();

// Shared unit-cube geometry for every artwork frame box across the entire
// scene. Each frame mesh just sets its own scale, so adding/removing frames
// during room recycle is a single Vector3.set instead of building +
// disposing 4 BoxGeometry objects per artwork.
const _FRAME_BOX_GEOM = new THREE.BoxGeometry(1, 1, 1);

// Hang media on the supplied surfaces. Items are pulled from `items` starting
// at index 0 (caller slices). Artwork meshes are parented to `group`. Spotlight
// anchors are stored in WORLD coords on the mesh — valid until the room is
// disposed (rooms don't move once positioned).
function populateRoom(group, surfaces, items, videoEntries) {
  const planes = [];
  const artworks = [];
  let idx = 0;

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
        frameColor:  Math.random() < 0.5 ? FRAME_COLOR_LIGHT : FRAME_COLOR_DARK,
        frameT:      FRAME_T_MIN + Math.random() * (FRAME_T_MAX - FRAME_T_MIN),
        // Separate target heights per slot type — a multi-image post can
        // straddle full and half slots; we don't want a small first sibling
        // to shrink larger ones (or vice-versa).
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

    // ---- Pass 1: build placements (singles use slot center; doubled get
    //              along set later by the pair-layout pass after sizes).
    const placements = [];
    let pairCounter = 0;
    for (let k = 0; k < N && idx < items.length; k++) {
      const remaining = items.length - idx;
      const slotCenter = startOffset + k * slot;
      // Partition surfaces (shorter than ROOM_H) have narrow slots — labels
      // get squeezed even with the centred-pair layout, so skip doubling.
      const isPartition = surf.height < ROOM_H;
      const doubleUp = !isPartition && remaining >= 2 && Math.random() < DOUBLE_PROBABILITY;
      if (doubleUp) {
        const pid = pairCounter++;
        placements.push({ item: items[idx++], slotW: slot / 2, along: 0, isHalf: true, pairSide: 'left',  pairId: pid, pairCenter: slotCenter });
        placements.push({ item: items[idx++], slotW: slot / 2, along: 0, isHalf: true, pairSide: 'right', pairId: pid, pairCenter: slotCenter });
      } else {
        placements.push({ item: items[idx++], slotW: slot, along: slotCenter, isHalf: false });
      }
    }

    // ---- Pass 2: per-placement natural max height in its own slot.
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
    // ---- Pass 3: per group, target height = min of members' naturals (per
    //              slot type), so multi-image sets stay uniform.
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

    // ---- Pass 4: pack doubled pairs left-aligned with 2× pad on the inside
    //              gap (image1 frame → central label) and 1× pad on the
    //              other side (label → image2 frame). Whole pair centred on
    //              slotCenter.
    for (let i = 0; i + 1 < placements.length; i++) {
      const p = placements[i], q = placements[i + 1];
      if (p.pairId === undefined || p.pairId !== q.pairId) continue;
      const pDec = decisionsFor(p.item);
      const qDec = decisionsFor(q.item);
      const pExt = pDec.hasFrame ? pDec.frameT : 0;
      const qExt = qDec.hasFrame ? qDec.frameT : 0;
      const interUnitPad = HALF_LABEL_PAD * 2;
      const u1 = p.mw + 2 * pExt + HALF_LABEL_PAD + PLACARD_W;
      const u2 = q.mw + 2 * qExt + HALF_LABEL_PAD + PLACARD_W;
      const total = u1 + interUnitPad + u2;
      const origin = p.pairCenter - total / 2;
      p.along = origin + PLACARD_W + HALF_LABEL_PAD + pExt + p.mw / 2;
      q.along = origin + u1 + interUnitPad + PLACARD_W + HALF_LABEL_PAD + qExt + q.mw / 2;
      i++; // skip the partner
    }

    // ---- Pass 5: build geometry per placement.
    for (const p of placements) {
      const { item, slotW, along, isHalf, mw, mh, ar } = p;
      const groupDec = decisionsFor(item);
      const cy = surf.height < ROOM_H ? surf.height / 2 : MEDIA_BASE_HEIGHT;

      // World-space placement on the wall surface, then offset out by
      // FRAME_DEPTH/2 + WALL_GAP so AO can settle in the back-of-canvas crack.
      const px = surf.position.x + widthAxis.x * along;
      const pz = surf.position.z + widthAxis.z * along;
      const offset = FRAME_DEPTH / 2 + WALL_GAP;
      const fx = px + surf.normal.x * offset;
      const fz = pz + surf.normal.z * offset;

      // Box: side faces use a Lambert white that catches the spotlights;
      // the front face uses Basic so the image renders at exact texture
      // values regardless of lighting.
      const sideMat  = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const frontMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      const boxMats  = [sideMat, sideMat, sideMat, sideMat, frontMat, sideMat];
      const boxGeom  = new THREE.BoxGeometry(mw, mh, FRAME_DEPTH);
      const mesh = new THREE.Mesh(boxGeom, boxMats);
      // Mesh's parent is `group` (positioned at world (0,0,group.position.z));
      // convert world XZ to group-local. lookAt then orients the front face
      // toward the surface normal.
      mesh.position.set(fx, cy, fz - group.position.z);
      mesh.lookAt(fx + surf.normal.x, cy, (fz - group.position.z) + surf.normal.z);
      mesh.userData.item = item;

      // Spotlight anchor + target stored in WORLD coords. lightAnchor sits
      // forward of and above the artwork; lightTarget is the surface centre.
      // Cone angle and distance scale with media size so a halo fits.
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

      // ---- Generative frame (50% of art; videos always; per-group). ----
      // 4 boxes around the canvas, slightly thicker depth than the canvas
      // so the frame protrudes forward with a small overhang outward.
      if (groupDec.hasFrame) {
        const FRAME_T = groupDec.frameT;
        const frameDepth = FRAME_DEPTH + FRAME_FWD_PROTRUDE;
        const frameZ = FRAME_FWD_PROTRUDE / 2; // back stays flush with canvas back
        const frameMat = new THREE.MeshStandardMaterial({
          color: groupDec.frameColor, roughness: 0.55, metalness: 0,
        });
        // Reuse a single shared unit cube — each frame mesh just scales it.
        // skipGeomDispose so room teardown doesn't free the shared buffer.
        const fTop = new THREE.Mesh(_FRAME_BOX_GEOM, frameMat);
        const fBot = new THREE.Mesh(_FRAME_BOX_GEOM, frameMat);
        const fLft = new THREE.Mesh(_FRAME_BOX_GEOM, frameMat);
        const fRgt = new THREE.Mesh(_FRAME_BOX_GEOM, frameMat);
        for (const f of [fTop, fBot, fLft, fRgt]) f.userData.skipGeomDispose = true;
        const layoutFrame = (w, h) => {
          fTop.scale.set(w + 2 * FRAME_T, FRAME_T, frameDepth);
          fBot.scale.set(w + 2 * FRAME_T, FRAME_T, frameDepth);
          fLft.scale.set(FRAME_T, h, frameDepth);
          fRgt.scale.set(FRAME_T, h, frameDepth);
          fTop.position.set(0,  h / 2 + FRAME_T / 2, frameZ);
          fBot.position.set(0, -h / 2 - FRAME_T / 2, frameZ);
          fLft.position.set(-w / 2 - FRAME_T / 2, 0, frameZ);
          fRgt.position.set( w / 2 + FRAME_T / 2, 0, frameZ);
        };
        layoutFrame(mw, mh);
        mesh.add(fTop, fBot, fLft, fRgt);
        mesh.userData.relayoutFrame = layoutFrame;
      }

      // ---- Texture on the front face: thumb first (loads fast), then
      //      either the full image or the video texture. ----
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
      let placard = null; // forward-declared for video resize handler

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
        // Bsky's declared aspectRatio is sometimes wrong (e.g. portrait
        // video tagged as landscape). Once the real dimensions are known,
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
            const _gap = isHalf ? HALF_LABEL_PAD : FULL_LABEL_PAD;
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

      // ---- Placard (basic mat, toneMapped:false so canvas pixels render
      //      exactly — IBL+tonemap was eroding the dark text).
      const placardTex = makePlacardTexture(item);
      const placardMat = new THREE.MeshBasicMaterial({ map: placardTex, toneMapped: false });
      placard = new THREE.Mesh(new THREE.PlaneGeometry(PLACARD_W, PLACARD_H), placardMat);
      const frameSideExt = groupDec.hasFrame ? groupDec.frameT : 0;
      const labelGap = isHalf ? HALF_LABEL_PAD : FULL_LABEL_PAD;
      // Push the placard back to the wall surface (5mm proud to avoid
      // z-fighting). Local -Z is toward the wall — the artwork sits
      // WALL_GAP + FRAME_DEPTH/2 out from the wall, so we negate that.
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

export function createGalleryManager(scene, paginator, initialItems, onCountChange, pbr) {
  scene.background = new THREE.Color(0x161616);
  const ambient = new THREE.AmbientLight(0xffffff, 1.8);
  scene.add(ambient);

  // PBR texture sets are loaded by init() and passed in so we can wait for
  // everything before showing the engage prompt.
  const { wallTex, floorTex } = pbr;
  const wallMat = new THREE.MeshStandardMaterial({
    map: wallTex.diff, normalMap: wallTex.norm, aoMap: wallTex.arm,
    aoMapIntensity: 0.5,
    roughnessMap: wallTex.arm, metalnessMap: wallTex.arm,
    metalness: 0, roughness: 1,
  });
  // 1.2× brightness multiplier on the diffuse map (THREE.Color isn't clamped
  // to [0,1], so values >1 brighten in linear space).
  wallMat.color.setRGB(1.2, 1.2, 1.2);
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex.diff, normalMap: floorTex.norm, aoMap: floorTex.arm,
    roughnessMap: floorTex.arm, metalnessMap: floorTex.arm,
    metalness: 0, roughness: 1,
  });
  const ceilMat = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
  const mats = { wallMat, floorMat, ceilMat };

  // ---- Feed buffer + paginator ----
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

  // ---- Per-feedIdx metadata. Persists across recycles so backward walks
  //      reuse the same room geometry + items. ----
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

  // ---- Initial build: up to SLOT_COUNT slots, stopping if we hit the cap ----
  for (let i = 0; i < SLOT_COUNT; i++) {
    const s = buildSlot(i);
    slots.push(s);
    if (s.terminal) break;
  }
  // If the spawn slot index doesn't exist (degenerate empty feed), clamp.
  // Spawn pos is z=-20 — middle of slot 1 normally.
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
    disposeSlot(slots.shift());
    slots.push(buildSlot(newFeedIdx));
  }
  function recycleBackward() {
    const newFeedIdx = slots[0].feedIdx - 1;
    if (newFeedIdx < 0) return false;
    disposeSlot(slots.pop());
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
    const fwdTrigger  = slots.length - LOOKAHEAD;
    const fwdAnchor   = fwdTrigger - 1;
    const backTrigger = LOOKBEHIND - 1;
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
    // Current + adjacent (±1) slot groups. Used by the video/audio loop:
    // videos in active rooms keep playing/decoding so re-entry is instant;
    // far rooms get fully paused to save HLS decode CPU.
    get activeGroups() {
      const out = new Set();
      const lo = Math.max(0, currentSlotIdx - 1);
      const hi = Math.min(slots.length - 1, currentSlotIdx + 1);
      for (let i = lo; i <= hi; i++) out.add(slots[i].group);
      return out;
    },
    ambient,
    startPos: new THREE.Vector3(2.5, 1.6, -20),
    update,
    collide,
  };
}
