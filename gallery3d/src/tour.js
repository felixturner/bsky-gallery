// Mobile guided tour. Drives the camera between artworks on Next/Back:
//   1. standoffFor() — where to stand so the piece fills ~80% of the viewport
//      (derived from the camera's vertical FOV + aspect), squarely in front.
//   2. planPath() — A* on a grid rasterised from the room's wall AABBs, so the
//      walk routes through doorways and never clips a wall or partition.
//   3. update() — glide along the (line-of-sight-smoothed) path, then ease into
//      a locked framing facing the piece.
// Desktop keeps WASD / pointer-lock; this only runs when the buttons UI is on.

import * as THREE from 'three/webgpu';

const PLAYER_RADIUS = 0.35;   // how far walls are inflated for clearance
const CELL          = 0.4;    // A* grid cell size (m)
const GRID_MARGIN   = 6;      // padding around start/goal so corridors fit
const DOOR_CORRIDOR = 3;      // always keep the central doorway corridor (x≈0) in-grid
const FIT_FRACTION  = 0.8;    // artwork fills this fraction of the viewport
const MIN_STANDOFF  = 1.2;
const MAX_STANDOFF  = 7;
const WALK_SPEED    = 2.8;    // m/s along the path
const TURN_SPEED    = 1.6;    // rad/s — caps how fast the framing rotates
const MIN_DURATION  = 0.7;    // s floor so short hops ease instead of snapping
const RETREAT       = 0.7;    // m the camera bows backward at mid-walk
const EYE_HEIGHT    = 1.6;

