import * as THREE from "three";
import { bootPrintMaps } from "./textures";
import { terrainHeight } from "./noise";

const POOL = 260;
// Falling snow slowly fills old prints in
const FADE_START = 70;
const FADE_END = 150;

/** Height of the ground mesh itself (1 m grid, bilinear), so prints sit on the snow exactly where it is drawn. */
export function meshHeight(x: number, z: number) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const a = terrainHeight(x0, z0);
  const b = terrainHeight(x0 + 1, z0);
  const c = terrainHeight(x0, z0 + 1);
  const d = terrainHeight(x0 + 1, z0 + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** Your own trail: a boot print at every step, recycled from a fixed pool, filling back in with snow over a few minutes. */
export class Footprints {
  mesh: THREE.InstancedMesh;
  private births: THREE.InstancedBufferAttribute;
  private next = 0;
  private side = 1;
  private uniforms = { uTime: { value: 0 } };
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();

  constructor() {
    const geo = new THREE.PlaneGeometry(0.12, 0.3);
    geo.rotateX(-Math.PI / 2);
    this.births = new THREE.InstancedBufferAttribute(new Float32Array(POOL).fill(-1e6), 1);
    geo.setAttribute("aBirth", this.births);
    const maps = bootPrintMaps();
    const mat = new THREE.MeshStandardMaterial({
      color: "#aeb9d6",
      alphaMap: maps.alphaMap,
      normalMap: maps.normalMap,
      normalScale: new THREE.Vector2(1.2, 1.2),
      roughness: 0.95,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aBirth;\nuniform float uTime;\nvarying float vFill;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>\nvFill = smoothstep(${FADE_START.toFixed(1)}, ${FADE_END.toFixed(1)}, uTime - aBirth);`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vFill;")
        .replace("#include <alphamap_fragment>", "#include <alphamap_fragment>\ndiffuseColor.a *= 1.0 - vFill;");
    };
    mat.customProgramCacheKey = () => "footprints";
    this.mesh = new THREE.InstancedMesh(geo, mat, POOL);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    for (let i = 0; i < POOL; i++) this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
  }

  /** One step at the player's position; `heading` is the walking direction (radians, 0 = -z). */
  step(x: number, z: number, heading: number, t: number, both = false) {
    for (const side of both ? [-1, 1] : [(this.side = -this.side)]) {
      const rx = Math.cos(heading);
      const rz = Math.sin(heading);
      const px = x + rx * side * 0.11 + (Math.random() - 0.5) * 0.02;
      const pz = z + rz * side * 0.11 + (Math.random() - 0.5) * 0.02;
      // Feet splay out a little
      this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading + side * -0.08 + (Math.random() - 0.5) * 0.06);
      this.m.compose(new THREE.Vector3(px, meshHeight(px, pz) + 0.012, pz), this.q, new THREE.Vector3(1, 1, 1));
      this.mesh.setMatrixAt(this.next, this.m);
      this.births.setX(this.next, t);
      this.next = (this.next + 1) % POOL;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.births.needsUpdate = true;
  }

  update(t: number) {
    this.uniforms.uTime.value = t;
  }
}
