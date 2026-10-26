import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { Collider, LightSource } from "./city";
import { snowify } from "./materials";
import { toFloat } from "./models";

const MODEL = "/models/opt/supermarket.glb";

// Model space, metres. The supermarket is a 28 x 16 m hall; its glass front faces -z, the entrance at its left end
const WALLS = { minX: -13.2, maxX: 15.0, minZ: -7.45, maxZ: 8.8 };
const HEIGHT = 6.1;
// The ceiling under the trusses
const CEILING = 4.38;
const FLOOR = 0.09;
const DOOR = { minX: -11.27, maxX: -8.63, z: -7.27 };
// Each of the two sliding leaves travels this far, out over the fixed glass beside it
const SLIDE = 1.2;
const INTERIOR = { minX: -12.7, maxX: 14.1, minZ: -7.15, maxZ: 8.3 };
// Gondolas, fridges, freezers and the tills, measured off the plan
// Measured from the model, shelf lips included: the near plane must never reach into the goods (or the checkout),
// or you see straight through them
const FURNITURE: [number, number, number, number][] = [
  [-6.8, 1.1, -4.05, -2.3],
  [3.2, 11.1, -4.05, -2.3],
  [-6.8, 1.1, -0.25, 1.5],
  [3.2, 11.1, -0.25, 1.5],
  [-6.8, 1.1, 3.25, 5.0],
  [3.2, 11.1, 3.25, 5.0],
  [13.0, 15.0, -5.4, 8.0],
  [-12.8, -11.2, -4.4, 2.5],
  [-9.5, -0.5, 7.0, 8.8],
  // The freezers along the back wall, past the end of the chiller
  [-0.5, 8.7, 7.0, 8.8],
  [-7.2, 6.7, -6.75, -5.9],
  [7.5, 12.8, -6.5, -5.5],
  // The checkout, belt and till
  [-11.8, -10.2, 3.25, 6.0],
  // Two trolleys left standing in the aisles
  [-8.67, -7.29, 1.65, 2.87],
  [5.33, 6.53, -2.24, -1.04],
];
const WALL = 0.3;
// Within this distance of the doorway (m) you can open or close it
const REACH = 2.6;
// The shelves and products only render this close; further away the glass and the fog hide them anyway
const DETAIL_DISTANCE = 75;

/** Where the shop stands and everything the world needs from it before its model has loaded. */
export type ShopPlan = {
  position: THREE.Vector3;
  ry: number;
  colliders: Collider[];
  door: Collider;
  bounds: Collider;
  /** The doorway's centre on the ground, and the direction from it into the shop. */
  doorway: THREE.Vector3;
  inward: THREE.Vector3;
  lights: LightSource[];
};

/** Shared with the fog and the snowfall, so neither falls inside the shop: world xz box and roof height. */
export type InteriorUniforms = {
  uShop: { value: THREE.Vector4 };
  uShopTop: { value: number };
  uShopFloor: { value: number };
};
const interiorUniforms = (): InteriorUniforms => ({
  uShop: { value: new THREE.Vector4(0, 0, -1, -1) },
  uShopTop: { value: -100 },
  uShopFloor: { value: 0 },
});
export const shopUniforms = interiorUniforms();
export const stationUniforms = interiorUniforms();

/** Anything the player can walk into: the supermarket, the gas station. */
export interface Venue {
  group: THREE.Group;
  /** Sliding automatic doors (with their motor sound) rather than a door you push. */
  sliding: boolean;
  load(renderer: THREE.WebGLRenderer): Promise<void>;
  update(dt: number, camera: THREE.Vector3): ShopState;
  interact(p: THREE.Vector3): "open" | "close" | null;
  isInside(p: THREE.Vector3): boolean;
  stick(mesh: THREE.Object3D, point: THREE.Vector3): void;
}

export function frame(position: THREE.Vector3, ry: number) {
  return new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(1, 1, 1));
}

