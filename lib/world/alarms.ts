import * as THREE from "three";
import type { LightSource } from "./city";
import { ALARM_BEAT, ALARM_LENGTH, ALARM_ON } from "./audio";

type Car = { x: number; z: number };
type Alarm = { car: Car; until: number; start: number; blinkers: THREE.Group; light: LightSource };

const AMBER = new THREE.Color("#ff9a2e");
// Half the length and width of a parked car
const HALF = { x: 0.78, z: 2.12 };
// The lamps on the car's texture atlas (pixels of the 1024 map): tail cluster, headlight, side indicator. Whatever the
// model maps there is a lamp, so the flashing copy is clipped to exactly these patches of the paint
const LAMPS = [
  [583, 351, 651, 547],
  [655, 319, 708, 491],
  [651, 493, 697, 521],
].map(([x0, y0, x1, y1]) => [x0 / 1024, y0 / 1024, x1 / 1024, y1 / 1024]);
const DURATION = ALARM_LENGTH;

/**
 * Parked cars with alarms: a snowball on the body sets one off. The four indicators flash amber in time with the
 * siren and an amber glow pulses in the fog around the car; hitting it again while it wails starts it over.
 */
export class CarAlarms {
  group = new THREE.Group();
  private active: Alarm[] = [];
  private lampGeo?: THREE.BufferGeometry | null;
  private lampMat?: THREE.MeshBasicMaterial;
  private m = new THREE.Matrix4();
  private v = new THREE.Vector3();

  /** `bodies`: the car meshes; the flashing lamps are copies of their own head and tail light faces. */
  constructor(
    private cars: Car[],
    private bodies: () => THREE.Object3D[]
  ) {
    this.group.userData.noCull = true;
  }

  /**
   * The car model's own lamp faces: every triangle whose texture coordinates reach into one of the lamp patches,
   * copied with its UVs and lifted a few millimetres off the body. The material then keeps only the pixels inside
   * the patches, so the glow has the exact outline (and the reflector pattern) of the painted lights.
   */
  private lampGeometry() {
    if (this.lampGeo !== undefined) return this.lampGeo;
    const mesh = this.bodies().find((o) => (o as THREE.Mesh).isMesh) as THREE.Mesh | undefined;
    this.lampGeo = null;
    const src = mesh?.geometry;
    const uv = src?.getAttribute("uv");
    const map = (mesh?.material as THREE.MeshStandardMaterial | undefined)?.map;
    if (!src || !uv || !map) return null;
    const pos = src.getAttribute("position");
    const index = src.index;
    const tris = (index ? index.count : pos.count) / 3;
    const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const n = new THREE.Vector3();
    const outPos: number[] = [];
    const outUv: number[] = [];
    for (let t = 0; t < tris; t++) {
      const ids = [0, 1, 2].map((k) => (index ? index.getX(t * 3 + k) : t * 3 + k));
      const us = ids.map((i) => uv.getX(i));
      const vs = ids.map((i) => uv.getY(i));
      const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
      if (!LAMPS.some(([x0, y0, x1, y1]) => u1 >= x0 && u0 <= x1 && v1 >= y0 && v0 <= y1)) continue;
      ids.forEach((i, k) => p[k].fromBufferAttribute(pos, i));
      n.subVectors(p[2], p[1]).cross(p[0].clone().sub(p[1])).normalize();
      ids.forEach((_, k) => {
        outPos.push(p[k].x + n.x * 0.006, p[k].y + n.y * 0.006, p[k].z + n.z * 0.006);
        outUv.push(us[k], vs[k]);
      });
    }
    if (!outPos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(outPos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(outUv, 2));
    this.lampGeo = geo;
    this.lampMat = lampMaterial(map);
    return geo;
  }

  /** Where this car's model instance sits (the parked cars are instanced, several to a mesh). */
  private carMatrix(car: Car) {
    for (const o of this.bodies()) {
      const im = o as THREE.InstancedMesh;
      if (!im.isInstancedMesh) continue;
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, this.m);
        this.v.setFromMatrixPosition(this.m);
        if (Math.abs(this.v.x - car.x) < 0.3 && Math.abs(this.v.z - car.z) < 0.3) return this.m.clone().premultiply(im.matrixWorld);
      }
    }
    return null;
  }

  /** The car a hit at this point landed on, if any. */
  carAt(p: THREE.Vector3) {
    return this.cars.find((c) => Math.abs(p.x - c.x) < HALF.x + 0.3 && Math.abs(p.z - c.z) < HALF.z + 0.3 && p.y < 1.9);
  }

  /** Lights currently glowing in the fog (merged with the others each frame). */
  get lights() {
    return this.active.map((a) => a.light);
  }

  /** Sets this car's alarm off; false if it is already going (one siren at a time per car). */
  trigger(car: Car, t: number) {
    if (this.active.some((a) => a.car === car)) return false;
    const blinkers = new THREE.Group();
    const geo = this.lampGeometry();
    const at = this.carMatrix(car);
    if (geo && at && this.lampMat) {
      const lamps = new THREE.Mesh(geo, this.lampMat);
      lamps.matrixAutoUpdate = false;
      lamps.matrix.copy(at);
      blinkers.add(lamps);
    }
    this.group.add(blinkers);
    this.active.push({
      car,
      start: t,
      until: t + DURATION,
      blinkers,
      light: { position: new THREE.Vector3(car.x, 0.9, car.z), color: AMBER, strength: 0, omni: true, lamp: false },
    });
    return true;
  }

  update(t: number) {
    this.active = this.active.filter((a) => {
      if (t < a.until) return true;
      this.group.remove(a.blinkers);
      return false;
    });
    for (const a of this.active) {
      const on = ((t - a.start) / ALARM_BEAT) % 1 < ALARM_ON;
      a.blinkers.visible = on;
      a.light.strength = on ? 0.22 : 0;
    }
  }
}

/**
 * Amber, far brighter than white so the bloom turns each lamp into a soft flare, kept only inside the lamp patches of
 * the car's texture and following its detail: the reflector ribs and the chrome edge show through the glow.
 */
function lampMaterial(map: THREE.Texture) {
  const mat = new THREE.MeshBasicMaterial({
    color: AMBER.clone().multiplyScalar(4),
    map,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const rects = LAMPS.map((r) => `vec4(${r.map((x) => x.toFixed(4)).join(", ")})`).join(", ");
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `bool inLamp = false;
      vec4 lampRects[${LAMPS.length}] = vec4[](${rects});
      for (int i = 0; i < ${LAMPS.length}; i++) {
        vec4 r = lampRects[i];
        if (vMapUv.x >= r.x && vMapUv.x <= r.z && vMapUv.y >= r.y && vMapUv.y <= r.w) inLamp = true;
      }
      if (!inLamp) discard;
      vec3 texel = texture2D(map, vMapUv).rgb;
      diffuseColor.rgb *= 0.55 + 0.9 * dot(texel, vec3(0.3, 0.59, 0.11));`
    );
  };
  mat.customProgramCacheKey = () => "car-alarm-lamp";
  return mat;
}
