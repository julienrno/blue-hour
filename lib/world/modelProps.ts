import * as THREE from "three";
import { snowify } from "./materials";
import { glowMaterial, instanceParts, islandGlow, prepare, type Models, type Part, type Prepared } from "./models";
import { createRng } from "./random";
import { modelInteriors, tagWindows } from "./interiors";
import type { Collider } from "./city";

const WINDOW_PALETTE = ["#ffcf94", "#ffc27a", "#fff1d6", "#d8e8ff", "#8fb8ff", "#ffe08a"].map((c) => new THREE.Color(c));

function standard(m: THREE.Material) {
  return (m as THREE.MeshStandardMaterial).isMeshStandardMaterial ? (m.clone() as THREE.MeshStandardMaterial) : new THREE.MeshStandardMaterial();
}

export type Slot = { x: number; z: number; sx: number; sz: number; floors: number; tower: boolean; face: 1 | -1 };

/** Fills every building slot with copies of one model, keeping each copy's street-facing side on the slot's street side. */
export function buildModelBlocks(model: THREE.Group, slots: Slot[], group: THREE.Group, colliders: Collider[], seed: number) {
  const variants = new Map<string, { prep: Prepared; matrices: THREE.Matrix4[] }>();
  const variant = (along: "x" | "z") => {
    if (!variants.has(along)) {
      const prep = prepare(model, { axis: "long", size: 1, longAlong: along });
      prep.parts = prep.parts.map((p) => {
        const mat = snowify(standard(p.material), { coat: 0.3, coatNoise: 0.5, contact: 0.4 });
        if (/window/i.test(p.name)) {
          const geometry = p.geometry.clone();
          islandGlow(geometry, WINDOW_PALETTE, seed + along.length);
          return { ...p, geometry, material: glowMaterial(mat, 1.4, 0.3) };
        }
        const tagged = tagWindows(p.geometry, seed);
        if (tagged.panes > 0) return { ...p, geometry: tagged.geometry, material: modelInteriors(mat, { litRatio: 0.2 }) };
        return { ...p, material: mat };
      });
      variants.set(along, { prep, matrices: [] });
    }
    return variants.get(along)!;
  };

  for (const s of slots) {
    const longX = s.sx > s.sz;
    const along = longX ? s.sx : s.sz;
    const v = variant(longX ? "x" : "z");
    // Size copies so the model reads as a 10-14 storey block, then stretch them to fill the slot exactly
    const heightPerLong = v.prep.size.y;
    const wantedLong = (s.tower ? 42 : 32) / heightPerLong;
    const n = s.tower ? 1 : Math.max(1, Math.round(along / wantedLong));
    const L = s.tower ? Math.min(wantedLong, 26) : along / n;
    const depth = (longX ? v.prep.size.z : v.prep.size.x) * L;
    for (let i = 0; i < n; i++) {
      const t = -along / 2 + (i + 0.5) * (along / n);
      let x = longX ? s.x + t : s.x;
      let z = longX ? s.z : s.z + t;
      if (longX) z = s.z + s.face * (s.sz / 2) - s.face * (depth / 2);
      else x = s.x + s.face * (s.sx / 2) - s.face * (depth / 2);
      v.matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(x, -0.3, z), new THREE.Quaternion(), new THREE.Vector3(L, L, L)));
      const fx = v.prep.size.x * L;
      const fz = v.prep.size.z * L;
      colliders.push({ minX: x - fx / 2, maxX: x + fx / 2, minZ: z - fz / 2, maxZ: z + fz / 2 });
    }
  }
  for (const { prep, matrices } of variants.values()) {
    if (matrices.length) group.add(...instanceParts(prep.parts, matrices));
  }
}

export type CarPlacement = { x: number; z: number; ry: number; dir?: number };

export function modelCars(models: Models, cars: CarPlacement[]) {
  const rng = createRng(5);
  const kinds: Prepared[] = [];
  if (models.car) kinds.push(prepare(models.car, { axis: "long", size: 4.4, longAlong: "z" }));
  for (const k of kinds) {
    k.parts = k.parts.map((p) => {
      const src = p.material as THREE.MeshStandardMaterial;
      let mat = standard(src);
      // Some exports bake the paint into the emissive slot; treat it as albedo instead
      if (!src.map && src.emissiveMap) {
        mat = new THREE.MeshStandardMaterial({ map: src.emissiveMap, roughness: 0.4, metalness: 0.35 });
      }
      if (/wheel|tyre|tire|rim/i.test(p.name)) return { ...p, material: mat };
      return { ...p, material: snowify(mat, { coat: 0.55, coatNoise: 0.6 }) };
    });
  }
  const buckets = kinds.map(() => [] as THREE.Matrix4[]);
  const q = new THREE.Quaternion();
  for (const c of cars) {
    const i = rng.int(0, kinds.length - 1);
    const angle = c.ry - Math.PI / 2 + (rng.chance(0.5) ? Math.PI : 0);
    // Which way the model's length runs along world z, for the climbable deck colliders
    c.dir = Math.cos(angle) >= 0 ? 1 : -1;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    buckets[i].push(new THREE.Matrix4().compose(new THREE.Vector3(c.x, -0.06, c.z), q, new THREE.Vector3(1, 1, 1)));
  }
  return kinds.flatMap((k, i) => (buckets[i].length ? instanceParts(k.parts, buckets[i]) : []));
}

export function modelLampFactory(models: Models, height: number) {
  if (!models.lamp) return undefined;
  const prep = prepare(models.lamp, { axis: "y", size: height });
  const isHead = (p: Part) => {
    const m = p.material as THREE.MeshStandardMaterial;
    return !!m.emissive && m.emissive.r + m.emissive.g + m.emissive.b > 0.05;
  };
  const base = new THREE.Vector3();
  let count = 0;
  for (const p of prep.parts) {
    const pos = p.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) < 0.3) {
        base.x += pos.getX(i);
        base.z += pos.getZ(i);
        count++;
      }
    }
  }
  base.divideScalar(Math.max(count, 1));
  const parts = prep.parts.map((p) => ({ ...p, geometry: p.geometry.clone().translate(-base.x, 0, -base.z) }));
  const headPart = parts.find(isHead);
  const head = new THREE.Vector3();
  if (headPart) {
    headPart.geometry.computeBoundingBox();
    headPart.geometry.boundingBox!.getCenter(head);
    head.y = headPart.geometry.boundingBox!.min.y;
  }
  const metal = snowify(standard(parts.find((p) => !isHead(p))?.material ?? new THREE.MeshStandardMaterial()), { coat: 0.4, coatNoise: 0.15, contact: 0.25 });
  const headDir = new THREE.Vector3(head.x, 0, head.z).normalize();

  return (x: number, y: number, z: number, towardX: number, color: THREE.Color) => {
    const g = new THREE.Group();
    const bulbMat = new THREE.MeshStandardMaterial({ color: "#000", emissive: color, emissiveIntensity: 14 });
    let bulb: THREE.Mesh | undefined;
    for (const p of parts) {
      const mesh = new THREE.Mesh(p.geometry, isHead(p) ? bulbMat : metal);
      mesh.castShadow = !isHead(p);
      if (isHead(p)) bulb = mesh;
      g.add(mesh);
    }
    const q = new THREE.Quaternion().setFromUnitVectors(headDir, new THREE.Vector3(Math.sign(towardX), 0, 0));
    g.quaternion.copy(q);
    g.position.set(x, y, z);
    const headWorld = head.clone().applyQuaternion(q).add(g.position);
    return { object: g, head: headWorld, bulb };
  };
}