/** A model-space rectangle as a world-space box (the shop only ever turns by quarter turns). */
export function worldBox(m: THREE.Matrix4, x0: number, x1: number, z0: number, z1: number, extra: Partial<Collider> = {}): Collider {
  const pts = [
    [x0, z0],
    [x1, z0],
    [x0, z1],
    [x1, z1],
  ].map(([x, z]) => new THREE.Vector3(x, 0, z).applyMatrix4(m));
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    maxX: Math.max(...pts.map((p) => p.x)),
    minZ: Math.min(...pts.map((p) => p.z)),
    maxZ: Math.max(...pts.map((p) => p.z)),
    ...extra,
  };
}

/**
 * The supermarket stands on the west side of the street a little ahead of the start, its glass front to the road
 * (the panel block that stood there makes way). Lays out its walls, its sliding doors and its floor.
 */
export function planShop(heightAt: (x: number, z: number) => number): ShopPlan {
  // A quarter turn clockwise: model -z (the front) faces the road (+x), model x runs along the street
  const ry = -Math.PI / 2;
  const frontX = -12.6;
  // A couple of minutes' walk from the start: first the empty street, then this
  const position = new THREE.Vector3(frontX - Math.abs(WALLS.minZ), 0, -42);
  let m = frame(position, ry);
  const bounds = worldBox(m, WALLS.minX, WALLS.maxX, WALLS.minZ, WALLS.maxZ);
  let base = -Infinity;
  for (let i = 0; i <= 10; i++) {
    for (let j = 0; j <= 16; j++) {
      base = Math.max(base, heightAt(THREE.MathUtils.lerp(bounds.minX, bounds.maxX, i / 10), THREE.MathUtils.lerp(bounds.minZ, bounds.maxZ, j / 16)));
    }
  }
  // The slab sits a little proud of the snow
  position.y = base + 0.04;
  m = frame(position, ry);

  const wall = (x0: number, x1: number, z0: number, z1: number) => worldBox(m, x0, x1, z0, z1, { height: HEIGHT });
  const door = wall(DOOR.minX, DOOR.maxX, WALLS.minZ, WALLS.minZ + WALL);
  const colliders = [
    wall(WALLS.minX, WALLS.maxX, WALLS.maxZ - WALL, WALLS.maxZ),
    wall(WALLS.minX, WALLS.minX + WALL, WALLS.minZ, WALLS.maxZ),
    wall(WALLS.maxX - WALL, WALLS.maxX, WALLS.minZ, WALLS.maxZ),
    wall(WALLS.minX, DOOR.minX, WALLS.minZ, WALLS.minZ + WALL),
    wall(DOOR.maxX, WALLS.maxX, WALLS.minZ, WALLS.minZ + WALL),
    door,
    ...FURNITURE.map(([x0, x1, z0, z1]) => worldBox(m, x0, x1, z0, z1, { height: 2.2 })),
    // The floor, a step up from the pavement
    worldBox(m, INTERIOR.minX, INTERIOR.maxX, WALLS.minZ - 0.02, INTERIOR.maxZ, { top: position.y + FLOOR }),
  ];
  const local = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m);
  const doorway = local((DOOR.minX + DOOR.maxX) / 2, 0, DOOR.z);
  const inward = local((DOOR.minX + DOOR.maxX) / 2, 0, DOOR.z + 1).sub(doorway).normalize();
  // No glow lights of its own in the fog: placed outside they hung over the pavement as a row of floating balls, and
  // even tucked behind the glass they lit patches of blank wall. The lit windows and the neon carry it
  const lights: LightSource[] = [];
  return { position, ry, colliders, door, bounds, doorway, inward, lights };
}

const doorUniforms = {
  uDoorCentre: { value: new THREE.Vector3() },
  uDoorAlong: { value: new THREE.Vector2(1, 0) },
  uDoorGap: { value: 0 },
};

