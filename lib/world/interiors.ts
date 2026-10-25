import * as THREE from "three";
import { FACADE, WINDOW_BOX } from "./textures";

const CELL = { w: 3, h: 2.8 };
// Rooms whose floor is below this height (ground and first floor) never light up, so you can't walk up to one
const LOW_ROOMS_BELOW = 5.0;
// Rooms behind model windows are wider and taller than the pane; the sill sits 30% up the back wall
const ROOM_SCALE = { w: 2.0, h: 1.7, sill: 0.3, depth: 2.4 };

// Ray-traces a box room behind a window. local: entry point on the room's front face (0-1), pane: position on the
// glass itself (for curtains), size: room width/height/depth, d: view ray, N: facade normal, r: per-room random.
/** Shared clock for the rooms, so lights can go on and off over time. */
export const interiorUniforms = { uRoomTime: { value: 0 } };

const ROOM = /* glsl */ `
  uniform float uLitRatio;
  uniform float uRoomTime;
  uniform float uInteriorGain;
  vec3 roomHash(vec3 p) {
    return fract(sin(vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)))) * 43758.5453);
  }

  vec3 shadeRoom(vec2 local, vec2 pane, vec3 size, vec3 d, vec3 N, vec3 r) {
    vec3 T = cross(vec3(0.0, 1.0, 0.0), N);
    vec3 dl = vec3(dot(d, T) / size.x, d.y / size.y, dot(d, -N) / size.z);
    dl = sign(dl + 1e-6) * max(abs(dl), vec3(1e-5));
    vec3 p0 = vec3(local, 0.0);
    vec3 tv = (step(0.0, dl) - p0) / dl;
    float t = min(min(tv.x, tv.y), tv.z);
    vec3 h = p0 + dl * t;
    // r.x > 1.5 marks a sealed room (low floor or corner): fully dark, not even a TV
    bool lit = r.x < uLitRatio;
    bool sealed = r.x > 1.5;
    // Rooms keep their light: a window snapping on or off as you walk past read as a glitch, not as life

    vec3 wall = mix(vec3(0.78, 0.7, 0.56), vec3(0.58, 0.64, 0.56), r.y);
    wall = mix(wall, vec3(0.7, 0.62, 0.66), step(0.7, r.z));
    vec3 albedo;
    float ao;
    if (t == tv.z) {
      albedo = wall * (0.94 + 0.06 * step(0.5, fract(h.x * 18.0)) * step(0.5, r.y));
      ao = smoothstep(0.0, 0.16, min(min(h.x, 1.0 - h.x), min(h.y, 1.0 - h.y)));
    } else if (t == tv.y) {
      albedo = dl.y < 0.0 ? vec3(0.32, 0.22, 0.15) * (0.85 + 0.15 * step(0.5, fract(h.x * 9.0))) : vec3(0.85, 0.84, 0.8);
      ao = smoothstep(0.0, 0.2, min(min(h.x, 1.0 - h.x), 1.0 - h.z));
    } else {
      albedo = wall * 0.92;
      ao = smoothstep(0.0, 0.16, min(min(h.y, 1.0 - h.y), 1.0 - h.z));
    }
    ao = 0.45 + 0.55 * ao;

    vec3 lightCol = r.z < 0.55 ? vec3(1.0, 0.72, 0.42) : r.z < 0.8 ? vec3(1.0, 0.86, 0.66) : r.z < 0.93 ? vec3(0.8, 0.88, 1.0) : vec3(0.35, 0.55, 1.0);
    vec3 room;
    if (lit) {
      // Broad ceiling-lamp falloff: brighter up high and toward the middle, no visible hot spot
      float spread = 1.0 - 0.35 * abs(h.x - 0.5) * 2.0;
      float height = 0.55 + 0.45 * smoothstep(0.0, 1.0, h.y);
      room = albedo * lightCol * (0.32 + 0.5 * spread * height) * ao;
    } else {
      room = albedo * vec3(0.012, 0.018, 0.04) * (1.0 - h.z * 0.6) * ao;
    }

    // A few dark rooms with only a TV on, washing the walls blue
    if (!lit && !sealed && fract(r.z * 13.1) < 0.08) room += albedo * vec3(0.12, 0.2, 0.5) * (0.4 + 0.6 * h.z) * ao;

    // Curtains hang at the glass, lit from behind when the room is on
    float cw = 0.12 + fract(r.y * 7.3) * 0.22;
    float curtain = fract(r.x * 13.7) > 0.35 ? max(step(pane.x, cw), step(1.0 - cw, pane.x)) : 0.0;
    float folds = 0.82 + 0.1 * sin(pane.x * 38.0 + r.z * 6.0) + 0.08 * sin(pane.x * 91.0 + r.y * 4.0);
    vec3 fabric = lit ? lightCol * 0.26 * folds : vec3(0.006, 0.008, 0.014) * folds;
    room = mix(room, fabric, curtain * 0.9);

    float fres = pow(1.0 - abs(dot(d, N)), 4.0);
    return room * uInteriorGain + vec3(0.03, 0.05, 0.11) * (0.08 + fres * 0.7);
  }
  vec3 facadeNormal(vec3 viewNormal) {
    vec3 N = (vec4(viewNormal, 0.0) * viewMatrix).xyz;
    return abs(N.x) > abs(N.z) ? vec3(sign(N.x), 0.0, 0.0) : vec3(0.0, 0.0, sign(N.z));
  }
`;

