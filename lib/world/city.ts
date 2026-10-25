import * as THREE from "three";
import { createRng } from "./random";
import { FACADE, facadeTexture, footprintMaps, gableTexture, roadMaps, ROAD_TILE, snowMaps, type FacadeSet } from "./textures";
import { sway } from "./wind";
import { balconyGeometry, carParts, parkLampGeometry, streetLampGeometry, treeGeometry } from "./props";
import { groundUniforms, snowify } from "./materials";
import { interiorize } from "./interiors";
import { groundHeight, POND, pondDistance, registerTrail, terrainHeight } from "./noise";
import { createPond } from "./pond";
import { BUILDING_MODELS, chunkedInstances, type BuildingModel, type Models } from "./models";
import { buildModelBlocks, modelCars, modelLampFactory, type Slot } from "./modelProps";
import { planShop } from "./shop";
import { planStation } from "./station";
import { planPark } from "./park";

/** Footprint in plan; `top` (world height) makes it something you can climb onto instead of a wall. */
// Car body heights along its length (model space, metres), with the snow on top: boot, roof, bonnet
const CAR_DECKS: [number, number, number][] = [
  [-2.2, -1.2, 1.02],
  [-1.2, 0.45, 1.42],
  [0.45, 2.2, 0.98],
];

/**
 * Footprint in plan; `top` (world height) makes it something you can climb onto instead of a wall.
 * `height` is only for thrown things: how tall the obstacle is when it isn't climbable.
 */
export type Collider = { minX: number; maxX: number; minZ: number; maxZ: number; top?: number; height?: number };
export type LightSource = {
  position: THREE.Vector3;
  color: THREE.Color;
  strength: number;
  omni: boolean;
  lamp: boolean;
  bulb?: THREE.Mesh;
  set?: BuildingSet;
  /** 0-1 multiplier driven over time (switch-on wave, failing lamp); missing means fully on. */
  power?: number;
};

export type BuildingSet = "proc" | BuildingModel;

export const BOUNDS = { minX: -110, maxX: 230, minZ: -320, maxZ: 170 };

const CELL_W = 3;
const FLOOR_H = 2.8;
export const STREET_LIGHT = new THREE.Color("#8fd0ff");
const PARK_LIGHT = new THREE.Color("#c4e2ff");
const WARM_LIGHT = new THREE.Color("#ffb46a");

function shadowed<T extends THREE.Object3D>(o: T, cast = true, receive = true) {
  o.castShadow = cast;
  o.receiveShadow = receive;
  return o;
}