/** Big window panes run across the doorway: open a gap in them as wide as the leaves have slid apart. */
function gapInGlass(material: THREE.MeshStandardMaterial) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, doorUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGlassPos;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvGlassPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vGlassPos;\nuniform vec3 uDoorCentre;\nuniform vec2 uDoorAlong;\nuniform float uDoorGap;"
      )
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
        {
          vec2 d = vGlassPos.xz - uDoorCentre.xz;
          float along = dot(d, uDoorAlong);
          float across = dot(d, vec2(-uDoorAlong.y, uDoorAlong.x));
          if (abs(along) < uDoorGap && abs(across) < 0.12 && vGlassPos.y < uDoorCentre.y + 2.8) discard;
        }`
      );
  };
  material.customProgramCacheKey = () => "shop-glass";
  material.needsUpdate = true;
}

/** Self-lit from inside: every surface within the walls, or facing into the shop, glows as if under the tubes. */
export function lightFromInside(
  material: THREE.MeshStandardMaterial,
  strength: number,
  wall = false,
  box: InteriorUniforms = shopUniforms,
  /** How much sky light the outside of the building keeps (the supermarket's shell is darkened to sit in the night) */
  outside = 0.3
) {
  if (wall) {
    material.map = plasterTexture();
    material.defines = { ...material.defines, SHOP_WALL: "" };
  }
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, box, { uShopLight: { value: strength }, uShopOutside: { value: outside } });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vShopPos;\nvarying vec3 vShopNormal;")
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        vec4 shopWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          shopWorld = instanceMatrix * shopWorld;
        #endif
        vShopPos = (modelMatrix * shopWorld).xyz;
        vShopNormal = normalize(mat3(modelMatrix) * objectNormal);`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vShopPos;
        varying vec3 vShopNormal;
        uniform vec4 uShop;
        uniform float uShopTop;
        uniform float uShopFloor;
        uniform float uShopLight;
        uniform float uShopOutside;
        // 1 for surfaces inside the shop (within its walls, or facing into it), 0 for the outside of the building
        float shopInside(vec3 p) {
          float loose = step(uShop.x - 0.05, p.x) * step(p.x, uShop.z + 0.05) * step(uShop.y - 0.05, p.z) * step(p.z, uShop.w + 0.05);
          float strict = step(uShop.x + 0.2, p.x) * step(p.x, uShop.z - 0.2) * step(uShop.y + 0.2, p.z) * step(p.z, uShop.w - 0.2);
          vec3 toCentre = vec3((uShop.x + uShop.z) * 0.5, p.y, (uShop.y + uShop.w) * 0.5) - p;
          float facing = step(0.05, dot(normalize(vShopNormal), normalize(toCentre + 1e-4)));
          return loose * max(strict, facing) * step(p.y, uShopTop);
        }`
      )
      .replace(
        "#include <map_fragment>",
        `#ifdef SHOP_WALL
        {
          // The model's own wall texture is one blurry image stretched over a whole wall: paint the walls instead,
          // with plaster sampled by world position so its grain stays the same size everywhere
          vec3 an = abs(normalize(vShopNormal));
          vec2 wuv = an.y > 0.7 ? vShopPos.xz : (an.x > an.z ? vShopPos.zy : vShopPos.xy);
          vec3 plaster = texture2D(map, wuv / 2.6).rgb;
          float hh = vShopPos.y - uShopFloor;
          // Two-tone, as in every shop of the bloc: oil-painted lower panel, a dark line, whitewash above
          vec3 paint = vec3(0.86, 0.85, 0.82);
          if (an.y < 0.5 && shopInside(vShopPos) > 0.5) {
            float band = 1.0 - smoothstep(1.39, 1.41, hh);
            float line = smoothstep(1.375, 1.385, hh) * (1.0 - smoothstep(1.415, 1.425, hh));
            paint = mix(paint, vec3(0.38, 0.52, 0.47), band);
            paint = mix(paint, vec3(0.12, 0.16, 0.15), line);
            // Scuffed and greyer down where trolleys and boots hit it
            paint *= mix(0.78, 1.0, smoothstep(0.02, 0.32, hh));
          }
          diffuseColor.rgb *= paint * plaster;
        }
        #else
        #include <map_fragment>
        #endif`
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        float shopLit = 0.0;
        {
          vec3 p = vShopPos;
          float lit = shopInside(p);
          shopLit = lit;
          // Lit from the ceiling: floors and shelf tops catch the most, walls less (more near the top), and the
          // undersides facing down stay dark. Cheap, but it gives the room the contrast of real overhead tubes
          vec3 n = normalize(vShopNormal) * (gl_FrontFacing ? 1.0 : -1.0);
          float h = clamp((p.y - uShopFloor) / (uShopTop - uShopFloor), 0.0, 1.0);
          float overhead = n.y > 0.0 ? 0.4 + 0.6 * n.y : 0.4 + 0.3 * n.y;
          overhead *= mix(0.8 + 0.5 * h, 1.0, abs(n.y));
          // Only the diffuse part: metal (carts, chrome) gets its look from reflections instead
          totalEmissiveRadiance += diffuseColor.rgb * (1.0 - metalnessFactor) * uShopLight * lit * overhead;
        }`
      )
      // Indoors the tubes are the light: the street lamps outside must not shine through the roof, and the blue sky
      // light only faintly through the windows
      .replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>
        reflectedLight.directDiffuse *= 1.0 - shopLit;
        reflectedLight.directSpecular *= 1.0 - shopLit;
        // The store's own room reflections belong inside; outside walls keep to the dim street light
        reflectedLight.indirectDiffuse *= mix(uShopOutside, 0.45, shopLit);
        reflectedLight.indirectSpecular *= mix(uShopOutside * 0.5, 1.0, shopLit);`
      );
  };
  material.customProgramCacheKey = () => (wall ? "shop-wall" : "shop-interior");
  material.needsUpdate = true;
}

