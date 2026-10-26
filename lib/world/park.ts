import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Collider } from "./city";
import { snowify } from "./materials";

const BENCH = "/models/opt/bench.glb";
const PLAYGROUND = "/models/opt/playground.glb";

// Bench model: concrete feet and wooden slats, 2.4 m long along x, its front (where you sit) facing +z
const BENCH_SIZE = { minX: 3.84, maxX: 6.22, minZ: -0.75, maxZ: 0, seat: 0.45 };
// Playground model: two towers joined by a rope bridge, a lookout, slides and a climbing net
const PLAY_CENTER = new THREE.Vector2(-2.97, 0.31);
// The parts you bump into (model x/z): both towers, the little lookout and the tube slide
const PLAY_SOLIDS: [number, number, number, number][] = [
  [-4.2, -2.2, -1.4, 0.6],
  [-4.2, -2.2, 2.1, 4.1],
  [-1.3, 0.1, -2.5, -1.1],
  [-4.5, -2.8, 4.2, 6.0],
];

type Placement = { kind: "bench" | "playground"; position: THREE.Vector3; ry: number };
/** Where you sit on a bench: the eye while seated, which way it faces, and where you stand up. */
export type Seat = { eye: THREE.Vector3; facing: THREE.Vector3; stand: THREE.Vector3; ground: number };
export type ParkPlan = { placements: Placement[]; colliders: Collider[]; seats: Seat[] };

/** A model-space box turned by `ry` and moved to `position`, as a world axis-aligned box. */
function box(position: THREE.Vector3, ry: number, x0: number, x1: number, z0: number, z1: number, extra: Partial<Collider> = {}): Collider {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  const pts = [
    [x0, z0],
    [x1, z0],
    [x0, z1],
    [x1, z1],
  ].map(([x, z]) => [position.x + x * c + z * s, position.z - x * s + z * c]);
  return {
    minX: Math.min(...pts.map((p) => p[0])),
    maxX: Math.max(...pts.map((p) => p[0])),
    minZ: Math.min(...pts.map((p) => p[1])),
    maxZ: Math.max(...pts.map((p) => p[1])),
    ...extra,
  };
}

/**
 * Benches along the park trail (one looking out over the frozen pond, one by the playground, for the parents) and
 * a children's playground in a clearing beside the trail. Planned before the trees, so they grow around them.
 */
export function planPark(
  trail: THREE.Vector2[],
  pond: { x: number; z: number },
  pondDistance: (x: number, z: number) => number,
  heightAt: (x: number, z: number) => number
): ParkPlan {
  const placements: Placement[] = [];
  const colliders: Collider[] = [];
  const seats: Seat[] = [];

  const bench = (x: number, z: number, faceX: number, faceZ: number) => {
    // Turn so the seat faces (faceX, faceZ); the model's own origin is off to the side, so centre it first
    const ry = Math.atan2(faceX, faceZ);
    const cx = (BENCH_SIZE.minX + BENCH_SIZE.maxX) / 2;
    const cz = (BENCH_SIZE.minZ + BENCH_SIZE.maxZ) / 2;
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    const position = new THREE.Vector3(x - (cx * c + cz * s), heightAt(x, z) - 0.04, z - (-cx * s + cz * c));
    placements.push({ kind: "bench", position, ry });
    // You can jump up and stand on the seat
    // Drawn in from the bench's outline: the body is a broad capsule, and against the full box it stopped you a
    // good half metre short of the slats
    const IN = 0.25;
    colliders.push(
      box(position, ry, BENCH_SIZE.minX + IN, BENCH_SIZE.maxX - IN, BENCH_SIZE.minZ + IN, BENCH_SIZE.maxZ - IN, { top: position.y + BENCH_SIZE.seat, height: 1 })
    );
    // Sitting in the middle, back against the slats, looking out the way the bench faces
    const local = (lx: number, ly: number, lz: number) => new THREE.Vector3(position.x + lx * c + lz * s, position.y + ly, position.z - lx * s + lz * c);
    const ground = heightAt(x, z);
    seats.push({
      eye: local(cx, BENCH_SIZE.seat + 0.78, -0.3),
      facing: new THREE.Vector3(s, 0, c),
      stand: local(cx, 0, 0.75).setY(ground),
      ground,
    });
  };

  // Beside a trail segment, `along` of the way, set back from the path and facing it
  const byTrail = (i: number, along: number, side: 1 | -1) => {
    const a = trail[i];
    const b = trail[i + 1];
    const d = b.clone().sub(a).normalize();
    const n = new THREE.Vector2(-d.y, d.x).multiplyScalar(side);
    const p = a.clone().lerp(b, along).addScaledVector(n, 2.6);
    bench(p.x, p.y, -n.x, -n.y);
  };
  byTrail(1, 0.45, 1);
  byTrail(4, 0.5, -1);
  byTrail(5, 0.35, 1);

  // Looking out over the pond from its western bank
  let bx = pond.x;
  while (pondDistance(bx, pond.z) < 1.3) bx -= 0.5;
  bench(bx - 1.5, pond.z, 1, 0);

  // The playground, in the clearing south of the pond, and a bench facing it
  const center = new THREE.Vector2(96, -22);
  const ground = heightAt(center.x, center.y);
  const position = new THREE.Vector3(center.x - PLAY_CENTER.x, ground - 0.12, center.y - PLAY_CENTER.y);
  placements.push({ kind: "playground", position, ry: 0 });
  for (const [x0, x1, z0, z1] of PLAY_SOLIDS) colliders.push(box(position, 0, x0, x1, z0, z1, { height: 3 }));
  bench(center.x - 7.5, center.y + 1, 1, 0);

  return { placements, colliders, seats };
}

/** Loads the two models once and places copies; everything gets a dusting of snow on top. */
export async function buildPark(plan: ParkPlan) {
  const loader = new GLTFLoader();
  const [bench, playground] = await Promise.all([loader.loadAsync(BENCH), loader.loadAsync(PLAYGROUND)]);
  const dust = (root: THREE.Object3D, coat: number) => {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!mat.transparent && !mat.userData.snow) {
        mat.userData.snow = true;
        snowify(mat, { coat, coatNoise: 0.5, contact: 0.3 });
      }
    });
  };
  dust(bench.scene, 0.7);
  dust(playground.scene, 0.55);
  const group = new THREE.Group();
  for (const p of plan.placements) {
    const o = (p.kind === "bench" ? bench.scene : playground.scene).clone();
    o.position.copy(p.position);
    o.rotation.y = p.ry;
    group.add(o);
  }
  return group;
}
