import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { Collider, LightSource } from "./city";
import { snowify } from "./materials";
import { toFloat } from "./models";
import { glowTexture, lightFromInside, stationUniforms, worldBox, type ShopState, type Venue } from "./shop";

const MODEL = "/models/opt/station2.glb";

// Model space, metres (real scale). The shop's glass front faces +x, toward the canopy and the two pump islands
const STORE = { minX: -14.31, maxX: -4.83, minZ: -8.97, maxZ: 10.43, height: 4.69 };
// The sales floor; the toilets behind their doors (z > 4.46) are closed off
const INTERIOR = { minX: -13.6, maxX: -5.5, minZ: -8.2, maxZ: 4.4 };
const FRONT_X = -5.42;
const DOOR = { minZ: -1.66, maxZ: 1.63, top: 2.9 };
const SLIDE = 1.55;
const FOOTPRINT = { minX: -15.6, maxX: 23, minZ: -11.6, maxZ: 12 };
const CANOPY_UNDER = 4.81;
// The canopy roof's outline, for the map
const CANOPY = { minX: -1.9, maxX: 22.4, minZ: -11, maxZ: 11 };
const FURNITURE: [number, number, number, number][] = [
  [-11.72, -7.52, -1.79, -1.04],
  [-11.72, -7.52, 1.73, 2.48],
  [-13.68, -13.17, -4.09, 4.32],
  [-13.68, -8.57, -7.13, -5.65],
  [-13.05, -7.94, -8.24, -7.8],
];
// Canopy columns, pumps, the bins between them and the crash barriers at the ends of the islands
const OUTSIDE: [number, number, number, number][] = [
  [4.4, 4.97, -5.17, -4.58],
  [15.3, 15.87, -5.17, -4.58],
  [4.4, 4.97, 4.83, 5.43],
  [15.3, 15.87, 4.83, 5.43],
  [4.27, 5.16, -3.62, -1.6],
  [4.27, 5.16, 1.58, 3.6],
  [15.15, 16.05, -3.62, -1.6],
  [15.15, 16.05, 1.58, 3.6],
  [4.16, 5.35, -1.11, 1.09],
  [15, 16.2, -1.11, 1.09],
  [3.93, 5.51, -5.74, -4.69],
  [3.93, 5.51, 4.96, 6],
  [14.81, 16.39, 4.96, 6],
  [14.81, 16.39, -5.74, -4.69],
  [-5.23, -4.98, 4.6, 6.62],
];
// Kerbs you step onto: the two pump islands and the pavement around the shop
const CURBS: [number, number, number, number, number][] = [
  [3.27, 6.21, -7.6, 7.6, 0.25],
  [14.14, 17.08, -7.6, 7.6, 0.25],
  [-15.38, -3.76, -10.7, 11.71, 0.22],
];
// Only two real lights, staggered across the forecourt; the canopy's own light boxes do the rest
const DOWNLIGHTS: [number, number][] = [
  [4.6, -4],
  [14.8, 4],
];
// Shell layers that share a plane with something drawn on them (window frames, the red band, the fridges and shelf
// backs against the walls): pushed back in depth by this many units so the detail always wins instead of flickering
const BEHIND: Record<string, number> = { Material: 4, gray_walls: 2 };
const REACH = 2.6;
const DETAIL_DISTANCE = 70;

export type StationPlan = {
  position: THREE.Vector3;
  ry: number;
  colliders: Collider[];
  door: Collider;
  bounds: Collider;
  footprint: Collider;
  doorway: THREE.Vector3;
  lights: LightSource[];
  /** What the minimap draws: the forecourt, the canopy over it, the pump islands and the shop */
  map: { forecourt: Collider; canopy: Collider; islands: Collider[]; shop: Collider };
};

function frame(position: THREE.Vector3, ry: number) {
  return new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(1, 1, 1));
}

/**
 * The gas station, further down the right side of the street: a big lit canopy over two pump islands, and a small
 * shop behind it with automatic doors.
 */