/** Painted plaster, near white: soft mottling, trowel marks and a few specks, tiled by world position. */
let plaster: THREE.CanvasTexture | undefined;
function plasterTexture() {
  if (plaster) return plaster;
  const size = 512;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#f4f3f1";
  ctx.fillRect(0, 0, size, size);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Draw everything three times shifted by the tile size, so the pattern wraps without seams
  const wrap = (draw: (x: number, y: number) => void, x: number, y: number) => {
    for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) draw(x + dx, y + dy);
  };
  for (let i = 0; i < 260; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 20 + rand() * 90;
    const shade = rand() < 0.5 ? "0,0,0" : "255,255,255";
    const a = 0.012 + rand() * 0.025;
    wrap((px, py) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(${shade},${a})`);
      g.addColorStop(1, `rgba(${shade},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(px - r, py - r, r * 2, r * 2);
    }, x, y);
  }
  // Trowel strokes: long faint arcs
  ctx.lineCap = "round";
  for (let i = 0; i < 70; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const len = 40 + rand() * 120;
    const ang = rand() * Math.PI;
    ctx.strokeStyle = `rgba(0,0,0,${0.012 + rand() * 0.02})`;
    ctx.lineWidth = 2 + rand() * 6;
    wrap((px, py) => {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(px + Math.cos(ang) * len * 0.5 + 10, py + Math.sin(ang) * len * 0.5, px + Math.cos(ang) * len, py + Math.sin(ang) * len);
      ctx.stroke();
    }, x, y);
  }
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.04 + rand() * 0.08})`;
    ctx.fillRect(rand() * size, rand() * size, 1 + rand(), 1 + rand());
  }
  plaster = new THREE.CanvasTexture(c);
  plaster.colorSpace = THREE.SRGBColorSpace;
  plaster.wrapS = plaster.wrapT = THREE.RepeatWrapping;
  plaster.anisotropy = 8;
  return plaster;
}

export function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.5, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Neon lettering on a transparent sheet: the glow drawn into the texture, the tubes bright enough to bloom. */
export function neonSign(text: string, width: number, height: number, color: string) {
  // The glow spills well past the letters: the sheet gets a margin all round so the halo fades out before its edge
  // instead of being cut off in a square
  const pad = height * 0.45;
  const w = width + pad * 2;
  const h = height + pad * 2;
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = Math.round((1024 * h) / w);
  const ctx = c.getContext("2d")!;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const inner = { w: (c.width * width) / w, h: (c.height * height) / h };
  let size = inner.h * 0.8;
  const font = (px: number) => `700 ${px}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
  ctx.font = font(size);
  size *= Math.min(1, (inner.w * 0.9) / ctx.measureText(text).width);
  ctx.font = font(size);
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 0.35;
  ctx.fillStyle = color;
  ctx.fillText(text, c.width / 2, c.height / 2);
  ctx.shadowBlur = size * 0.12;
  ctx.fillStyle = "#ff9a90";
  ctx.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, color: new THREE.Color(2.2, 2.2, 2.2) });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
}