export function buildCity(scene: THREE.Scene, models: Models = {}) {
  const rng = createRng(1989);
  const colliders: Collider[] = [];
  const buildingSets: BuildingSet[] = ["proc", ...BUILDING_MODELS.filter((k) => models[k])];
  const buildingColliders = Object.fromEntries(buildingSets.map((k) => [k, [] as Collider[]])) as Record<BuildingSet, Collider[]>;
  const groups = Object.fromEntries(buildingSets.map((k) => [k, new THREE.Group()])) as Record<BuildingSet, THREE.Group>;
  scene.add(...Object.values(groups));
  const lights: LightSource[] = [];
  const box = (x: number, z: number, sx: number, sz: number): Collider => ({ minX: x - sx / 2, maxX: x + sx / 2, minZ: z - sz / 2, maxZ: z + sz / 2 });
  const block = (x: number, z: number, sx: number, sz: number) => colliders.push(box(x, z, sx, sz));
  // Trees and lamps must stay clear of every building variant, whichever one is switched on
  const allColliders = () => [...colliders, ...Object.values(buildingColliders).flat()];
  const free = (x: number, z: number, pad: number) =>
    pondDistance(x, z) > 1.35 && !allColliders().some((c) => x > c.minX - pad && x < c.maxX + pad && z > c.minZ - pad && z < c.maxZ + pad);

  const trail = [
    new THREE.Vector2(9, 58),
    new THREE.Vector2(19, 56),
    new THREE.Vector2(62, 38),
    new THREE.Vector2(78, 5),
    new THREE.Vector2(84, -40),
    new THREE.Vector2(98, -88),
    new THREE.Vector2(110, -140),
    new THREE.Vector2(140, -190),
    new THREE.Vector2(200, -230),
  ];
  registerTrail(trail);

  // Ground
  const snow = snowMaps();
  const road = roadMaps();
  const GW = 380;
  const GD = 520;
  const gcx = 60;
  const gcz = -75;
  for (const t of [snow.map, snow.normalMap, snow.roughnessMap]) t.repeat.set(GW / 4, GD / 4);
  const groundGeo = new THREE.PlaneGeometry(GW, GD, GW, GD);
  groundGeo.rotateX(-Math.PI / 2);
  const gp = groundGeo.getAttribute("position");
  for (let i = 0; i < gp.count; i++) {
    gp.setY(i, terrainHeight(gp.getX(i) + gcx, gp.getZ(i) + gcz));
  }
  groundGeo.computeVertexNormals();
  const hw = GW + 1;
  const hd = GD + 1;
  const heights = new Uint16Array(hw * hd);
  for (let j = 0; j < hd; j++) {
    for (let i = 0; i < hw; i++) heights[j * hw + i] = THREE.DataUtils.toHalfFloat(terrainHeight(gcx - GW / 2 + i, gcz - GD / 2 + j));
  }
  const heightTex = new THREE.DataTexture(heights, hw, hd, THREE.RedFormat, THREE.HalfFloatType);
  heightTex.magFilter = heightTex.minFilter = THREE.LinearFilter;
  heightTex.needsUpdate = true;
  groundUniforms.uGroundTex.value = heightTex;
  // Texel centres sit on whole metres, so the box is shifted by half a texel
  groundUniforms.uGroundBox.value.set(gcx - GW / 2 - 0.5, gcz - GD / 2 - 0.5, hw, hd);
  const groundMat = snowify(
    new THREE.MeshStandardMaterial({
      map: snow.map,
      normalMap: snow.normalMap,
      normalScale: new THREE.Vector2(1, 1),
      roughnessMap: snow.roughnessMap,
      roughness: 1,
    }),
    { sparkle: 1, detail: true, road: { ...road, halfWidth: ROAD_TILE.width / 2, tileLength: ROAD_TILE.length, zRange: [BOUNDS.minZ, BOUNDS.maxZ] } }
  );
  const ground = shadowed(new THREE.Mesh(groundGeo, groundMat), false, true);
  ground.position.set(gcx, 0, gcz);
  scene.add(ground);
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400).rotateX(-Math.PI / 2), groundMat);
  outer.position.y = -0.4;
  scene.add(outer);


  // Footprints along the park trail
  const prints = footprintMaps();
  const printMat = new THREE.MeshStandardMaterial({
    color: "#c9d2ea",
    alphaMap: prints.alphaMap,
    normalMap: prints.normalMap,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    roughness: 0.9,
  });
  for (let i = 0; i < trail.length - 1; i++) {
    const a = trail[i];
    const b = trail[i + 1];
    const len = a.distanceTo(b);
    const geo = new THREE.PlaneGeometry(1.6, len, 1, Math.ceil(len));
    geo.rotateX(-Math.PI / 2);
    geo.rotateY(Math.atan2(b.x - a.x, b.y - a.y));
    const uv = geo.getAttribute("uv");
    for (let v = 0; v < uv.count; v++) uv.setY(v, (uv.getY(v) * len) / 8);
    const pos = geo.getAttribute("position");
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v) + (a.x + b.x) / 2;
      const z = pos.getZ(v) + (a.y + b.y) / 2;
      pos.setXYZ(v, x, groundHeight(x, z) + 0.015, z);
    }
    geo.computeVertexNormals();
    const seg = shadowed(new THREE.Mesh(geo, printMat), false, true);
    seg.renderOrder = 1;
    scene.add(seg);
  }

  // Panel blocks
  const tints: [number, number, number][] = [
    [132, 136, 148],
    [120, 128, 144],
    [140, 137, 138],
    [124, 131, 136],
  ];
  const facades: FacadeSet[] = tints.map((t, i) => facadeTexture(100 + i, t, 0.08 + i * 0.025));
  const gables: FacadeSet[] = tints.map((t, i) => gableTexture(200 + i, t));
  const roofMat = snowify(new THREE.MeshStandardMaterial({ color: "#d9e1f2", roughness: 0.85 }), { sparkle: 0.5 });
  const concrete = snowify(new THREE.MeshStandardMaterial({ color: "#7d8394", roughness: 0.92 }), { coat: 0.35, contact: 0.4 });
  const balconyGeo = balconyGeometry();
  const balconies: THREE.Matrix4[] = [];

  const faceMaterial = (set: FacadeSet, widthM: number, floors: number, seed: number, cols = FACADE.cols) => {
    const r = createRng(seed);
    const rx = widthM / CELL_W / cols;
    const ry = floors / FACADE.floors;
    const ox = r.int(0, cols) / cols;
    const oy = r.int(0, FACADE.floors) / FACADE.floors;
    const [map, emissive, normal] = [set.map, set.emissive, set.normal].map((t) => {
      const c = t.clone();
      c.repeat.set(rx, ry);
      c.offset.set(ox, oy);
      c.needsUpdate = true;
      return c;
    });
    const mat = snowify(
      new THREE.MeshStandardMaterial({
        map,
        emissiveMap: emissive,
        emissive: new THREE.Color("#ffffff"),
        emissiveIntensity: 3.2,
        normalMap: normal,
        roughness: 0.9,
      }),
      { contact: 0.4 }
    );
    return cols === FACADE.cols ? interiorize(mat, { litRatio: 0.13, faceWidth: widthM }) : mat;
  };

  const entranceMat = snowify(new THREE.MeshStandardMaterial({ color: "#151a26", roughness: 0.6, metalness: 0.3 }), { contact: 0.5 });
  const canopyMat = snowify(new THREE.MeshStandardMaterial({ color: "#6f7586", roughness: 0.9 }), { coat: 0.5 });
  const warmBulb = new THREE.MeshStandardMaterial({ color: "#000", emissive: WARM_LIGHT, emissiveIntensity: 8 });

  // The supermarket goes in first; any panel block standing where it goes is left out (in every building set)
  const shop = planShop(groundHeight);
  const station = planStation(groundHeight);
  const park = planPark(trail, POND, pondDistance, groundHeight);
  colliders.push(...park.colliders);
  colliders.push(...shop.colliders, ...station.colliders);
  lights.push(...shop.lights, ...station.lights);
  const SHOP_CLEARANCE = 3;
  const onShop = (x: number, z: number, sx: number, sz: number) =>
    [shop.bounds, station.footprint].some(
      (b) =>
        x - sx / 2 < b.maxX + SHOP_CLEARANCE &&
        x + sx / 2 > b.minX - SHOP_CLEARANCE &&
        z - sz / 2 < b.maxZ + SHOP_CLEARANCE &&
        z + sz / 2 > b.minZ - SHOP_CLEARANCE
    );

  const slots: Slot[] = [];
  const addPanelBlock = (x: number, z: number, sx: number, sz: number, floors: number, entranceSide: 1 | -1, tower = false) => {
    // A skipped block still draws its random numbers, so everything after it in the city stays where it was
    const skip = onShop(x, z, sx, sz);
    const into = skip ? new THREE.Group() : groups.proc;
    const h = floors * FLOOR_H;
    const seed = rng.int(0, 1e6);
    const v = rng.int(0, 3);
    const g = rng.int(0, 3);
    const side = (width: number, windows: boolean, i: number) =>
      windows || tower ? faceMaterial(facades[(v + i) % 4], width, floors, seed + i) : faceMaterial(gables[g], width, floors, seed + i, 4);
    const longX = sx > sz;
    const mats = [side(sz, !longX, 0), side(sz, !longX, 1), roofMat, roofMat, side(sx, longX, 2), side(sx, longX, 3)];
    const mesh = shadowed(new THREE.Mesh(new THREE.BoxGeometry(sx, h, sz), mats));
    mesh.position.set(x, h / 2, z);
    into.add(mesh);
    const plinth = shadowed(new THREE.Mesh(new THREE.BoxGeometry(sx + 0.1, 1.2, sz + 0.1), concrete));
    plinth.position.set(x, -0.3, z);
    into.add(plinth);

    const parapet = shadowed(new THREE.Mesh(new THREE.BoxGeometry(sx + 0.3, 0.9, sz + 0.3), concrete));
    parapet.position.set(x, h + 0.45, z);
    into.add(parapet);
    const roofSnow = new THREE.Mesh(new THREE.BoxGeometry(sx + 0.36, 0.12, sz + 0.36), roofMat);
    roofSnow.position.set(x, h + 0.94, z);
    into.add(roofSnow);
    if (!skip) {
      buildingColliders.proc.push(box(x, z, sx, sz));
      slots.push({ x, z, sx, sz, floors, tower, face: entranceSide });
    }

    const along = longX ? sx : sz;
    if (!tower && rng.chance(0.7)) {
      const cols = Math.round(along / CELL_W);
      const stacks: number[] = [];
      for (let i = 1; i < cols - 1; i++) if (i % 5 === 1 || i % 5 === 3) stacks.push(i);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      for (const face of [-1, 1]) {
        const normal = longX ? new THREE.Vector3(0, 0, face) : new THREE.Vector3(face, 0, 0);
        q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        for (const i of stacks) {
          const t = -along / 2 + (i + 0.5) * CELL_W;
          for (let f = 1; f < floors; f++) {
            const px = longX ? x + t : x + face * (sx / 2);
            const pz = longX ? z + face * (sz / 2) : z + t;
            m.compose(new THREE.Vector3(px, f * FLOOR_H + 0.02, pz), q, new THREE.Vector3(1, 1, 1));
            if (!skip) balconies.push(m.clone());
          }
        }
      }
    }

    const n = Math.max(1, Math.floor(along / 24));
    for (let i = 0; i < n; i++) {
      const t = ((i + 0.5) / n - 0.5) * along;
      const normal = longX ? new THREE.Vector3(0, 0, entranceSide) : new THREE.Vector3(entranceSide, 0, 0);
      const ex = longX ? x + t : x + entranceSide * (sx / 2);
      const ez = longX ? z + entranceSide * (sz / 2) : z + t;
      const door = new THREE.Mesh(new THREE.BoxGeometry(longX ? 1.8 : 0.12, 2.3, longX ? 0.12 : 1.8), entranceMat);
      door.position.set(ex, 1.15, ez);
      into.add(door);
      const canopy = shadowed(new THREE.Mesh(new THREE.BoxGeometry(longX ? 2.8 : 1.6, 0.2, longX ? 1.6 : 2.8), canopyMat));
      canopy.position.set(ex + normal.x * 0.8, 2.75, ez + normal.z * 0.8);
      into.add(canopy);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), warmBulb);
      bulb.position.set(ex + normal.x * 0.5, 2.55, ez + normal.z * 0.5);
      into.add(bulb);
      if (!skip) lights.push({ position: bulb.position.clone(), color: WARM_LIGHT, strength: 0.06, omni: true, lamp: false, set: "proc" });
    }
  };

  let z = 150;
  while (z > -300) {
    const len = rng.pick([48, 60, 72, 90]);
    const floors = rng.pick([9, 9, 12, 12, 14]);
    addPanelBlock(-27, z - len / 2, 14, len, floors, 1);
    if (rng.chance(0.8)) addPanelBlock(-72, z - len / 2 - rng.range(-10, 10), 14, len, rng.pick([9, 12]), 1);
    z -= len + rng.range(18, 30);
  }
  z = 140;
  while (z > -300) {
    if (rng.chance(0.6)) {
      addPanelBlock(26.5, z - 9, 21, 18, rng.pick([14, 16, 16, 18]), -1, true);
      z -= 18 + rng.range(26, 40);
    } else {
      addPanelBlock(36, z - 7, 42, 14, rng.pick([9, 12]), 1);
      z -= 14 + rng.range(26, 36);
    }
  }
  groups.proc.add(...chunkedInstances(balconyGeo, concrete, balconies));

  BUILDING_MODELS.forEach((k, i) => {
    if (models[k]) buildModelBlocks(models[k]!, slots, groups[k], buildingColliders[k], i * 7 + 3);
  });

  // Lamps
  const metal = snowify(new THREE.MeshStandardMaterial({ color: "#3a4052", roughness: 0.55, metalness: 0.6 }), { coat: 0.4, coatNoise: 0.1, contact: 0.25 });
  const streetLampGeo = streetLampGeometry();
  const parkLampGeo = parkLampGeometry();

  const lampModel = modelLampFactory(models, 8.6);
  const addLamp = (x: number, zz: number, kind: "street" | "park", flip = false) => {
    const base = groundHeight(x, zz);
    if (kind === "street" && lampModel) {
      const made = lampModel(x, base - 0.2, zz, flip ? 1 : -1, STREET_LIGHT);
      scene.add(made.object);
      colliders.push({ minX: x - 0.3, maxX: x + 0.3, minZ: zz - 0.3, maxZ: zz + 0.3 });
      lights.push({ position: made.head.clone().setY(made.head.y - 0.15), color: STREET_LIGHT, strength: 1, omni: false, lamp: true, bulb: made.bulb });
      return;
    }
    const lamp = shadowed(new THREE.Mesh(kind === "street" ? streetLampGeo : parkLampGeo, metal), kind === "street");
    lamp.position.set(x, base - 0.2, zz);
    if (flip) lamp.rotation.y = Math.PI;
    scene.add(lamp);
    const headLocal = kind === "street" ? new THREE.Vector3(flip ? 1.55 : -1.55, 7.78, 0) : new THREE.Vector3(0, 4.24, 0);
    const head = headLocal.add(lamp.position);
    const color = kind === "street" ? STREET_LIGHT : PARK_LIGHT;
    const bulbMat = new THREE.MeshStandardMaterial({ color: "#000", emissive: color, emissiveIntensity: 14 });
    const bulb = new THREE.Mesh(
      kind === "street" ? new THREE.BoxGeometry(0.75, 0.05, 0.32) : new THREE.CylinderGeometry(0.38, 0.38, 0.03, 20),
      bulbMat
    );
    bulb.position.copy(head);
    scene.add(bulb);
    colliders.push({ minX: x - 0.3, maxX: x + 0.3, minZ: zz - 0.3, maxZ: zz + 0.3 });
    lights.push({ position: head.clone().setY(head.y - 0.1), color, strength: kind === "street" ? 1 : 0.65, omni: false, lamp: true, bulb });
  };

  for (let zz = 150; zz > -310; zz -= 30) {
    addLamp(6.8, zz, "street");
    if (Math.abs((zz / 30) % 2) === 1) addLamp(-6.8, zz - 15, "street", true);
  }
  for (let i = 1; i < 6; i++) {
    const a = trail[i];
    const b = trail[i + 1];
    const len = a.distanceTo(b);
    const side = i % 2 === 0 ? 1 : -1;
    const lx = a.x + ((b.y - a.y) / len) * 2.2 * side;
    const lz = a.y - ((b.x - a.x) / len) * 2.2 * side;
    if (free(lx, lz, 1)) addLamp(lx, lz, "park");
  }

  // Frozen pond, with one lamp on its bank so the ice catches a glint
  addLamp(POND.x - Math.cos(POND.rot) * (POND.rx + 2.2), POND.z + Math.sin(POND.rot) * (POND.rx + 2.2), "park");
  const pondCentre = new THREE.Vector3(POND.x, 0, POND.z);
  scene.add(createPond(lights.filter((l) => l.lamp && l.position.clone().setY(0).distanceTo(pondCentre) < 45)));

  // Cars
  const carVariants = [0, 1, 2].map((s) => carParts(50 + s));
  const paintMat = snowify(new THREE.MeshPhysicalMaterial({ roughness: 0.4, metalness: 0.45, clearcoat: 0.7, clearcoatRoughness: 0.25 }), {
    coat: 0.55,
    coatNoise: 0.6,
  });
  const glassMat = snowify(new THREE.MeshPhysicalMaterial({ color: "#04060a", roughness: 0.06, metalness: 0.1, clearcoat: 1 }), {
    coat: 0.5,
    coatNoise: 0.6,
  });
  const tyreMat = new THREE.MeshStandardMaterial({ color: "#0c0d10", roughness: 0.9 });
  const carColors = ["#1b1f2a", "#3a1a1e", "#1c2a40", "#2a2a2e", "#4a4f5a", "#141820", "#5a4a32"];
  const cars: { x: number; z: number; ry: number; color: THREE.Color; dir?: number }[] = [];
  for (let zz = 145; zz > -300; ) {
    if (rng.chance(0.7)) {
      const n = rng.int(2, 6);
      for (let i = 0; i < n; i++) {
        cars.push({ x: -7.6 + rng.range(-0.15, 0.15), z: zz, ry: Math.PI / 2 + rng.range(-0.04, 0.04), color: new THREE.Color(rng.pick(carColors)) });
        zz -= 5.2 + rng.range(0, 0.7);
      }
    }
    zz -= rng.range(8, 22);
  }
  for (let zz = 120; zz > -300; ) {
    if (rng.chance(0.35)) cars.push({ x: 8.0, z: zz, ry: -Math.PI / 2, color: new THREE.Color(rng.pick(carColors)) });
    zz -= rng.range(10, 30);
  }
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const carModels = models.car ? modelCars(models, cars) : [];
  // Car meshes, for things thrown at them to hit the real body rather than the climbing boxes
  const carMeshes: THREE.Object3D[] = [...carModels];
  if (carModels.length) {
    scene.add(...carModels);
    // Boot, roof and bonnet as three steps, so a jump gets you onto the bonnet and a second onto the roof
    for (const c of cars) {
      for (const [z0, z1, h] of CAR_DECKS) {
        const a = c.z + (c.dir ?? 1) * z0;
        const b = c.z + (c.dir ?? 1) * z1;
        colliders.push({ minX: c.x - 0.95, maxX: c.x + 0.95, minZ: Math.min(a, b), maxZ: Math.max(a, b), top: h });
      }
    }
  }
  const carBuckets = carVariants.map(() => [] as typeof cars);
  if (!carModels.length) cars.forEach((c) => carBuckets[rng.int(0, carVariants.length - 1)].push(c));
  carBuckets.forEach((list, vi) => {
    if (!list.length) return;
    const v = carVariants[vi];
    const meshes = [
      shadowed(new THREE.InstancedMesh(v.body, paintMat, list.length)),
      shadowed(new THREE.InstancedMesh(v.glass, glassMat, list.length)),
      shadowed(new THREE.InstancedMesh(v.wheels, tyreMat, list.length)),
    ];
    list.forEach((c, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.ry);
      m.compose(new THREE.Vector3(c.x, -0.08, c.z), q, new THREE.Vector3(1, 1, 1));
      meshes.forEach((mesh) => mesh.setMatrixAt(i, m));
      meshes[0].setColorAt(i, c.color);
      colliders.push({ minX: c.x - 1.0, maxX: c.x + 1.0, minZ: c.z - 2.2, maxZ: c.z + 2.2 });
    });
    scene.add(...meshes);
    carMeshes.push(...meshes);
  });

  // Kiosks
  const kioskMat = snowify(new THREE.MeshStandardMaterial({ color: "#b9c0cf", roughness: 0.7, metalness: 0.2 }), { coat: 0.5, contact: 0.4 });
  const trimMat = new THREE.MeshStandardMaterial({ color: "#1d3d9a", roughness: 0.5, metalness: 0.3 });
  const trimWarm = new THREE.MeshStandardMaterial({ color: "#e0b030", roughness: 0.5 });
  const shopGlow = new THREE.MeshStandardMaterial({ color: "#000", emissive: "#d6ecff", emissiveIntensity: 2.2 });
  const addKiosk = (x: number, zz: number, ry: number, colorful: boolean) => {
    const g = new THREE.Group();
    const box = shadowed(new THREE.Mesh(new THREE.BoxGeometry(6, 3, 4.5), kioskMat));
    box.position.y = 1.5;
    const roof = shadowed(new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.3, 5.3), roofMat));
    roof.position.y = 3.15;
    roof.rotation.z = 0.05;
    // A small shop window: full brightness, but a modest patch of light rather than a lit wall
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.95), shopGlow);
    win.position.set(0.8, 1.75, 2.26);
    const door = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 2.1), entranceMat);
    door.position.set(-2, 1.05, 2.26);
    g.add(box, roof, win, door);
    if (colorful) {
      const t1 = new THREE.Mesh(new THREE.BoxGeometry(6.1, 0.22, 4.6), trimMat);
      t1.position.y = 2.85;
      const t2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.6, 0.3), trimWarm);
      t2.position.set(3.02, 1.4, 2.1);
      const t3 = t2.clone();
      t3.position.z = -2.1;
      g.add(t1, t2, t3);
    }
    g.position.set(x, -0.1, zz);
    g.rotation.y = ry;
    scene.add(g);
    const winWorld = new THREE.Vector3(0.6, 1.7, 3.2).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry).add(g.position);
    lights.push({ position: winWorld, color: new THREE.Color("#cfe6ff"), strength: 0.075, omni: true, lamp: false });
    const r = Math.abs(Math.sin(ry)) > 0.5;
    const hx = (r ? 4.6 : 6.2) / 2;
    const hz = (r ? 6.2 : 4.6) / 2;
    colliders.push({ minX: x - hx, maxX: x + hx, minZ: zz - hz, maxZ: zz + hz, height: 3.2 });
  };
  addKiosk(-14, 72, Math.PI / 2, false);
  addKiosk(13, 46, -Math.PI / 2, true);
  addKiosk(-13, -120, Math.PI / 2, true);

  // Trees
  const treeMat = sway(
    snowify(new THREE.MeshStandardMaterial({ color: "#2a2830", roughness: 0.9 }), { coat: 0.3, coatNoise: 0.5, contact: 0.3 }),
    8
  );
  const variants = {
    birch: [0, 1, 2].map((s) => treeGeometry(400 + s, "birch")),
    dark: [0, 1].map((s) => treeGeometry(500 + s, "dark")),
    bush: [0, 1].map((s) => treeGeometry(600 + s, "bush")),
  };
  type Spot = { x: number; z: number; s: number };
  const spots: Record<keyof typeof variants, Spot[]> = { birch: [], dark: [], bush: [] };
  const place = (kind: keyof typeof variants, x: number, zz: number, s: number, pad: number) => {
    if (!free(x, zz, pad)) return;
    spots[kind].push({ x, z: zz, s });
    colliders.push({ minX: x - 0.25, maxX: x + 0.25, minZ: zz - 0.25, maxZ: zz + 0.25 });
  };
  for (let i = 0; i < 40; i++) place("birch", rng.range(12, 19), rng.range(-300, 160), rng.range(0.9, 1.3), 2);
  for (let i = 0; i < 30; i++) place("dark", rng.range(-20, -13), rng.range(-300, 160), rng.range(0.9, 1.2), 2.5);
  for (let i = 0; i < 120; i++) place("birch", rng.range(52, 130), rng.range(-260, 150), rng.range(1, 1.5), 3);
  for (let i = 0; i < 30; i++) place("dark", rng.range(52, 130), rng.range(-260, 150), rng.range(1, 1.4), 3);
  for (let i = 0; i < 25; i++) place("dark", rng.range(150, 230), rng.range(-320, 170), rng.range(0.8, 1.2), 2);
  for (let i = 0; i < 260; i++) spots.bush.push({ x: rng.range(128, 230), z: rng.range(-320, 170), s: rng.range(0.8, 1.8) });

  for (const kind of Object.keys(variants) as (keyof typeof variants)[]) {
    const geos = variants[kind];
    const buckets = geos.map(() => [] as Spot[]);
    spots[kind].forEach((p) => buckets[rng.int(0, geos.length - 1)].push(p));
    buckets.forEach((list, vi) => {
      if (!list.length) return;
      const matrices = list.map((p) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
        return new THREE.Matrix4().compose(new THREE.Vector3(p.x, groundHeight(p.x, p.z) - 0.15, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
      });
      scene.add(...chunkedInstances(geos[vi], treeMat, matrices, kind !== "bush", false));
    });
  }

  return { colliders, buildingColliders, groups, lights, buildingSets, trail, carMeshes, shop, station, park };
}