export function planStation(heightAt: (x: number, z: number) => number): StationPlan {
  // A half turn: the model's +x (the canopy) faces the road (world -x)
  const ry = Math.PI;
  const canopyEdge = 10.2;
  const position = new THREE.Vector3(canopyEdge + 22.42, 0, -165);
  let m = frame(position, ry);
  const footprint = worldBox(m, FOOTPRINT.minX, FOOTPRINT.maxX, FOOTPRINT.minZ, FOOTPRINT.maxZ);
  let base = -Infinity;
  for (let i = 0; i <= 14; i++) {
    for (let j = 0; j <= 14; j++) {
      base = Math.max(
        base,
        heightAt(THREE.MathUtils.lerp(footprint.minX, footprint.maxX, i / 14), THREE.MathUtils.lerp(footprint.minZ, footprint.maxZ, j / 14))
      );
    }
  }
  position.y = base + 0.04;
  m = frame(position, ry);

  const wall = (x0: number, x1: number, z0: number, z1: number) => worldBox(m, x0, x1, z0, z1, { height: STORE.height });
  const door = wall(FRONT_X - 0.18, FRONT_X + 0.18, DOOR.minZ, DOOR.maxZ);
  const colliders: Collider[] = [
    wall(STORE.minX, STORE.minX + 0.3, STORE.minZ, STORE.maxZ),
    wall(STORE.minX, STORE.maxX, STORE.minZ, STORE.minZ + 0.3),
    // The toilet block, solid from the sales floor's back wall to the end of the building
    wall(STORE.minX, STORE.maxX, 4.46, STORE.maxZ),
    wall(FRONT_X - 0.18, FRONT_X + 0.18, STORE.minZ, DOOR.minZ),
    wall(FRONT_X - 0.18, FRONT_X + 0.18, DOOR.maxZ, 4.46),
    door,
    ...FURNITURE.map(([x0, x1, z0, z1]) => worldBox(m, x0, x1, z0, z1, { height: 1.9 })),
    ...OUTSIDE.map(([x0, x1, z0, z1]) => worldBox(m, x0, x1, z0, z1, { height: 3 })),
    ...CURBS.map(([x0, x1, z0, z1, h]) => worldBox(m, x0, x1, z0, z1, { top: position.y + h })),
    worldBox(m, FOOTPRINT.minX, FOOTPRINT.maxX, FOOTPRINT.minZ, FOOTPRINT.maxZ, { top: position.y }),
  ];
  const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m);
  const doorway = at(FRONT_X, 0, (DOOR.minZ + DOOR.maxZ) / 2);
  const canopyLight = new THREE.Color("#eef3ff");
  const lights: LightSource[] = DOWNLIGHTS.map(([x, z]) => ({
    position: at(x, CANOPY_UNDER - 0.2, z),
    color: canopyLight,
    strength: 0.34,
    omni: false,
    lamp: true,
  }));
  const glow = new THREE.Color("#e4eeff");
  lights.push(
    // Just behind the glass, so only the spill through the windows shows in the fog
    { position: at(-5.9, 2.2, -5), color: glow, strength: 0.06, omni: true, lamp: false },
    { position: at(-5.9, 2.2, 2), color: glow, strength: 0.06, omni: true, lamp: false }
  );
  return {
    position,
    ry,
    colliders,
    door,
    bounds: worldBox(m, STORE.minX, STORE.maxX, STORE.minZ, STORE.maxZ),
    footprint,
    doorway,
    lights,
    map: {
      forecourt: footprint,
      canopy: worldBox(m, CANOPY.minX, CANOPY.maxX, CANOPY.minZ, CANOPY.maxZ),
      islands: CURBS.slice(0, 2).map(([x0, x1, z0, z1]) => worldBox(m, x0, x1, z0, z1)),
      shop: worldBox(m, STORE.minX, STORE.maxX, STORE.minZ, STORE.maxZ),
    },
  };
}

type Leaf = { mesh: THREE.Mesh; dir: number };

export class StationView implements Venue {
  group = new THREE.Group();
  sliding = true;
  private holder = new THREE.Group();
  private leaves: Leaf[] = [];
  private detail: THREE.Object3D[] = [];
  private open = 0;
  private wantOpen = false;
  private awayFor = 0;
  private insideLevel = 0;
  private doorBox: Collider;
  private loaded = false;
  private toLocal: THREE.Matrix4;

  constructor(
    private plan: StationPlan,
    private heightAt: (x: number, z: number) => number
  ) {
    this.doorBox = { ...plan.door };
    this.holder.position.copy(plan.position);
    this.holder.rotation.y = plan.ry;
    this.toLocal = frame(plan.position, plan.ry).invert();
    this.group.add(this.holder);
    const b = plan.bounds;
    stationUniforms.uShop.value.set(b.minX, b.minZ, b.maxX, b.maxZ);
    stationUniforms.uShopTop.value = plan.position.y + STORE.height;
    stationUniforms.uShopFloor.value = plan.position.y + 0.2;
    this.buildShell();
  }

