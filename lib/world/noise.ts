function hash2(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

export function valueNoise(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}

export function fbm(x: number, y: number, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * f, y * f) * amp;
    f *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

export const ROAD_HALF = 5;

type Segment = { ax: number; az: number; bx: number; bz: number };
const trails: Segment[] = [];

export function registerTrail(points: { x: number; y: number }[]) {
  for (let i = 0; i < points.length - 1; i++) {
    trails.push({ ax: points[i].x, az: points[i].y, bx: points[i + 1].x, bz: points[i + 1].y });
  }
}

function distToSegment(px: number, pz: number, s: Segment) {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const t = Math.max(0, Math.min(1, ((px - s.ax) * dx + (pz - s.az) * dz) / (dx * dx + dz * dz)));
  const x = s.ax + dx * t - px;
  const z = s.az + dz * t - pz;
  return Math.sqrt(x * x + z * z);
}

/** A frozen pond in the park, just off the trail: centre, radii (m), rotation, ice level (kept above the -0.4 outer ground plane). */
export const POND = { x: 96, z: 18, rx: 13, rz: 8, rot: 0.45, ice: -0.32 };

/** Normalised distance from the pond centre: 0 at the middle, ~1 at the shoreline. */
export function pondDistance(x: number, z: number) {
  const dx = x - POND.x;
  const dz = z - POND.z;
  const c = Math.cos(POND.rot);
  const s = Math.sin(POND.rot);
  const u = (dx * c - dz * s) / POND.rx;
  const v = (dx * s + dz * c) / POND.rz;
  return Math.sqrt(u * u + v * v);
}

/** Walkable height: the terrain, or the ice where the pond is. */
export function groundHeight(x: number, z: number) {
  const t = terrainHeight(x, z);
  return pondDistance(x, z) < 1.2 ? Math.max(t, POND.ice) : t;
}

/** The snow surface itself; around the pond it dips into a basin that the ice sheet floods. */
export function terrainHeight(x: number, z: number) {
  const ax = Math.abs(x);
  let h = fbm(x * 0.035 + 11, z * 0.035 - 7) * 0.7 + fbm(x * 0.12, z * 0.12, 2) * 0.08;

  const roadMask = 1 - smoothstep(ROAD_HALF - 0.3, ROAD_HALF + 0.4, ax);
  const berm = Math.exp(-Math.pow((ax - (ROAD_HALF + 1.3)) / 1.4, 2)) * (0.15 + fbm(z * 0.12, x * 0.5) * 0.45);
  h = h * (1 - roadMask) + berm;
  h -= roadMask * 0.02;

  let trail = 99;
  for (const s of trails) trail = Math.min(trail, distToSegment(x, z, s));
  h -= (1 - smoothstep(0.3, 1.4, trail)) * 0.12;

  // Pond basin: the bank slopes down to just under the ice, with a ragged shoreline where the two cross
  const pd = pondDistance(x, z) + (fbm(x * 0.18 + 40, z * 0.18 - 9, 3) - 0.5) * 0.22;
  if (pd < 1.6) h = POND.ice - 0.25 + (h + 0.25 - POND.ice) * smoothstep(0.82, 1.45, pd);
  return h;
}

export function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