const GLASS = /* glsl */ `
  diffuseColor.rgb = vec3(0.01);
  roughnessFactor = 0.08;
  metalnessFactor = 0.0;
`;

function extend<T extends THREE.MeshStandardMaterial>(mat: T, key: string, patch: (shader: THREE.WebGLProgramParametersWithUniforms) => void): T {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${prevKey()}-${key}`;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    patch(shader);
  };
  return mat;
}

/**
 * Interior mapping (the Spider-Man / Midnight Apex trick) for the generated panel facades: each window pane
 * ray-traces into an imaginary room behind the wall. Expects a material already processed by snowify (vSnowPos).
 */
export function interiorize<T extends THREE.MeshStandardMaterial>(mat: T, opts: { litRatio: number; depth?: number; gain?: number; faceWidth: number }): T {
  const depth = (opts.depth ?? 4.2).toFixed(2);
  const wx0 = WINDOW_BOX.left.toFixed(3);
  const wx1 = (WINDOW_BOX.left + WINDOW_BOX.width).toFixed(3);
  const wy0 = (1 - WINDOW_BOX.top - WINDOW_BOX.height).toFixed(3);
  const wy1 = (1 - WINDOW_BOX.top).toFixed(3);
  return extend(mat, "interior", (shader) => {
    shader.uniforms.uLitRatio = { value: opts.litRatio };
    shader.uniforms.uRoomTime = interiorUniforms.uRoomTime;
    shader.uniforms.uInteriorGain = { value: opts.gain ?? 1.25 };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vFaceU;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFaceU = uv.x;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\nvarying float vFaceU;\n${ROOM}`).replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
      {
        vec2 grid = vMapUv * vec2(${FACADE.cols.toFixed(1)}, ${FACADE.floors.toFixed(1)});
        vec2 local = fract(grid);
        bool stair = abs(mod(floor(grid.x), ${FACADE.cols.toFixed(1)}) - 7.0) < 0.5;
        vec2 wMin = vec2(${wx0}, ${wy0}) + vec2(0.03, 0.03);
        vec2 wMax = vec2(${wx1}, ${wy1}) - vec2(0.03, 0.03);
        vec2 wl = (local - wMin) / (wMax - wMin);
        bool pane = !stair && all(greaterThan(wl, vec2(0.0))) && all(lessThan(wl, vec2(1.0)));
        bool mullion = abs(wl.x - 0.5) < 0.035 || abs(wl.y - 0.72) < 0.03;
        vec2 frameMin = vec2(${wx0}, ${wy0}) - 0.04;
        vec2 frameMax = vec2(${wx1}, ${wy1}) + 0.04;
        // The baked window light in the emissive map is replaced by the room, frame included
        if (!stair && all(greaterThan(local, frameMin)) && all(lessThan(local, frameMax))) totalEmissiveRadiance = vec3(0.0);
        if (pane && !mullion) {
          vec3 N = facadeNormal(vNormal);
          vec3 T = cross(vec3(0.0, 1.0, 0.0), N);
          // Stable id per room: the cell's corner in face space, plus the face plane itself
          vec3 key = vec3(
            floor(dot(vSnowPos, T) - local.x * ${CELL.w.toFixed(1)} + 0.5),
            floor(vSnowPos.y - local.y * ${CELL.h.toFixed(1)} + 0.5),
            floor(dot(vSnowPos, N) + 0.5)
          );
          vec3 rr = roomHash(key);
          // Rooms at the building's corners stay dark: a lit one next to the side windows would give the trick away
          if (min(vFaceU, 1.0 - vFaceU) * ${opts.faceWidth.toFixed(2)} < ${(CELL.w * 1.2).toFixed(2)}) rr.x = 1.0;
          if (key.y < ${LOW_ROOMS_BELOW.toFixed(1)}) rr.x = 2.0;
          totalEmissiveRadiance = shadeRoom(local, wl, vec3(${CELL.w.toFixed(1)}, ${CELL.h.toFixed(1)}, ${depth}), normalize(vSnowPos - cameraPosition), N, rr);
          ${GLASS}
        }
      }`
    );
  });
}

/**
 * Same interior mapping for downloaded models: window panes are found in the geometry (see tagWindows)
 * and carry their own pane coordinates and size, so any facade layout works.
 */
export function modelInteriors<T extends THREE.MeshStandardMaterial>(mat: T, opts: { litRatio: number; gain?: number }): T {
  return extend(mat, "model-interior", (shader) => {
    shader.uniforms.uLitRatio = { value: opts.litRatio };
    shader.uniforms.uRoomTime = interiorUniforms.uRoomTime;
    shader.uniforms.uInteriorGain = { value: opts.gain ?? 1.25 };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 aWin;\nattribute vec3 aWinSize;\nvarying vec4 vWin;\nvarying vec3 vWinSize;\nvarying float vWinSeed;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vWin = aWin;
        vWinSize = aWinSize;
        vWinSeed = 0.0;
        #ifdef USE_INSTANCING
          vWinSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
          // Sizes are in model units; scale to metres so room proportions match the procedural blocks
          vWinSize *= length(instanceMatrix[0].xyz);
        #endif`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec4 vWin;\nvarying vec3 vWinSize;\nvarying float vWinSeed;\n${ROOM}`)
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        if (vWin.w > 0.5) {
          vec2 local = clamp(vWin.xy, 0.0, 1.0);
          vec2 pane = vec2((local.x - 0.5) * ${ROOM_SCALE.w.toFixed(2)} + 0.5, (local.y - ${ROOM_SCALE.sill.toFixed(2)}) * ${ROOM_SCALE.h.toFixed(2)});
          vec3 rr = roomHash(vec3(vWin.z * 97.0, vWinSeed * 131.0, 3.7));
          // Corner windows (flagged with w = 2) stay dark so neighbouring faces never show the same room from two sides
          if (vWin.w > 1.5) rr.x = 1.0;
          if (vSnowPos.y - local.y * vWinSize.y < ${LOW_ROOMS_BELOW.toFixed(1)}) rr.x = 2.0;
          totalEmissiveRadiance = shadeRoom(local, pane, vWinSize, normalize(vSnowPos - cameraPosition), facadeNormal(vNormal), rr);
          ${GLASS}
        }`
      );
  });
}

