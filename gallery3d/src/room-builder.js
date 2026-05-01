// Room geometry: one self-contained THREE.Group per room with its own
// floor/ceiling/walls/partition. Returns the surfaces (positions where
// media gets hung) and AABBs (for player collision) in world coords.

import * as THREE from 'three/webgpu';

// Room is 14m wide; depth varies by type. ROOM_H + ROOM_DEPTHS are also
// referenced by gallery-manager (slot positioning, in-room cy fallback).
const ROOM_W = 14;
export const ROOM_H = 5;
export const ROOM_DEPTHS = { small: 12, big: 16 };

const DOOR_W = 2.6;
const DOOR_H = 3.2;
const WALL_T = 0.2;
const WALL_LIFT   = 0.02; // bottom of walls sits this far above the floor; same gap above
const WALL_TILE_M  = 3.5; // 1 wall tile per N metres
const FLOOR_TILE_M = 1.0; // 1 floor tile per N metres
const PART_H = 3.4;       // partition height
const PART_T = 0.18;      // partition thickness

export function defaultRoomType(feedIdx) {
  return feedIdx % 2 === 0 ? 'small' : 'big';
}

// Big rooms appear at feedIdx 1, 3, 5, … — alternate which side the
// jutting partition sits on so consecutive big rooms feel different.
export function bigPartitionSide(feedIdx) {
  return ((feedIdx - 1) / 2) % 2 === 0 ? 'left' : 'right';
}

// UV-tiled box: stretches each face's UV so the texture tiles at a constant
// world-space density (one tile per `tileM` metres) regardless of mesh size.
function makeRoomBox(parent, w, h, d, x, y, z, mat, tileM) {
  const geom = new THREE.BoxGeometry(w, h, d);
  if (tileM) {
    const uv = geom.attributes.uv.array;
    // BoxGeometry face order: ±X, ±Y, ±Z. Each face has its own UV span.
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
  parent.add(m);
  return m;
}

// Build a room as a self-contained Group whose center sits at (0,0,groupZ).
// All walls are owned per-room: adjacent rooms have their walls back-to-back
// (~2*WALL_T thick total), no z-fighting and trivial disposal on recycle.
// Returned surface positions are in WORLD coords (groupZ already baked in)
// since populateRoom consumes them as world-space anchors.
export function buildRoom({ type, partitionSide, openNorth, openSouth, groupZ }, mats) {
  const { wallMat, floorMat, ceilMat } = mats;
  const d = ROOM_DEPTHS[type];

  const group = new THREE.Group();
  group.position.set(0, 0, groupZ);
  const surfaces = [];
  // World-space X/Z bounds of every wall section, used for player collision.
  const wallAABBs = [];
  const pushAABB = (centerX, centerZ, w, dz) => {
    wallAABBs.push({
      minX: centerX - w / 2, maxX: centerX + w / 2,
      minZ: centerZ - dz / 2, maxZ: centerZ + dz / 2,
    });
  };

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
  const addEndWall = (localZ, sNormal, hasDoor) => {
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
  };
  // North = +d/2 (toward zCursor=0); inside-facing surface points -Z (sNormal=-1).
  addEndWall(+d / 2, -1, openNorth);
  addEndWall(-d / 2, +1, openSouth);

  // Partition wall — small rooms get the wide cross partition; big rooms get
  // a side-jutting one whose side alternates by feedIdx.
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