/** `inside` 0-1 (how shut in you are), `hum` 0-1 (how loud the shop is where you stand), `closed` when the doors just shut by themselves. */
export type ShopState = { prompt: string | null; inside: number; hum: number; closed: boolean };

type Leaf = { mesh: THREE.Mesh; dir: number };

/**
 * The supermarket: the only warm, lit thing on its stretch of street. Its windows glow, its neon sign burns, light
 * spills onto the snow; E slides the doors apart, and inside the street goes quiet behind the glass.
 */
export class ShopView implements Venue {
  sliding = true;
  group = new THREE.Group();
  private holder = new THREE.Group();
  private detail: THREE.Object3D[] = [];
  private glass: { mat: THREE.MeshStandardMaterial; opacity: number; env: number }[] = [];
  private leaves: Leaf[] = [];
  private open = 0;
  private wantOpen = false;
  private awayFor = 0;
  private insideLevel = 0;
  private doorBox: Collider;
  private loaded = false;
  private toLocal: THREE.Matrix4;

  constructor(
    private plan: ShopPlan,
    private heightAt: (x: number, z: number) => number
  ) {
    this.toLocal = frame(plan.position, plan.ry).invert();
    this.doorBox = { ...plan.door };
    this.holder.position.copy(plan.position);
    this.holder.rotation.y = plan.ry;
    this.group.add(this.holder);
    const b = plan.bounds;
    shopUniforms.uShop.value.set(b.minX, b.minZ, b.maxX, b.maxZ);
    shopUniforms.uShopTop.value = plan.position.y + HEIGHT;
    shopUniforms.uShopFloor.value = plan.position.y + FLOOR;
    doorUniforms.uDoorCentre.value.copy(plan.doorway).setY(plan.position.y + FLOOR);
    const along = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), plan.ry);
    doorUniforms.uDoorAlong.value.set(along.x, along.z);
    this.buildShell();
  }

  /** Tube lights under the ceiling, snow on the roof, the neon sign and the pool of light on the snow out front. */
  private buildShell() {
    const tubeMat = new THREE.MeshStandardMaterial({ color: "#000", emissive: "#f1f6ff", emissiveIntensity: 3 });
    const tubeGeo = new THREE.BoxGeometry(1.5, 0.05, 0.16);
    for (let x = -11; x < 13.5; x += 3) {
      for (const z of [-5, -1.2, 2.5, 6.3]) {
        const tube = new THREE.Mesh(tubeGeo, tubeMat);
        tube.position.set(x, CEILING - 0.06, z);
        this.holder.add(tube);
      }
    }
    const roofMat = snowify(new THREE.MeshStandardMaterial({ color: "#d9e1f2", roughness: 0.85 }), { sparkle: 0.5 });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(WALLS.maxX - WALLS.minX + 0.1, 0.14, WALLS.maxZ - WALLS.minZ + 0.1), roofMat);
    roof.position.set((WALLS.minX + WALLS.maxX) / 2, HEIGHT + 0.03, (WALLS.minZ + WALLS.maxZ) / 2);
    roof.receiveShadow = true;

    // ПРОДУКТЫ over the windows and 24 over the door, in red neon
    const name = neonSign("ПРОДУКТЫ", 6.6, 1.25, "#ff3b30");
    name.position.set(-3.6, 5.5, -9.15);
    name.rotation.y = Math.PI;
    const hours = neonSign("24", 1.6, 1.25, "#ff3b30");
    hours.position.set((DOOR.minX + DOOR.maxX) / 2 - 0.4, 5.5, -9.15);
    hours.rotation.y = Math.PI;

    // Laid on the snow itself, so it follows the ground rather than floating over the dips
    const len = WALLS.maxX - WALLS.minX + 2;
    const poolGeo = new THREE.PlaneGeometry(len, 7, 24, 8)
      .rotateX(-Math.PI / 2)
      .translate((WALLS.minX + WALLS.maxX) / 2, 0, WALLS.minZ - 3.2);
    const toWorld = frame(this.plan.position, this.plan.ry);
    const pp = poolGeo.getAttribute("position");
    for (let i = 0; i < pp.count; i++) {
      const wp = new THREE.Vector3(pp.getX(i), 0, pp.getZ(i)).applyMatrix4(toWorld);
      pp.setY(i, this.heightAt(wp.x, wp.z) + 0.03 - this.plan.position.y);
    }
    const pool = new THREE.Mesh(
      poolGeo,
      new THREE.MeshBasicMaterial({
        map: glowTexture(),
        color: "#8a9bc4",
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      })
    );
    pool.renderOrder = 2;
    this.holder.add(roof, name, hours, pool);
  }

  async load(renderer: THREE.WebGLRenderer) {
    // A bright white room for the reflections: chrome carts, glossy tiles and the fridge glass need something to mirror
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;
    pmrem.dispose();
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(MODEL);
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    const box = new THREE.Box3();
    for (const mesh of meshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      box.setFromObject(mesh);
      const shell = box.min.x < WALLS.minX + 0.3 || box.max.x > WALLS.maxX - 0.3 || box.min.z < WALLS.minZ + 0.3 || box.max.z > WALLS.maxZ - 0.3 || box.max.y > CEILING;
      mesh.receiveShadow = true;
      mesh.castShadow = shell;
      // Anything in the doorway (glass, frames, handles) belongs to the sliding doors
      if (box.min.z < DOOR.z + 0.4 && box.min.y < 2.7 && box.max.x > DOOR.minX && box.min.x < DOOR.maxX) this.cutDoor(mesh);
      if (mat.transparent) {
        // Glass lit from behind: the windows glow out into the street
        mat.emissive = new THREE.Color("#dfe8fa");
        mat.emissiveIntensity = 0.08;
        // A soft sheen, not a mirror: on smooth glass the room's light panels showed up as a blinding rectangle
        mat.envMap = room;
        mat.envMapIntensity = 0.25;
        mat.roughness = Math.max(mat.roughness, 0.4);
        mat.opacity *= 0.6;
        mat.depthWrite = false;
        gapInGlass(mat);
        if (!this.glass.some((g) => g.mat === mat)) this.glass.push({ mat, opacity: mat.opacity, env: mat.envMapIntensity });
        continue;
      }
      mat.envMap = room;
      mat.envMapIntensity = 0.22;
      // Mirror-smooth surfaces would catch the reflected lamps as blinding points: keep a little satin to everything
      mat.roughness = Math.max(mat.roughness, 0.32);
      // The floor tiles are exported half metal, which mirrors the lights in a glare across the aisles
      if (mat.name === "Material") {
        mat.metalness = 0.08;
        mat.roughness = 0.45;
      }
      lightFromInside(mat, 0.62, mat.name === "Material.014");
      if (!shell) this.detail.push(mesh);
    }
    this.holder.add(root);
    this.holder.add(...this.leaves.map((l) => l.mesh));
    this.loaded = true;
  }

  /**
   * The doors share their meshes with the shop front (frames and glass). Cut every triangle in the doorway out into
   * two leaves, left and right of the middle, that slide apart; the front keeps the rest.
   */
  private cutDoor(mesh: THREE.Mesh) {
    // Quantized (meshopt) attributes would clamp when transformed: work in plain floats
    const local = toFloat(mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone());
    const world = local.clone().applyMatrix4(mesh.matrixWorld);
    const pos = world.getAttribute("position");
    const mid = (DOOR.minX + DOOR.maxX) / 2;
    const sides: number[][] = [[], []];
    const rest: number[] = [];
    // Only triangles lying wholly in the plane of the doors: the vestibule frame around them stays put
    const inDoor = (i: number) =>
      pos.getX(i) > DOOR.minX - 0.05 && pos.getX(i) < DOOR.maxX + 0.05 && Math.abs(pos.getZ(i) - DOOR.z) < 0.07 && pos.getY(i) < 2.8 && pos.getY(i) > 0.08;
    for (let t = 0; t < pos.count; t += 3) {
      const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
      (inDoor(t) && inDoor(t + 1) && inDoor(t + 2) ? sides[cx < mid ? 0 : 1] : rest).push(t);
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

  /** A snowball that splats on the closed doors sticks to the leaf it hit and slides away with it. */
  stick(mesh: THREE.Object3D, point: THREE.Vector3) {
    const d = this.doorBox;
    if (point.x < d.minX - 0.3 || point.x > d.maxX + 0.3 || point.z < d.minZ - 0.3 || point.z > d.maxZ + 0.3) return;
    if (point.y > this.plan.position.y + 2.9) return;
    const local = this.holder.worldToLocal(point.clone());
    const dir = local.x < (DOOR.minX + DOOR.maxX) / 2 ? -1 : 1;
    this.leaves.find((l) => l.dir === dir)?.mesh.attach(mesh);
  }

  /** Within reach of the doorway. */
  private near(p: THREE.Vector3) {
    return Math.hypot(p.x - this.plan.doorway.x, p.z - this.plan.doorway.z) < REACH;
  }

  isInside(p: THREE.Vector3) {
    const b = this.plan.bounds;
    if (p.x < b.minX || p.x > b.maxX || p.z < b.minZ || p.z > b.maxZ) return false;
    const l = p.clone().setY(this.plan.position.y).applyMatrix4(this.toLocal);
    return l.x > INTERIOR.minX && l.x < INTERIOR.maxX && l.z > INTERIOR.minZ && l.z < INTERIOR.maxZ;
  }

  /** E: opens the doors, or closes them if you are clear of the doorway. Returns what happened. */
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

  private inDoorway(p: THREE.Vector3) {
    const d = this.doorBox;
    return p.x > d.minX - 0.6 && p.x < d.maxX + 0.6 && p.z > d.minZ - 0.6 && p.z < d.maxZ + 0.6;
  }

  update(dt: number, camera: THREE.Vector3): ShopState {
    let closed = false;
    // The doors close on their own once you have moved away from them for a moment
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
    // In a hand's width first, then apart behind the fixed glass
    for (const leaf of this.leaves) {
      leaf.mesh.position.z = 0.08 * Math.min(1, eased * 5);
      leaf.mesh.position.x = leaf.dir * SLIDE * eased;
    }
    doorUniforms.uDoorGap.value = SLIDE * eased;
    // The doorway is passable once the leaves are mostly apart
    Object.assign(this.plan.door, eased > 0.6 ? { minX: 1e6, maxX: 1e6, minZ: 1e6, maxZ: 1e6 } : this.doorBox);

    const inside = this.isInside(camera);
    const goal = inside ? 1 - 0.3 * eased : 0;
    this.insideLevel += (goal - this.insideLevel) * (1 - Math.exp(-dt * 3));
    // The fog is laid over the frame after the glass, by the depth of whatever is behind it: looking out, the sheen
    // survived only where something stood close outside (trees turned to white cut-outs) and the far view went flat
    // blue. From inside the panes all but vanish, like the gas station's
    for (const g of this.glass) {
      g.mat.opacity = g.opacity * (1 - 0.85 * this.insideLevel);
      g.mat.envMapIntensity = g.env * (1 - 0.85 * this.insideLevel);
    }
    const dist = camera.distanceTo(this.plan.doorway);
    for (const o of this.detail) o.visible = dist < DETAIL_DISTANCE;
    const hum = inside ? 1 : (0.1 + 0.35 * eased) / (1 + dist * 0.18);

    let prompt: string | null = null;
    if (this.loaded && this.near(camera) && !this.wantOpen) prompt = inside ? "leave" : "go in";
    return { prompt, inside: this.insideLevel, hum, closed };
  }
}
