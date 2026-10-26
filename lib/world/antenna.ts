import * as THREE from "three";
import type { Collider, LightSource } from "./city";
import { snowify } from "./materials";
import { prepare } from "./models";

/** The radio mast on the open ground east of the street: the highest point in the city. */
export const ANTENNA = { x: 40, z: 8, height: 70 };
// The model at a scale a person fits (railing at chest height, rungs a stride apart); the extra height comes from
// stretching the lattice shaft below the platform rather than blowing the whole thing up
const NATURAL_HEIGHT = 48;
// The platform railing, cut down from the model's so you can climb onto it and jump
const RAIL_HEIGHT = 0.95;

const RED = new THREE.Color("#ff2a1a");

export type AntennaLadder = {
  base: THREE.Vector3;
  n: THREE.Vector3;
  groundY: number;
  roofY: number;
  topY: number;
  arrive: THREE.Vector3;
  standoff: number;
};

export type Antenna = {
  group: THREE.Group;
  colliders: Collider[];
  lights: LightSource[];
  ladder: AntennaLadder;
  /** Footprint for the map. */
  footprint: Collider;
};

/**
 * A lattice mast with a service platform near the top, standing on the snow. The model is measured rather than
 * trusted: the shaft from its middle storeys, the platform from its largest flat surface, the railing from what
 * stands along the platform's edge. A caged ladder runs up the face that looks back at the street, out past the edge
 * of the platform so you climb over its railing at the top, like the parapets on the roofs.
 */