  /** A concrete forecourt down into the snow, and the light under the canopy spilling over the snow around it. */
  private buildShell() {
    const slabMat = snowify(new THREE.MeshStandardMaterial({ color: "#5b5f66", roughness: 0.85 }), { coat: 0.5, coatNoise: 0.45, contact: 0.3 });
    const w = FOOTPRINT.maxX - FOOTPRINT.minX;
    const d = FOOTPRINT.maxZ - FOOTPRINT.minZ;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w, 2, d), slabMat);
    slab.position.set((FOOTPRINT.minX + FOOTPRINT.maxX) / 2, -1.02, (FOOTPRINT.minZ + FOOTPRINT.maxZ) / 2);
    slab.receiveShadow = true;
    const roofMat = snowify(new THREE.MeshStandardMaterial({ color: "#d9e1f2", roughness: 0.85 }), { sparkle: 0.5 });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(22.4, 0.1, 21.6), roofMat);
    roof.position.set(10.25, 6.36, 0);
    const pool = new THREE.Mesh(
      this.drape(new THREE.PlaneGeometry(36, 34, 24, 24).rotateX(-Math.PI / 2).translate(10.2, 0, 0)),
      new THREE.MeshBasicMaterial({
        map: glowTexture(),
        color: "#6c7ea8",
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      })
    );
    pool.renderOrder = 2;
    this.holder.add(slab, roof, pool);
  }

  /** Lays a flat model-space sheet on the snow (or the forecourt, whichever is higher). */
  private drape(geo: THREE.BufferGeometry) {
    const toWorld = frame(this.plan.position, this.plan.ry);
    const pp = geo.getAttribute("position");
    for (let i = 0; i < pp.count; i++) {
      const wp = new THREE.Vector3(pp.getX(i), 0, pp.getZ(i)).applyMatrix4(toWorld);
      pp.setY(i, Math.max(this.heightAt(wp.x, wp.z), this.plan.position.y) + 0.03 - this.plan.position.y);
    }
    pp.needsUpdate = true;
    return geo;
  }

  async load(renderer: THREE.WebGLRenderer) {
    const gltf = await new GLTFLoader().loadAsync(MODEL);
    const root = gltf.scene;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;
    pmrem.dispose();
    root.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    const box = new THREE.Box3();
    for (const mesh of meshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      box.setFromObject(mesh);
      if (box.max.x > FRONT_X - 0.2 && box.min.x < FRONT_X + 0.2 && box.min.z < DOOR.maxZ && box.max.z > DOOR.minZ) this.cutDoor(mesh);
      if (mat.transparent) {
        mat.emissive = new THREE.Color("#dfe8fa");
        mat.emissiveIntensity = 0.08;
        mat.envMap = room;
        mat.envMapIntensity = 0.25;
        mat.roughness = Math.max(mat.roughness, 0.4);
        mat.depthWrite = false;
        continue;
      }
      // The canopy's light boxes and its lit fascia
      if (/glowin/.test(mat.name)) {
        mat.emissiveIntensity = Math.min(mat.emissiveIntensity, 2.2);
        continue;
      }
      if (mat.userData.lit) continue;
      mat.userData.lit = true;
      mat.envMap = room;
      mat.envMapIntensity = 0.2;
      mat.roughness = Math.max(mat.roughness, 0.3);
      if (BEHIND[mat.name]) {
        mat.polygonOffset = true;
        mat.polygonOffsetFactor = 1;
        mat.polygonOffsetUnits = BEHIND[mat.name];
      }
      // The tiles keep a soft sheen, not a mirror: there is no light inside to reflect
      if (mat.name === "floor") {
        mat.roughness = Math.max(mat.roughness, 0.62);
        mat.metalness = 0;
        mat.envMapIntensity = 0.06;
      }
      lightFromInside(mat, 0.55, false, stationUniforms, 1);
      const inStore = box.max.x < STORE.maxX && box.min.x > STORE.minX && box.min.z > STORE.minZ && box.max.z < STORE.maxZ;
      if (inStore && box.getSize(new THREE.Vector3()).length() < 8) this.detail.push(mesh);
    }
    this.holder.add(root);
    this.holder.add(...this.leaves.map((l) => l.mesh));
    this.loaded = true;
  }

  /** The two door leaves share meshes with the shop front: cut them out, each half sliding to its own side. */
  private cutDoor(mesh: THREE.Mesh) {
    const local = toFloat(mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone());
    const world = local.clone().applyMatrix4(mesh.matrixWorld);
    const pos = world.getAttribute("position");
    const mid = (DOOR.minZ + DOOR.maxZ) / 2;
    const inDoor = (i: number) =>
      Math.abs(pos.getX(i) - FRONT_X) < 0.06 && pos.getZ(i) > DOOR.minZ - 0.02 && pos.getZ(i) < DOOR.maxZ - 0.03 && pos.getY(i) < DOOR.top;
    const sides: number[][] = [[], []];
    const rest: number[] = [];
    for (let t = 0; t < pos.count; t += 3) {
      const cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
      (inDoor(t) && inDoor(t + 1) && inDoor(t + 2) ? sides[cz < mid ? 0 : 1] : rest).push(t);
    }
    if (!sides[0].length && !sides[1].length) return;
    const pick = (geo: THREE.BufferGeometry, tris: number[]) => {
      const part = new THREE.BufferGeometry();
      for (const name of Object.keys(geo.attributes)) {
        const src = geo.getAttribute(name);
        const out = new Float32Array(tris.length * 3 * src.itemSize);
        let k = 0;
        for (const t of tris) for (let v = 0; v < 3; v++) for (let c = 0; c < src.itemSize; c++) out[k++] = src.getComponent(t + v, c);
        part.setAttribute(name, new THREE.BufferAttribute(out, src.itemSize));
      }
      return part;
    };
    mesh.geometry = pick(local, rest);
    sides.forEach((tris, i) => {
      if (!tris.length) return;
      const leaf = new THREE.Mesh(pick(world, tris), mesh.material);
      leaf.renderOrder = 1;
      this.leaves.push({ mesh: leaf, dir: i === 0 ? -1 : 1 });
    });
  }

  private near(p: THREE.Vector3) {
    return Math.hypot(p.x - this.plan.doorway.x, p.z - this.plan.doorway.z) < REACH;
  }

  private inDoorway(p: THREE.Vector3) {
    const d = this.doorBox;
    return p.x > d.minX - 0.6 && p.x < d.maxX + 0.6 && p.z > d.minZ - 0.6 && p.z < d.maxZ + 0.6;
  }

  isInside(p: THREE.Vector3) {
    const b = this.plan.bounds;
    if (p.x < b.minX || p.x > b.maxX || p.z < b.minZ || p.z > b.maxZ) return false;
    const l = p.clone().setY(this.plan.position.y).applyMatrix4(this.toLocal);
    return l.x > INTERIOR.minX && l.x < INTERIOR.maxX && l.z > INTERIOR.minZ && l.z < INTERIOR.maxZ;
  }

  interact(p: THREE.Vector3): "open" | "close" | null {
    if (!this.near(p)) return null;
    if (!this.wantOpen) {
      this.wantOpen = true;
      this.awayFor = 0;
      return "open";
    }
    if (this.inDoorway(p)) return null;
    this.wantOpen = false;
    return "close";
  }

  stick(mesh: THREE.Object3D, point: THREE.Vector3) {
    const d = this.doorBox;
    if (point.x < d.minX - 0.3 || point.x > d.maxX + 0.3 || point.z < d.minZ - 0.3 || point.z > d.maxZ + 0.3) return;
    if (point.y > this.plan.position.y + DOOR.top) return;
    const local = point.clone().applyMatrix4(this.toLocal);
    const dir = local.z < (DOOR.minZ + DOOR.maxZ) / 2 ? -1 : 1;
    this.leaves.find((l) => l.dir === dir)?.mesh.attach(mesh);
  }

  update(dt: number, camera: THREE.Vector3): ShopState {
    let closed = false;
    if (this.wantOpen) {
      this.awayFor = this.near(camera) || this.inDoorway(camera) ? 0 : this.awayFor + dt;
      if (this.awayFor > 1.6) {
        this.wantOpen = false;
        closed = true;
      }
    }
    const target = this.wantOpen ? 1 : 0;
    this.open = THREE.MathUtils.clamp(this.open + Math.sign(target - this.open) * dt * 1.3, 0, 1);
    const eased = this.open * this.open * (3 - 2 * this.open);
    // In a hand's width, then apart behind the shop front
    for (const leaf of this.leaves) {
      leaf.mesh.position.x = -0.1 * Math.min(1, eased * 5);
      leaf.mesh.position.z = leaf.dir * SLIDE * eased;
    }
    Object.assign(this.plan.door, eased > 0.6 ? { minX: 1e6, maxX: 1e6, minZ: 1e6, maxZ: 1e6 } : this.doorBox);

    const inside = this.isInside(camera);
    const goal = inside ? 1 - 0.3 * eased : 0;
    this.insideLevel += (goal - this.insideLevel) * (1 - Math.exp(-dt * 3));
    const dist = camera.distanceTo(this.plan.doorway);
    for (const o of this.detail) o.visible = dist < DETAIL_DISTANCE;
    const hum = inside ? 0.85 : (0.08 + 0.3 * eased) / (1 + dist * 0.18);
    let prompt: string | null = null;
    if (this.loaded && this.near(camera) && !this.wantOpen) prompt = inside ? "leave" : "go in";
    return { prompt, inside: this.insideLevel, hum, closed };
  }
}
