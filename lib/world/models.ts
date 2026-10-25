import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const FILES = {
  car: "/models/opt/car-2.glb",
  lamp: "/models/opt/streetlamp.glb",
  building1: "/models/opt/building-1.glb",
  building2: "/models/opt/building-2.glb",
  building3: "/models/opt/building-3.glb",
  building4: "/models/opt/building-4.glb",
} as const;

export const BUILDING_MODELS = ["building1", "building2", "building3", "building4"] as const;
export type BuildingModel = (typeof BUILDING_MODELS)[number];

export type ModelName = keyof typeof FILES;
export type Models = Partial<Record<ModelName, THREE.Group>>;

export async function loadModels(): Promise<Models> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const entries = await Promise.all(
    (Object.keys(FILES) as ModelName[]).map(async (name) => {
      try {
        const gltf = await loader.loadAsync(FILES[name]);
        return [name, gltf.scene] as const;
      } catch {
        return [name, undefined] as const;
      }
    })
  );
  const out: Models = {};
  for (const [name, scene] of entries) if (scene) out[name] = scene;
  return out;
}

export type Part = { geometry: THREE.BufferGeometry; material: THREE.Material; name: string };

type Fit = {
  // Uniform scale so this dimension matches `size`; "long" is the longest horizontal side
  axis: "x" | "y" | "z" | "long";
  size: number;
  // Rotate 90° so the longest horizontal side runs along this axis
  longAlong?: "x" | "z";
};

export type Prepared = { parts: Part[]; size: THREE.Vector3 };

// Meshopt files store quantized (normalized int) attributes; baking a transform into those would clamp them
export function toFloat(geometry: THREE.BufferGeometry) {
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.getAttribute(name);
    if (attr.array instanceof Float32Array && !attr.normalized && !(attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) continue;
    const out = new Float32Array(attr.count * attr.itemSize);
    for (let i = 0; i < attr.count; i++) {
      for (let c = 0; c < attr.itemSize; c++) out[i * attr.itemSize + c] = attr.getComponent(i, c);
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(out, attr.itemSize));
  }
  return geometry;
}

/** Bakes every mesh of a glTF scene into standalone geometries in a normalized frame: base at y=0, centered in XZ. */
export function prepare(root: THREE.Object3D, fit: Fit): Prepared {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const rotate = (fit.longAlong === "z" && size.x > size.z) || (fit.longAlong === "x" && size.z > size.x);
  const long = Math.max(size.x, size.z);
  const ref = fit.axis === "long" ? long : size[fit.axis];
  const s = fit.size / ref;
  const center = box.getCenter(new THREE.Vector3());
  const m = new THREE.Matrix4()
    .makeScale(s, s, s)
    .multiply(rotate ? new THREE.Matrix4().makeRotationY(Math.PI / 2) : new THREE.Matrix4())
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z));

  const parts: Part[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const inst = mesh as THREE.InstancedMesh;
    const instances = inst.isInstancedMesh ? inst.count : 1;
    const im = new THREE.Matrix4();
    for (let i = 0; i < instances; i++) {
      const geometry = toFloat(mesh.geometry.clone());
      if (inst.isInstancedMesh) inst.getMatrixAt(i, im);
      geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(m, mesh.matrixWorld).multiply(im));
      parts.push({ geometry, material: mats[0], name: mesh.name });
    }
  });
  const finalSize = rotate ? new THREE.Vector3(size.z, size.y, size.x).multiplyScalar(s) : size.clone().multiplyScalar(s);
  return { parts, size: finalSize };
}

const CHUNK = 48;

/** Splits instances into map cells so frustum and distance culling can skip what's behind you or lost in the fog. */
export function chunkedInstances(geometry: THREE.BufferGeometry, material: THREE.Material, matrices: THREE.Matrix4[], cast = true, receive = true) {
  const cells = new Map<string, THREE.Matrix4[]>();
  const p = new THREE.Vector3();
  for (const m of matrices) {
    p.setFromMatrixPosition(m);
    const key = `${Math.floor(p.x / CHUNK)},${Math.floor(p.z / CHUNK)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key)!.push(m);
  }
  return [...cells.values()].map((list) => {
    const inst = new THREE.InstancedMesh(geometry, material, list.length);
    list.forEach((mtx, i) => inst.setMatrixAt(i, mtx));
    inst.castShadow = cast;
    inst.receiveShadow = receive;
    inst.computeBoundingSphere();
    return inst;
  });
}

export function instanceParts(parts: Part[], matrices: THREE.Matrix4[], cast = true) {
  return parts.flatMap((p) => chunkedInstances(p.geometry, p.material, matrices, cast));
}

/** Gives each connected island of triangles (e.g. one window pane) a colour and a random number, so windows can light up independently. */
export function islandGlow(geometry: THREE.BufferGeometry, palette: THREE.Color[], seed = 1) {
  const pos = geometry.getAttribute("position");
  const index = geometry.index;
  const parent = new Int32Array(pos.count).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      union(index.getX(i), index.getX(i + 1));
      union(index.getX(i), index.getX(i + 2));
    }
  }
  // Vertices split by UV seams still share positions: merge those too
  const byPos = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    const other = byPos.get(key);
    if (other === undefined) byPos.set(key, i);
    else union(i, other);
  }
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const islands = new Map<number, [THREE.Color, number]>();
  const glow = new Float32Array(pos.count * 3);
  const rnd = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const r = find(i);
    if (!islands.has(r)) islands.set(r, [palette[Math.floor(rand() * palette.length)].clone().multiplyScalar(0.5 + rand() * 0.5), rand()]);
    const [c, v] = islands.get(r)!;
    glow.set([c.r, c.g, c.b], i * 3);
    rnd[i] = v;
  }
  geometry.setAttribute("aGlow", new THREE.BufferAttribute(glow, 3));
  geometry.setAttribute("aGlowRand", new THREE.BufferAttribute(rnd, 1));
  return islands.size;
}

/** Lights a share of the aGlow islands, picked differently for each instance. */
export function glowMaterial<T extends THREE.MeshStandardMaterial>(mat: T, intensity: number, ratio: number): T {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${prevKey()}-glow`;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    shader.uniforms.uGlow = { value: intensity };
    shader.uniforms.uGlowRatio = { value: ratio };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 aGlow;\nattribute float aGlowRand;\nuniform float uGlowRatio;\nvarying vec3 vGlow;\nvarying vec3 vGlowPos;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        float glowSeed = 0.0;
        #ifdef USE_INSTANCING
          glowSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
        #endif
        vGlow = fract(aGlowRand + glowSeed) < uGlowRatio ? aGlow : vec3(0.0);
        #ifdef USE_INSTANCING
          vGlowPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vGlowPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGlow;\nvarying vec3 vGlowPos;\nuniform float uGlow;")
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          // Fake curtains and uneven room light so a lit strip doesn't read as a flat neon bar
          float along = vGlowPos.x + vGlowPos.z;
          float folds = 0.75 + 0.25 * sin(along * 11.0);
          float rooms = fract(sin(floor(along / 2.6) * 91.7 + floor(vGlowPos.y / 2.8) * 37.3) * 4375.85);
          float on = step(0.35, rooms);
          totalEmissiveRadiance += vGlow * uGlow * folds * on * (0.5 + rooms * 0.5);
        }`
      );
  };
  return mat;
}