export function buildAntenna(model: THREE.Group, groundAt: (x: number, z: number) => number): Antenna {
  const prep = prepare(model, { axis: "y", size: NATURAL_HEIGHT });
  const H0 = prep.size.y;
  {
    // The platform sits on top of the shaft: stretch everything below it, lift everything above it
    const cut = platformHeight(prep.parts, H0) - 2;
    const lift = ANTENNA.height - H0;
    for (const p of prep.parts) {
      const pos = p.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        pos.setY(i, y < cut ? (y * (cut + lift)) / cut : y + lift);
      }
      pos.needsUpdate = true;
      p.geometry.computeBoundingSphere();
      p.geometry.computeBoundingBox();
    }
  }
  const H = ANTENNA.height;

  // Centre on the shaft (the dishes hang off to one side, so the model's own box is not centred on it)
  const shaft = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const p of prep.parts) {
    const pos = p.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (v.y > H * 0.1 && v.y < H * 0.7) shaft.expandByPoint(v);
    }
  }
  const cx = (shaft.min.x + shaft.max.x) / 2;
  const cz = (shaft.min.z + shaft.max.z) / 2;
  for (const p of prep.parts) p.geometry.translate(-cx, 0, -cz);
  shaft.translate(new THREE.Vector3(-cx, 0, -cz));

  // The platform: the height with the most upward-facing area in the top third, and the extent of that floor
  const tris = flatTriangles(prep.parts, H);
  const floorY = platformHeight(prep.parts, H);
  const floor = new THREE.Box3();
  for (const t of tris) if (Math.abs(t.y - floorY) < 0.2) floor.union(t.box);

  // The railing: whatever stands up along the platform's west edge (falls back to a standard 1.1 m rail)
  let railTop = floorY + 1.1;
  {
    let top = -Infinity;
    for (const p of prep.parts) {
      const pos = p.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        if (v.x < floor.min.x + 0.35 && v.y > floorY + 0.3 && v.y < floorY + 2) top = Math.max(top, v.y);
      }
    }
    if (top > floorY + 0.6) railTop = top;
  }
  {
    // Cut the railing down to waist height: low enough to hop onto and jump from, high enough to still read as one.
    // Only the steelwork along the platform's edges moves, squashed towards the floor
    const height = railTop - floorY;
    const f = RAIL_HEIGHT / height;
    const band = 0.45;
    for (const p of prep.parts) {
      if (/abs|white/i.test(p.material.name)) continue;
      const pos = p.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        if (v.y <= floorY + 0.02 || v.y > railTop + 0.05) continue;
        if (v.x < floor.min.x - 0.1 || v.x > floor.max.x + 0.1 || v.z < floor.min.z - 0.1 || v.z > floor.max.z + 0.1) continue;
        const edge = Math.min(v.x - floor.min.x, floor.max.x - v.x, v.z - floor.min.z, floor.max.z - v.z);
        if (edge > band) continue;
        pos.setY(i, floorY + (v.y - floorY) * f);
      }
      pos.needsUpdate = true;
      p.geometry.computeBoundingSphere();
    }
    railTop = floorY + Math.min(height, RAIL_HEIGHT);
  }

  const group = new THREE.Group();
  const groundY = Math.min(
    ...[
      [shaft.min.x, shaft.min.z],
      [shaft.max.x, shaft.min.z],
      [shaft.min.x, shaft.max.z],
      [shaft.max.x, shaft.max.z],
    ].map(([x, z]) => groundAt(ANTENNA.x + x, ANTENNA.z + z))
  );
  group.position.set(ANTENNA.x, groundY, ANTENNA.z);
  for (const p of prep.parts) {
    const src = p.material as THREE.MeshStandardMaterial;
    const mat = (src.isMeshStandardMaterial ? src.clone() : new THREE.MeshStandardMaterial()) as THREE.MeshStandardMaterial;
    // No environment to reflect out here: fully metallic steel would render black, so it reads as weathered paint
    mat.metalness = Math.min(mat.metalness, 0.35);
    const mesh = new THREE.Mesh(p.geometry, snowify(mat, { coat: 0.3, coatNoise: 0.6 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData.noCull = true;
  group.traverse((o) => (o.userData.noCull = true));

  const at = (x: number, y: number, z: number) => new THREE.Vector3(ANTENNA.x + x, groundY + y, ANTENNA.z + z);
  const box = (b: THREE.Box3, extra: Partial<Collider> = {}): Collider => ({
    minX: ANTENNA.x + b.min.x,
    maxX: ANTENNA.x + b.max.x,
    minZ: ANTENNA.z + b.min.z,
    maxZ: ANTENNA.z + b.max.z,
    ...extra,
  });

  // Obstruction lights, steady red as on every mast in the country: the tip, and two pairs down the shaft
  const lights: LightSource[] = [];
  // Far brighter than anything else in the scene: they have to burn through the fog from across the city
  const bulbGeo = new THREE.SphereGeometry(0.2, 10, 8);
  const bulbMat = new THREE.MeshBasicMaterial({ color: RED.clone().multiplyScalar(20), toneMapped: false });
  const lamp = (p: THREE.Vector3, strength: number) => {
    const bulb = new THREE.Mesh(bulbGeo, bulbMat);
    bulb.position.copy(p).sub(group.position);
    group.add(bulb);
    lights.push({ position: p, color: RED, strength, omni: true, lamp: false });
  };
  // The top light sits in the heart of the star of rods at the tip (which is not over the shaft's centre)
  {
    const tip = new THREE.Box3();
    for (const p of prep.parts) {
      const pos = p.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        if (v.y > H - 0.8) tip.expandByPoint(v);
      }
    }
    const c = tip.isEmpty() ? new THREE.Vector3(0, H, 0) : tip.getCenter(new THREE.Vector3());
    lamp(at(c.x, c.y, c.z), 0.6);
  }
  for (const k of [1 / 3, 2 / 3]) {
    lamp(at(shaft.min.x - 0.1, H * k, shaft.min.z - 0.1), 0.3);
    lamp(at(shaft.max.x + 0.1, H * k, shaft.max.z + 0.1), 0.3);
  }

  // Colliders: the shaft (solid up to the platform), the platform floor and its railing, which you can pass under
  // on the ground and hop up onto at the top
  const under = floorY - 0.5;
  const colliders: Collider[] = [box(shaft, { top: groundY + floorY })];
  colliders.push(box(floor, { top: groundY + floorY, bottom: groundY + under }));
  const rail = 0.25;
  const edges = [
    new THREE.Box3(new THREE.Vector3(floor.min.x, 0, floor.min.z), new THREE.Vector3(floor.min.x + rail, 0, floor.max.z)),
    new THREE.Box3(new THREE.Vector3(floor.max.x - rail, 0, floor.min.z), new THREE.Vector3(floor.max.x, 0, floor.max.z)),
    new THREE.Box3(new THREE.Vector3(floor.min.x, 0, floor.min.z), new THREE.Vector3(floor.max.x, 0, floor.min.z + rail)),
    new THREE.Box3(new THREE.Vector3(floor.min.x, 0, floor.max.z - rail), new THREE.Vector3(floor.max.x, 0, floor.max.z)),
  ];
  for (const e of edges) colliders.push(box(e, { top: groundY + railTop, bottom: groundY + under }));

  // The ladder: on the west face (towards the street), just outside the platform's edge, braced back to the shaft
  const ladderN = new THREE.Vector3(-1, 0, 0);
  const base = at(floor.min.x - 0.05, 0, 0).setY(groundAt(ANTENNA.x + floor.min.x - 1, ANTENNA.z));
  const ladder: AntennaLadder = {
    base,
    n: ladderN,
    groundY: base.y,
    roofY: groundY + floorY,
    topY: groundY + railTop,
    arrive: at(floor.min.x + 1.3, floorY, 0),
    standoff: Math.max(0, shaft.min.x - (floor.min.x - 0.05)),
  };

  return { group, colliders, lights, ladder, footprint: box(floor) };
}

type Part = { geometry: THREE.BufferGeometry };

/** Upward-facing triangles in the top third of the model. */
function flatTriangles(parts: Part[], H: number) {
  const out: { y: number; box: THREE.Box3; area: number }[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const p of parts) {
    const pos = p.geometry.getAttribute("position");
    const index = p.geometry.index;
    const count = (index ? index.count : pos.count) / 3;
    for (let t = 0; t < count; t++) {
      const id = (k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
      a.fromBufferAttribute(pos, id(0));
      b.fromBufferAttribute(pos, id(1));
      c.fromBufferAttribute(pos, id(2));
      n.subVectors(b, a).cross(c.clone().sub(a));
      const len = n.length();
      if (len < 1e-9 || n.y / len < 0.9) continue;
      const y = (a.y + b.y + c.y) / 3;
      if (y < H * 0.66) continue;
      out.push({ y, box: new THREE.Box3().setFromPoints([a.clone(), b.clone(), c.clone()]), area: len / 2 });
    }
  }
  return out;
}

/** The height with the most floor area near the top: the service platform. */
function platformHeight(parts: Part[], H: number) {
  const area = new Map<number, number>();
  for (const t of flatTriangles(parts, H)) {
    const k = Math.round(t.y * 10) / 10;
    area.set(k, (area.get(k) ?? 0) + t.area);
  }
  return [...area].sort((p, q) => q[1] - p[1])[0]?.[0] ?? H * 0.84;
}