export function createTour({ camera, built }) {
  const _wp = new THREE.Vector3();
  let path = null;          // polyline waypoints (THREE.Vector3, y unused)
  let segLens = [];         // per-segment lengths, parallel to `path`
  let total = 0;            // total path length (m)
  let targetMesh = null;    // artwork we're heading to (held for the whole glide)
  const finalPos  = new THREE.Vector3();
  const finalLook = new THREE.Vector3();
  const bowN      = new THREE.Vector3(); // room-ward normal for the retreat bow
  let phase = 'idle';       // 'idle' | 'glide' | 'tween'
  let progress = 0;         // 0..1 along the current glide/tween
  let duration = 1;         // seconds for the current glide/tween
  let startY = EYE_HEIGHT;
  const startQuat    = new THREE.Quaternion();
  const endQuat      = new THREE.Quaternion();
  const corridorQuat = new THREE.Quaternion(); // level look straight down the doorway
  let crossRoom = false;        // is this glide a room-to-room step?
  let roomCenterZ = null;       // centre Z of the room we're currently parked in
  const _m   = new THREE.Matrix4();
  const _p   = new THREE.Vector3();
  const _eye = new THREE.Vector3();
  const _tgt = new THREE.Vector3();

  // Parked state — set when a glide or tween completes.
  let parkedMesh  = null;   // the artwork mesh we're standing in front of
  let parkedLevel = null;   // 'near' | 'close' | 'placard'
  // Tween state — simple pos+rot lerp with no pathfinding.
  const tweenStartPos = new THREE.Vector3();
  let tweenMesh  = null;    // artwork mesh to record as parkedMesh on completion
  let tweenLevel = null;    // parkedLevel to record on completion

  // Distance at which `mesh` fills FIT_FRACTION of the viewport, and the pose
  // to view it from (camera at the artwork's centre height, looking level).
  // level='near'  → max(dv,dh): image fits entirely in the viewport.
  // level='close' → min(dv,dh): image fills the viewport in the smaller dim,
  //                 cropping slightly in the larger — the "other" dim is filled.
  // nOverride lets callers supply a face normal when the mesh lacks one (placard).
  function standoffFor(mesh, level = 'near', nOverride = null) {
    const wp = mesh.getWorldPosition(_wp);
    const n  = nOverride ?? mesh.userData.faceNormal;
    const mw = mesh.geometry.parameters?.width  ?? 1.5;
    const mh = mesh.geometry.parameters?.height ?? 1.5;
    const tanV = Math.tan((camera.fov * Math.PI / 180) / 2);
    const tanH = camera.aspect * tanV;
    const dv = (mh / 2) / tanV / FIT_FRACTION;
    const dh = (mw / 2) / tanH / FIT_FRACTION;
    const rawDist = level === 'close' ? Math.min(dv, dh) : Math.max(dv, dh);
    const dist = Math.min(MAX_STANDOFF, Math.max(MIN_STANDOFF, rawDist));
    finalPos.set(wp.x + n.x * dist, wp.y, wp.z + n.z * dist);
    built.collide?.(finalPos, PLAYER_RADIUS);
    finalLook.copy(wp);
  }

  // Kick off a simple position+rotation tween (no pathfinding). Assumes
  // standoffFor() has already written finalPos / finalLook.
  function startTween(artworkMesh, level) {
    tweenMesh  = artworkMesh;
    tweenLevel = level;
    tweenStartPos.copy(camera.position);
    startQuat.copy(camera.quaternion);
    _m.lookAt(finalPos, finalLook, camera.up);
    endQuat.setFromRotationMatrix(_m);
    duration = 0.35;
    progress = 0;
    phase = 'tween';
  }

  // ---- A* over a uniform grid rasterised from wall AABBs ----
  function planPath(fromX, fromZ, toX, toZ) {
    // Rooms stack along Z with their doorways on the centreline (x≈0), so the
    // grid must always include that corridor or a cross-room route can't find
    // the door. Clamp the x-range to cover the centre and use EVERY loaded
    // room's walls so multi-room routes have complete data.
    const minX = Math.min(fromX, toX, -DOOR_CORRIDOR) - GRID_MARGIN;
    const maxX = Math.max(fromX, toX,  DOOR_CORRIDOR) + GRID_MARGIN;
    const minZ = Math.min(fromZ, toZ) - GRID_MARGIN;
    const maxZ = Math.max(fromZ, toZ) + GRID_MARGIN;
    const cols = Math.max(1, Math.ceil((maxX - minX) / CELL));
    const rows = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
    const aabbs = built.allWallAABBs;

    const cellX = (c) => minX + (c + 0.5) * CELL;
    const cellZ = (r) => minZ + (r + 0.5) * CELL;
    const blocked = (c, r) => {
      const x = cellX(c), z = cellZ(r);
      for (const a of aabbs) {
        if (x >= a.minX - PLAYER_RADIUS && x <= a.maxX + PLAYER_RADIUS &&
            z >= a.minZ - PLAYER_RADIUS && z <= a.maxZ + PLAYER_RADIUS) return true;
      }
      return false;
    };
    const toC = (x) => Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / CELL)));
    const toR = (z) => Math.min(rows - 1, Math.max(0, Math.floor((z - minZ) / CELL)));

    // A standoff point can land just inside an inflated wall; snap start/goal
    // to the nearest free cell so A* always has valid endpoints.
    function nearestFree(c0, r0) {
      if (!blocked(c0, r0)) return [c0, r0];
      for (let rad = 1; rad < 40; rad++) {
        for (let dc = -rad; dc <= rad; dc++) for (let dr = -rad; dr <= rad; dr++) {
          if (Math.abs(dc) !== rad && Math.abs(dr) !== rad) continue;
          const c = c0 + dc, r = r0 + dr;
          if (c >= 0 && r >= 0 && c < cols && r < rows && !blocked(c, r)) return [c, r];
        }
      }
      return [c0, r0];
    }
    const [sc, sr] = nearestFree(toC(fromX), toR(fromZ));
    const [gc, gr] = nearestFree(toC(toX),   toR(toZ));

    const idx = (c, r) => r * cols + c;
    const g = new Map(), came = new Map(), open = new Map();
    const h = (c, r) => Math.hypot(c - gc, r - gr);
    const sIdx = idx(sc, sr);
    g.set(sIdx, 0); open.set(sIdx, h(sc, sr));
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

    let foundIdx = -1;
    while (open.size) {
      let curIdx = -1, curF = Infinity;
      for (const [k, f] of open) if (f < curF) { curF = f; curIdx = k; }
      open.delete(curIdx);
      const cc = curIdx % cols, cr = (curIdx - cc) / cols;
      if (cc === gc && cr === gr) { foundIdx = curIdx; break; }
      const cg = g.get(curIdx);
      for (const [dc, dr] of dirs) {
        const nc = cc + dc, nr = cr + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || blocked(nc, nr)) continue;
        // Forbid diagonal moves that squeeze through a wall corner.
        if (dc !== 0 && dr !== 0 && (blocked(cc + dc, cr) || blocked(cc, cr + dr))) continue;
        const ni = idx(nc, nr);
        const ng = cg + ((dc !== 0 && dr !== 0) ? 1.41421356 : 1);
        if (ng < (g.get(ni) ?? Infinity)) {
          g.set(ni, ng); came.set(ni, curIdx);
          open.set(ni, ng + h(nc, nr));
        }
      }
    }
    if (foundIdx < 0) return null;

    const cells = [];
    for (let k = foundIdx; k !== undefined; k = came.get(k)) cells.push(k);
    cells.reverse();
    let pts = cells.map((ci) => {
      const c = ci % cols, r = (ci - c) / cols;
      return new THREE.Vector3(cellX(c), 0, cellZ(r));
    });
    return smooth(pts, aabbs);
  }

  function lineClear(a, b, aabbs) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (CELL * 0.5)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      for (const w of aabbs) {
        if (x >= w.minX - PLAYER_RADIUS && x <= w.maxX + PLAYER_RADIUS &&
            z >= w.minZ - PLAYER_RADIUS && z <= w.maxZ + PLAYER_RADIUS) return false;
      }
    }
    return true;
  }
  // Greedy string-pulling: keep the farthest waypoint still in line of sight.
  function smooth(pts, aabbs) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      for (; j > i + 1; j--) if (lineClear(pts[i], pts[j], aabbs)) break;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  function goTo(mesh) {
    if (!mesh) return;
    targetMesh = mesh;
    parkedMesh = null; parkedLevel = null;
    standoffFor(mesh, 'near');

    // Room-to-room? Doorways sit on the centreline, so a cross-room step walks
    // straight through facing the doorway, then frames once inside. Same-room
    // steps keep the smooth wall-to-wall pan (+ the retreat bow).
    const targetRoomZ = mesh.userData.roomCenterZ;
    crossRoom = roomCenterZ !== null && targetRoomZ !== roomCenterZ;

    let pts;
    if (crossRoom) {
      // Force the path through the doorway centre (x=0, z=midpoint between rooms)
      // so string-pulling can never shortcut through the dividing wall.
      const doorZ = (roomCenterZ + targetRoomZ) / 2;
      const ptsA = planPath(camera.position.x, camera.position.z, 0, doorZ)
        ?? [new THREE.Vector3(camera.position.x, 0, camera.position.z), new THREE.Vector3(0, 0, doorZ)];
      const ptsB = planPath(0, doorZ, finalPos.x, finalPos.z)
        ?? [new THREE.Vector3(0, 0, doorZ), new THREE.Vector3(finalPos.x, 0, finalPos.z)];
      pts = [...ptsA, ...ptsB.slice(1)];
    } else {
      pts = planPath(camera.position.x, camera.position.z, finalPos.x, finalPos.z)
        ?? [new THREE.Vector3(), new THREE.Vector3()];
    }
    // Anchor the ends exactly to the camera and the standoff so there's no
    // jump at start or finish.
    pts[0].set(camera.position.x, 0, camera.position.z);
    pts[pts.length - 1].set(finalPos.x, 0, finalPos.z);

    path = pts;
    segLens = [];
    total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
      segLens.push(l); total += l;
    }
    bowN.copy(mesh.userData.faceNormal); // away from the destination wall

    startY = camera.position.y;
    startQuat.copy(camera.quaternion);
    _m.lookAt(finalPos, finalLook, camera.up);     // level look from standoff
    endQuat.setFromRotationMatrix(_m);
    if (crossRoom) {
      // Face straight down the doorway (level), toward the destination room.
      const zDir = Math.sign(targetRoomZ - roomCenterZ) || -1;
      _eye.set(camera.position.x, EYE_HEIGHT, camera.position.z);
      _tgt.set(camera.position.x, EYE_HEIGHT, camera.position.z + zDir);
      _m.lookAt(_eye, _tgt, camera.up);
      corridorQuat.setFromRotationMatrix(_m);
    }

    // Pace by whichever is slower: walking the distance at WALK_SPEED, or
    // turning to the new framing at TURN_SPEED — with a floor so neighbour
    // hops still ease rather than snap.
    duration = Math.max(MIN_DURATION, total / WALK_SPEED, startQuat.angleTo(endQuat) / TURN_SPEED);
    progress = 0;
    phase = 'glide';
  }

  // Point on the path at arc-length fraction `frac`, written into `out` (xz).
  function samplePath(frac, out) {
    if (total === 0 || frac <= 0) { out.set(path[0].x, 0, path[0].z); return; }
    const d = frac * total;
    let acc = 0;
    for (let i = 0; i < segLens.length; i++) {
      if (acc + segLens[i] >= d) {
        const t = segLens[i] ? (d - acc) / segLens[i] : 0;
        out.set(
          path[i].x + (path[i + 1].x - path[i].x) * t, 0,
          path[i].z + (path[i + 1].z - path[i].z) * t,
        );
        return;
      }
      acc += segLens[i];
    }
    const last = path[path.length - 1];
    out.set(last.x, 0, last.z);
  }

  function nearestArtwork() {
    let best = null, bestD = Infinity;
    for (const a of built.orderedArtworks) {
      a.getWorldPosition(_wp);
      const d = _wp.distanceToSquared(camera.position);
      if (d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  function step(delta) {
    const arts = built.orderedArtworks;
    const i = targetMesh ? arts.indexOf(targetMesh) : -1;
    const ni = i >= 0 ? i + delta : (delta > 0 ? 0 : -1);
    if (ni >= 0 && ni < arts.length) goTo(arts[ni]);
  }

  return {
    get active()      { return phase !== 'idle'; },
    get walking()     { return phase === 'glide'; },
    get parkedMesh()  { return phase === 'idle' ? parkedMesh  : null; },
    get parkedLevel() { return phase === 'idle' ? parkedLevel : null; },
    debug() {
      return {
        phase, progress: +progress.toFixed(2), duration: +duration.toFixed(2),
        total: +total.toFixed(2), pathLen: path?.length ?? 0,
        path: path?.map((p) => [+p.x.toFixed(2), +p.z.toFixed(2)]),
        target: targetMesh ? targetMesh.getWorldPosition(new THREE.Vector3()).toArray().map((n) => +n.toFixed(2)) : null,
        targetSize: targetMesh ? [targetMesh.geometry.parameters?.width, targetMesh.geometry.parameters?.height] : null,
        finalPos: finalPos.toArray().map((n) => +n.toFixed(2)),
        finalLook: finalLook.toArray().map((n) => +n.toFixed(2)),
        cam: camera.position.toArray().map((n) => +n.toFixed(2)),
      };
    },
    enter() { goTo(nearestArtwork()); },
    next()  { step(+1); },
    prev()  { step(-1); },
    goToMesh(mesh) { goTo(mesh); },
    // Tween closer/farther without pathfinding (already in front of the artwork).
    zoomTo(mesh, level) {
      standoffFor(mesh, level);
      startTween(mesh, level);
    },
    // Tween to a position where the placard fills the viewport.
    goToPlacard(placardMesh) {
      const n = placardMesh.parent?.userData.faceNormal;
      if (!n) return;
      standoffFor(placardMesh, 'near', n);
      startTween(placardMesh.parent, 'placard');
    },
    update(dt) {
      if (phase === 'idle') return false;

      if (phase === 'glide') {
        // One eased motion: position glides along the path while the framing
        // slerps from the current orientation to the new one, both keyed to the
        // same smoothstep so they start and finish together (no end-snap). The
        // sin() bow eases the camera backward at mid-walk, so neighbours on one
        // wall read as "step back, slide over, step in" rather than a pivot.
        progress = Math.min(1, progress + dt / duration);
        const e = progress * progress * (3 - 2 * progress);

        samplePath(e, _p);
        // No retreat bow on a room-to-room walk — it's for same-wall side-steps.
        const bow = crossRoom ? 0 : RETREAT * Math.sin(Math.PI * e);
        camera.position.set(
          _p.x + bowN.x * bow,
          startY + (finalPos.y - startY) * e,
          _p.z + bowN.z * bow,
        );

        if (crossRoom) {
          // Turn to face the doorway, hold it straight through the middle of the
          // walk, then frame the piece once inside the new room.
          if (e < 0.25) {
            camera.quaternion.slerpQuaternions(startQuat, corridorQuat, e / 0.25);
          } else if (e < 0.7) {
            camera.quaternion.copy(corridorQuat);
          } else {
            camera.quaternion.slerpQuaternions(corridorQuat, endQuat, (e - 0.7) / 0.3);
          }
        } else {
          camera.quaternion.slerpQuaternions(startQuat, endQuat, e);
        }
        built.collide?.(camera.position, PLAYER_RADIUS);

        if (progress >= 1) {
          camera.position.copy(finalPos);
          camera.quaternion.copy(endQuat);
          roomCenterZ = targetMesh.userData.roomCenterZ; // now parked in this room
          parkedMesh  = targetMesh;
          parkedLevel = 'near';
          phase = 'idle';
        }
        return true;
      } else if (phase === 'tween') {
        progress = Math.min(1, progress + dt / duration);
        const e = progress * progress * (3 - 2 * progress);
        camera.position.lerpVectors(tweenStartPos, finalPos, e);
        camera.quaternion.slerpQuaternions(startQuat, endQuat, e);
        if (progress >= 1) {
          camera.position.copy(finalPos);
          camera.quaternion.copy(endQuat);
          parkedMesh  = tweenMesh;
          parkedLevel = tweenLevel;
          phase = 'idle';
        }
        return true;
      }
      return false;
    },
  };
}