/**
 * Finds window panes in a building model: faces parallel to a facade but set slightly back from it.
 * Each pane gets its own 0-1 coordinates and size so the interior shader can put a room behind it.
 */
export function tagWindows(source: THREE.BufferGeometry, seed: number) {
  const g = source.index ? source.toNonIndexed() : source;
  const pos = g.getAttribute("position");
  const triCount = pos.count / 3;
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const long = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
  const triDir = new Int8Array(triCount).fill(-1);
  const triPlane = new Float32Array(triCount);
  const triArea = new Float32Array(triCount);
  const planeArea = dirs.map(() => new Map<number, number>());
  const q = long * 0.001;

  for (let t = 0; t < triCount; t++) {
    a.fromBufferAttribute(pos, t * 3);
    b.fromBufferAttribute(pos, t * 3 + 1);
    c.fromBufferAttribute(pos, t * 3 + 2);
    n.crossVectors(b.clone().sub(a), c.clone().sub(a));
    const area = n.length() / 2;
    if (area < 1e-12) continue;
    n.normalize();
    const d = dirs.findIndex((v) => n.dot(v) > 0.97);
    if (d < 0) continue;
    const plane = a.dot(dirs[d]);
    triDir[t] = d;
    triPlane[t] = plane;
    triArea[t] = area;
    const key = Math.round(plane / q);
    planeArea[d].set(key, (planeArea[d].get(key) ?? 0) + area);
  }

  // The facade is the largest plane facing each way; panes sit 0.1%-1.5% of the building's length behind it
  const facade = planeArea.map((m) => {
    let best = -Infinity;
    let bestArea = 0;
    for (const [k, v] of m) if (v > bestArea) [best, bestArea] = [k * q, v];
    return best;
  });
  const isPane = (t: number) => {
    const d = triDir[t];
    if (d < 0) return false;
    const recess = facade[d] - triPlane[t];
    return recess > long * 0.001 && recess < long * 0.015;
  };

  const parent = new Int32Array(triCount).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const owner = new Map<string, number>();
  for (let t = 0; t < triCount; t++) {
    if (!isPane(t)) continue;
    for (let k = 0; k < 3; k++) {
      a.fromBufferAttribute(pos, t * 3 + k);
      const key = `${triDir[t]}|${a.x.toFixed(5)},${a.y.toFixed(5)},${a.z.toFixed(5)}`;
      const o = owner.get(key);
      if (o === undefined) owner.set(key, t);
      else parent[find(t)] = find(o);
    }
  }

  type Box = { minU: number; maxU: number; minY: number; maxY: number };
  const boxes = new Map<number, Box>();
  const tangent = (d: number) => new THREE.Vector3(0, 1, 0).cross(dirs[d]);
  for (let t = 0; t < triCount; t++) {
    if (!isPane(t)) continue;
    const root = find(t);
    const T = tangent(triDir[t]);
    const box = boxes.get(root) ?? { minU: Infinity, maxU: -Infinity, minY: Infinity, maxY: -Infinity };
    for (let k = 0; k < 3; k++) {
      a.fromBufferAttribute(pos, t * 3 + k);
      const u = a.dot(T);
      box.minU = Math.min(box.minU, u);
      box.maxU = Math.max(box.maxU, u);
      box.minY = Math.min(box.minY, a.y);
      box.maxY = Math.max(box.maxY, a.y);
    }
    boxes.set(root, box);
  }

  // Glass split by mullions comes in as separate islands: merge neighbours on the same face into one window
  const gap = long * 0.006;
  const dirOf = new Map<number, number>();
  for (let t = 0; t < triCount; t++) if (isPane(t)) dirOf.set(find(t), triDir[t]);
  for (let pass = 0, changed = true; changed && pass < 4; pass++) {
    changed = false;
    const roots = [...boxes.keys()];
    for (let i = 0; i < roots.length; i++) {
      for (let j = i + 1; j < roots.length; j++) {
        const ri = find(roots[i]);
        const rj = find(roots[j]);
        if (ri === rj || dirOf.get(roots[i]) !== dirOf.get(roots[j])) continue;
        const A = boxes.get(roots[i])!;
        const B = boxes.get(roots[j])!;
        if (A.minU - gap > B.maxU || B.minU - gap > A.maxU || A.minY - gap > B.maxY || B.minY - gap > A.maxY) continue;
        parent[rj] = ri;
        changed = true;
      }
    }
    const next = new Map<number, Box>();
    for (const [root, box] of boxes) {
      const r = find(root);
      const cur = next.get(r);
      next.set(r, cur ? { minU: Math.min(cur.minU, box.minU), maxU: Math.max(cur.maxU, box.maxU), minY: Math.min(cur.minY, box.minY), maxY: Math.max(cur.maxY, box.maxY) } : box);
      dirOf.set(r, dirOf.get(root)!);
    }
    boxes.clear();
    for (const [k, v] of next) boxes.set(k, v);
  }

  // Each accepted window becomes one clean quad; the model's own glass, sashes and mullions inside it are dropped
  type Win = { dir: number; box: Box; plane: number; rand: number };
  const windows: Win[] = [];
  const planeSum = new Map<number, [number, number]>();
  for (let t = 0; t < triCount; t++) {
    if (!isPane(t)) continue;
    const r = find(t);
    const [sum, cnt] = planeSum.get(r) ?? [0, 0];
    planeSum.set(r, [sum + triPlane[t], cnt + 1]);
  }
  let s = seed * 7919 + 1;
  for (const [root, box] of boxes) {
    const w = box.maxU - box.minU;
    const h = box.maxY - box.minY;
    if (w < long * 0.004 || h < long * 0.004) continue;
    // Doors sit almost at ground level relative to their own height; leave them as they are
    if (box.minY - bb.min.y < h * 0.3) continue;
    const [sum, cnt] = planeSum.get(root)!;
    s = (s * 16807) % 2147483647;
    // Just behind the wall surface: the quad covers every leftover sash and frame piece set deeper in the opening
    const dir = dirOf.get(root)!;
    windows.push({ dir, box, plane: Math.max(sum / cnt, facade[dir] - long * 0.0008), rand: s / 2147483647 });
  }

  const eps = long * 0.0005;
  const inWindow = (t: number) => {
    const d = triDir[t];
    if (d < 0) return false;
    const recess = facade[d] - triPlane[t];
    if (recess < eps || recess > long * 0.02) return false;
    const T = tangent(d);
    let minU = Infinity, maxU = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < 3; k++) {
      a.fromBufferAttribute(pos, t * 3 + k);
      const u = a.dot(T);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minY = Math.min(minY, a.y);
      maxY = Math.max(maxY, a.y);
    }
    return windows.some((win) => win.dir === d && minU >= win.box.minU - eps && maxU <= win.box.maxU + eps && minY >= win.box.minY - eps && maxY <= win.box.maxY + eps);
  };

  const keep: number[] = [];
  for (let t = 0; t < triCount; t++) if (!inWindow(t)) keep.push(t);
  const vertCount = keep.length * 3 + windows.length * 6;
  const out = new THREE.BufferGeometry();
  const names = Object.keys(g.attributes);
  const arrays: Record<string, Float32Array> = {};
  for (const name of names) {
    const attr = g.getAttribute(name);
    const arr = new Float32Array(vertCount * attr.itemSize);
    keep.forEach((t, i) => {
      for (let k = 0; k < 3; k++) for (let c2 = 0; c2 < attr.itemSize; c2++) arr[(i * 3 + k) * attr.itemSize + c2] = attr.getComponent(t * 3 + k, c2);
    });
    arrays[name] = arr;
  }
  const win = new Float32Array(vertCount * 4);
  const size = new Float32Array(vertCount * 3);
  let v = keep.length * 3;
  const corners3 = [bb.min.x, bb.max.x].flatMap((x) => [bb.min.z, bb.max.z].map((z) => new THREE.Vector3(x, 0, z)));
  for (const w of windows) {
    const N = dirs[w.dir];
    const T = tangent(w.dir);
    const span = corners3.map((p) => p.dot(T));
    const ww0 = w.box.maxU - w.box.minU;
    const atCorner = w.box.minU - Math.min(...span) < ww0 * 1.5 || Math.max(...span) - w.box.maxU < ww0 * 1.5;
    const corners = [
      [w.box.minU, w.box.minY], [w.box.maxU, w.box.minY], [w.box.maxU, w.box.maxY],
      [w.box.minU, w.box.minY], [w.box.maxU, w.box.maxY], [w.box.minU, w.box.maxY],
    ];
    const ww = w.box.maxU - w.box.minU;
    const hh = w.box.maxY - w.box.minY;
    // Winding must face outward: (T × up) is the quad's front side
    const flip = new THREE.Vector3().crossVectors(T, new THREE.Vector3(0, 1, 0)).dot(N) < 0;
    const order = flip ? [0, 2, 1, 3, 5, 4] : [0, 1, 2, 3, 4, 5];
    for (const ci of order) {
      const [u, y] = corners[ci];
      const p = T.clone().multiplyScalar(u).addScaledVector(N, w.plane);
      p.y = y;
      arrays.position.set([p.x, p.y, p.z], v * 3);
      if (arrays.normal) arrays.normal.set([N.x, N.y, N.z], v * 3);
      if (arrays.tangent) arrays.tangent.set([T.x, T.y, T.z, 1], v * 4);
      const lu = (u - w.box.minU) / ww;
      const lv = (y - w.box.minY) / hh;
      win.set([0.5 + (lu - 0.5) / ROOM_SCALE.w, ROOM_SCALE.sill + lv / ROOM_SCALE.h, w.rand, atCorner ? 2 : 1], v * 4);
      size.set([ww * ROOM_SCALE.w, hh * ROOM_SCALE.h, ww * ROOM_SCALE.w * ROOM_SCALE.depth * 0.6], v * 3);
      v++;
    }
  }
  for (const name of names) out.setAttribute(name, new THREE.BufferAttribute(arrays[name], g.getAttribute(name).itemSize));
  out.setAttribute("aWin", new THREE.BufferAttribute(win, 4));
  out.setAttribute("aWinSize", new THREE.BufferAttribute(size, 3));
  return { geometry: out, panes: windows.length };
}
