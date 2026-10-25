import * as THREE from "three";
import { createRng, type Rng } from "./random";

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext("2d", { willReadFrequently: true })! };
}

function toTexture(c: HTMLCanvasElement, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 16;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}

function heightToNormal(src: HTMLCanvasElement, strength: number) {
  const w = src.width;
  const h = src.height;
  const data = src.getContext("2d")!.getImageData(0, 0, w, h).data;
  const H = (x: number, y: number) => data[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  const out = canvas(w, h);
  const img = out.ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      img.data[i] = (-dx / len) * 127 + 128;
      img.data[i + 1] = (dy / len) * 127 + 128;
      img.data[i + 2] = (1 / len) * 127 + 128;
      img.data[i + 3] = 255;
    }
  }
  out.ctx.putImageData(img, 0, 0);
  return toTexture(out.c, false);
}

function tileableNoise(size: number, rng: Rng, octaves: number, base = 4, stretch = 1) {
  const field = new Float32Array(size * size);
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const gx = (base << o) * stretch;
    const gy = base << o;
    const pts = new Float32Array(gx * gy).map(() => rng.next());
    const amp = Math.pow(0.55, o);
    norm += amp;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx0 = (x / size) * gx;
        const fy0 = (y / size) * gy;
        const x0 = Math.floor(fx0);
        const y0 = Math.floor(fy0);
        const fx = fx0 - x0;
        const fy = fy0 - y0;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const p = (i: number, j: number) => pts[(j % gy) * gx + (i % gx)];
        const a = p(x0, y0) + (p(x0 + 1, y0) - p(x0, y0)) * sx;
        const c = p(x0, y0 + 1) + (p(x0 + 1, y0 + 1) - p(x0, y0 + 1)) * sx;
        field[y * size + x] += (a + (c - a) * sy) * amp;
      }
    }
  }
  for (let i = 0; i < field.length; i++) field[i] /= norm;
  return field;
}

export type SurfaceMaps = { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture };

function fieldToNormal(field: Float32Array, w: number, h: number, strength: number) {
  const H = (x: number, y: number) => field[((y + h) % h) * w + ((x + w) % w)];
  const out = canvas(w, h);
  const img = out.ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      img.data[i] = (-dx / len) * 127.5 + 127.5;
      img.data[i + 1] = (dy / len) * 127.5 + 127.5;
      img.data[i + 2] = (1 / len) * 127.5 + 127.5;
      img.data[i + 3] = 255;
    }
  }
  out.ctx.putImageData(img, 0, 0);
  return toTexture(out.c, false);
}

function rgbCanvas(w: number, h: number, fn: (i: number) => [number, number, number]) {
  const out = canvas(w, h);
  const img = out.ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = fn(i);
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  out.ctx.putImageData(img, 0, 0);
  return out.c;
}

export function snowMaps(): SurfaceMaps {
  const size = 1024;
  const rng = createRng(7);
  const soft = tileableNoise(size, rng, 6, 4);
  const ripples = tileableNoise(size, rng, 3, 3, 3);
  const pits = tileableNoise(size, rng, 2, 48);
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) {
    const r = 1 - Math.abs(ripples[i] * 2 - 1);
    height[i] = soft[i] * 0.55 + Math.pow(r, 4) * 0.18 + pits[i] * 0.05;
  }
  const map = rgbCanvas(size, size, (i) => {
    const b = 238 + (soft[i] - 0.5) * 18 + (pits[i] - 0.5) * 6;
    return [b - 4, b - 1, b + 3];
  });
  const rough = rgbCanvas(size, size, (i) => {
    const r = 185 + (soft[i] - 0.5) * 50 - (pits[i] > 0.8 ? 70 : 0);
    return [r, r, r];
  });
  return { map: toTexture(map), normalMap: fieldToNormal(height, size, size, 9), roughnessMap: toTexture(rough, false) };
}

export const ROAD_TILE = { width: 10, length: 24 };

export function roadMaps(): SurfaceMaps {
  const W = 512;
  const H = 1024;
  const rng = createRng(11);
  const n = tileableNoise(256, rng, 5);
  const tracks = [0.17, 0.32, 0.41, 0.59, 0.68, 0.83].map((t) => ({
    t,
    amp: rng.range(3, 10),
    phase: rng.range(0, Math.PI * 2),
    half: rng.range(8, 11),
    depth: rng.range(0.6, 1),
  }));
  const height = new Float32Array(W * H);
  const groove = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const noise = n[(y % 256) * 256 + (x % 256)];
      let h = (noise - 0.5) * 0.35;
      let g = 0;
      for (const tr of tracks) {
        const cx = tr.t * W + Math.sin((y / H) * Math.PI * 2 + tr.phase) * tr.amp;
        const d = Math.abs(x - cx) / tr.half;
        if (d > 2.2) continue;
        const bowl = d < 1 ? Math.cos((d * Math.PI) / 2) : 0;
        const lip = Math.exp(-Math.pow((d - 1.25) / 0.3, 2)) * 0.35;
        const tread = d < 0.85 ? Math.sin(y * 0.9 + Math.abs(x - cx) * 0.6) * 0.06 * (1 - d) : 0;
        h += (-bowl * tr.depth + lip + tread) * 1.0;
        g = Math.max(g, bowl * tr.depth);
      }
      height[i] = h;
      groove[i] = g;
    }
  }
  const map = rgbCanvas(W, H, (i) => {
    const v = n[(Math.floor(i / W) % 256) * 256 + ((i % W) % 256)];
    const b = 228 + (v - 0.5) * 22 - groove[i] * 48;
    return [b - 7 - groove[i] * 6, b - 2, b + 6];
  });
  const rough = rgbCanvas(W, H, (i) => {
    const r = 200 - groove[i] * 130;
    return [r, r, r];
  });
  return { map: toTexture(map), normalMap: fieldToNormal(height, W, H, 1.6), roughnessMap: toTexture(rough, false) };
}

export const FACADE = { cols: 16, floors: 12, cell: 80 };

const LIT: [string, string, number][] = [
  ["#ffcf94", "#ff9e4a", 5],
  ["#ffe2b5", "#f7b26a", 3],
  ["#fff3df", "#e8d2b0", 2],
  ["#d8e8ff", "#9fc0f0", 2],
  ["#8fb8ff", "#3f6fd0", 1],
  ["#ffe7a0", "#e0a040", 1],
];

function pickLit(rng: Rng) {
  const total = LIT.reduce((s, l) => s + l[2], 0);
  let r = rng.next() * total;
  for (const l of LIT) if ((r -= l[2]) <= 0) return l;
  return LIT[0];
}

export type FacadeSet = { map: THREE.Texture; emissive: THREE.Texture; normal: THREE.Texture };

export const WINDOW_BOX = { left: 0.24, width: 0.52, top: 0.2, height: 0.46 };

export function facadeTexture(seed: number, tint: [number, number, number], litRatio: number): FacadeSet {
  const rng = createRng(seed);
  const { cols, floors, cell } = FACADE;
  const W = cols * cell;
  const H = floors * cell;
  const base = canvas(W, H);
  const glow = canvas(W, H);
  const hgt = canvas(W, H);
  const b = base.ctx;
  const g = glow.ctx;
  const h = hgt.ctx;
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  h.fillStyle = "rgb(128,128,128)";
  h.fillRect(0, 0, W, H);

  const n = tileableNoise(256, rng, 4);
  const img = b.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = (n[(y % 256) * 256 + (x % 256)] - 0.5) * 22;
      const i = (y * W + x) * 4;
      img.data.set([tint[0] + v, tint[1] + v, tint[2] + v + 2, 255], i);
    }
  }
  b.putImageData(img, 0, 0);

  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < floors; y++) {
      b.fillStyle = `rgba(${rng.chance(0.5) ? "255,255,255" : "0,0,10"},${rng.range(0, 0.05)})`;
      b.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  for (let i = 0; i < 70; i++) {
    const x = rng.range(0, W);
    const y = rng.range(0, H);
    const grd = b.createLinearGradient(0, y, 0, y + rng.range(60, 300));
    grd.addColorStop(0, `rgba(25,28,40,${rng.range(0.06, 0.16)})`);
    grd.addColorStop(1, "rgba(25,28,40,0)");
    b.fillStyle = grd;
    b.fillRect(x, y, rng.range(2, 10), 300);
  }

  for (const [ctx, style] of [
    [b, "rgba(28,32,46,0.55)"],
    [h, "rgb(70,70,70)"],
  ] as const) {
    ctx.fillStyle = style;
    for (let x = 0; x <= cols; x++) ctx.fillRect(x * cell - 1, 0, 3, H);
    for (let y = 0; y <= floors; y++) ctx.fillRect(0, y * cell - 1, W, 3);
  }

  const ww = cell * WINDOW_BOX.width;
  const wh = cell * WINDOW_BOX.height;
  for (let x = 0; x < cols; x++) {
    const stair = x === 7;
    for (let y = 0; y < floors; y++) {
      const w = stair ? cell * 0.22 : ww;
      const wx = x * cell + (cell - w) / 2;
      const wy = y * cell + cell * WINDOW_BOX.top;
      const whh = stair ? cell * 0.62 : wh;

      h.fillStyle = "rgb(40,40,40)";
      h.fillRect(wx - 3, wy - 3, w + 6, whh + 6);
      const glass = b.createLinearGradient(0, wy, 0, wy + whh);
      glass.addColorStop(0, "#1a2540");
      glass.addColorStop(1, "#0b1020");
      b.fillStyle = glass;
      b.fillRect(wx, wy, w, whh);
      b.fillStyle = "rgba(0,0,0,0.35)";
      b.fillRect(wx - 3, wy - 3, w + 6, 4);
      b.fillRect(wx - 3, wy - 3, 3, whh + 6);

      const lit = rng.chance(stair ? 0.45 : litRatio);
      if (lit) {
        const [c1, c2] = stair ? ["#dfeaff", "#a8bde0"] : pickLit(rng);
        const grd = g.createLinearGradient(0, wy, 0, wy + whh);
        grd.addColorStop(0, c1);
        grd.addColorStop(1, c2);
        g.fillStyle = grd;
        g.globalAlpha = rng.range(0.45, 1);
        g.fillRect(wx, wy, w, whh);
        if (!stair) {
          const folds = rng.int(6, 14);
          for (let f = 0; f < folds; f++) {
            g.fillStyle = `rgba(0,0,0,${rng.range(0.05, 0.25)})`;
            g.fillRect(wx + (f / folds) * w, wy, w / folds / 2, whh);
          }
          if (rng.chance(0.45)) {
            const cw = w * rng.range(0.2, 0.5);
            g.fillStyle = `rgba(0,0,0,${rng.range(0.5, 0.85)})`;
            g.fillRect(rng.chance(0.5) ? wx : wx + w - cw, wy, cw, whh);
          }
          if (rng.chance(0.25)) {
            g.fillStyle = "rgba(0,0,0,0.75)";
            g.beginPath();
            g.ellipse(wx + rng.range(0.2, 0.8) * w, wy + whh, rng.range(4, 9), rng.range(6, 12), 0, Math.PI, 0);
            g.fill();
          }
        }
        g.globalAlpha = 1;
        b.fillStyle = c2;
        b.globalAlpha = 0.25;
        b.fillRect(wx, wy, w, whh);
        b.globalAlpha = 1;
      } else if (rng.chance(0.3)) {
        b.fillStyle = "rgba(200,190,170,0.08)";
        b.fillRect(wx, wy, w * rng.range(0.3, 1), whh);
      }

      const frame = rng.chance(0.6) ? "#c9cdd6" : "#5a5048";
      for (const ctx of [b, g]) {
        ctx.fillStyle = ctx === b ? frame : "#000";
        ctx.fillRect(wx, wy, w, 2);
        ctx.fillRect(wx, wy + whh - 2, w, 2);
        ctx.fillRect(wx, wy, 2, whh);
        ctx.fillRect(wx + w - 2, wy, 2, whh);
        if (!stair) {
          ctx.fillRect(wx + w * 0.5 - 1, wy, 3, whh);
          ctx.fillRect(wx, wy + whh * 0.28, w, 2);
        }
      }
      h.fillStyle = "rgb(110,110,110)";
      h.fillRect(wx, wy, w, 2);
      h.fillRect(wx, wy + whh - 2, w, 2);

      const sy = wy + whh + 1;
      b.fillStyle = "#6b7080";
      b.fillRect(wx - 5, sy, w + 10, 4);
      b.fillStyle = "#f2f5ff";
      b.beginPath();
      b.ellipse(wx + w / 2, sy, w / 2 + 4, rng.range(2, 4), 0, Math.PI, 0);
      b.fill();
      h.fillStyle = "rgb(225,225,225)";
      h.fillRect(wx - 5, sy - 3, w + 10, 7);
    }
  }

  return { map: toTexture(base.c), emissive: toTexture(glow.c), normal: heightToNormal(hgt.c, 2.2) };
}

export function gableTexture(seed: number, tint: [number, number, number]): FacadeSet {
  const rng = createRng(seed);
  const cell = FACADE.cell;
  const W = 4 * cell;
  const H = 12 * cell;
  const base = canvas(W, H);
  const glow = canvas(W, H);
  const hgt = canvas(W, H);
  glow.ctx.fillStyle = "#000";
  glow.ctx.fillRect(0, 0, W, H);
  hgt.ctx.fillStyle = "rgb(128,128,128)";
  hgt.ctx.fillRect(0, 0, W, H);
  const n = tileableNoise(256, rng, 4);
  const img = base.ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = (n[(y % 256) * 256 + (x % 256)] - 0.5) * 22;
      img.data.set([tint[0] + v, tint[1] + v, tint[2] + v + 2, 255], (y * W + x) * 4);
    }
  }
  base.ctx.putImageData(img, 0, 0);
  for (const [ctx, style] of [
    [base.ctx, "rgba(28,32,46,0.5)"],
    [hgt.ctx, "rgb(70,70,70)"],
  ] as const) {
    ctx.fillStyle = style;
    for (let x = 0; x <= 4; x++) ctx.fillRect(x * cell - 1, 0, 3, H);
    for (let y = 0; y <= 12; y++) ctx.fillRect(0, y * cell - 1, W, 3);
  }
  for (let i = 0; i < 30; i++) {
    const x = rng.range(0, W);
    const y = rng.range(0, H);
    const grd = base.ctx.createLinearGradient(0, y, 0, y + 250);
    grd.addColorStop(0, `rgba(25,28,40,${rng.range(0.06, 0.14)})`);
    grd.addColorStop(1, "rgba(25,28,40,0)");
    base.ctx.fillStyle = grd;
    base.ctx.fillRect(x, y, rng.range(2, 8), 250);
  }
  return { map: toTexture(base.c), emissive: toTexture(glow.c), normal: heightToNormal(hgt.c, 2) };
}

export const BARK_TILE = { around: 0.6, along: 1.2 };

export function barkTexture() {
  const W = 512;
  const H = 1024;
  const rng = createRng(31);
  const albedo = canvas(W, H);
  const height = canvas(W, H);
  const a = albedo.ctx;
  const h = height.ctx;
  const n = tileableNoise(256, rng, 5);
  const img = a.createImageData(W, H);
  const himg = h.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = n[((y >> 1) % 256) * 256 + ((x >> 1) % 256)];
      const band = Math.sin(y * 0.09 + v * 6) * 0.5 + 0.5;
      const b = 214 + (v - 0.5) * 34 + band * 8;
      const i = (y * W + x) * 4;
      img.data.set([b + 2, b, b - 4, 255], i);
      const hv = 150 + (v - 0.5) * 40 + band * 12;
      himg.data.set([hv, hv, hv, 255], i);
    }
  }
  a.putImageData(img, 0, 0);
  h.putImageData(himg, 0, 0);

  // Draw wrapped horizontally so the texture tiles around the trunk
  const wrap = (fn: (ox: number) => void) => [-W, 0, W].forEach(fn);
  const dash = (x: number, y: number, w: number, t: number, col: string, hcol: string) =>
    wrap((ox) => {
      for (const [ctx, c] of [[a, col], [h, hcol]] as const) {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.ellipse(x + ox, y, w / 2, t / 2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    });

  for (let i = 0; i < 260; i++) {
    const dark = rng.chance(0.75);
    dash(
      rng.range(0, W),
      rng.range(0, H),
      rng.range(14, 90),
      rng.range(1.5, 5),
      dark ? `rgba(28,26,30,${rng.range(0.45, 0.9)})` : `rgba(150,130,120,${rng.range(0.3, 0.6)})`,
      `rgba(60,60,60,${rng.range(0.4, 0.8)})`
    );
  }
  for (let i = 0; i < 9; i++) {
    const x = rng.range(0, W);
    const y = rng.range(0, H);
    const w = rng.range(30, 80);
    const t = rng.range(16, 40);
    wrap((ox) => {
      for (const [ctx, c] of [[a, "rgba(18,16,20,0.92)"], [h, "rgb(40,40,40)"]] as const) {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.moveTo(x + ox - w / 2, y);
        ctx.quadraticCurveTo(x + ox, y - t, x + ox + w / 2, y);
        ctx.quadraticCurveTo(x + ox, y + t * 0.6, x + ox - w / 2, y);
        ctx.fill();
      }
    });
  }
  for (let i = 0; i < 14; i++) {
    const x = rng.range(0, W);
    const y = rng.range(0, H);
    wrap((ox) => {
      a.fillStyle = `rgba(190,150,130,${rng.range(0.15, 0.3)})`;
      a.fillRect(x + ox, y, rng.range(20, 60), rng.range(6, 18));
    });
  }
  const map = toTexture(albedo.c);
  return { map, normalMap: heightToNormal(height.c, 2.5) };
}

export function radialTexture(inner = "rgba(255,255,255,1)", mid = "rgba(255,255,255,0.25)") {
  const size = 256;
  const { c, ctx } = canvas(size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.2, mid);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function footprintMaps() {
  const W = 128;
  const H = 512;
  const rng = createRng(23);
  const height = canvas(W, H);
  const alpha = canvas(W, H);
  height.ctx.fillStyle = "rgb(128,128,128)";
  height.ctx.fillRect(0, 0, W, H);
  alpha.ctx.fillStyle = "#000";
  alpha.ctx.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 20) {
    for (const lane of [-1, 1]) {
      if (rng.chance(0.15)) continue;
      const side = (y / 20) % 2 === 0 ? -1 : 1;
      const x = W / 2 + lane * 24 + side * 7 + rng.range(-4, 4);
      const yy = (y + lane * 9 + H) % H;
      const rot = rng.range(-0.25, 0.25);
      const depth = rng.int(30, 70);
      height.ctx.fillStyle = `rgb(${depth},${depth},${depth})`;
      height.ctx.beginPath();
      height.ctx.ellipse(x, yy, 5.5, 10, rot, 0, Math.PI * 2);
      height.ctx.fill();
      alpha.ctx.fillStyle = `rgba(255,255,255,${rng.range(0.35, 0.7)})`;
      alpha.ctx.beginPath();
      alpha.ctx.ellipse(x, yy, 6.5, 11, rot, 0, Math.PI * 2);
      alpha.ctx.fill();
    }
  }
  return { normalMap: heightToNormal(height.c, 3), alphaMap: toTexture(alpha.c, false) };
}


/** One boot print (toe at the top of the texture): a pressed sole and heel with soft, crumbled rims. */
export function bootPrintMaps() {
  const W = 64;
  const H = 160;
  const rng = createRng(77);
  const height = canvas(W, H);
  const alpha = canvas(W, H);
  height.ctx.fillStyle = "rgb(150,150,150)";
  height.ctx.fillRect(0, 0, W, H);
  alpha.ctx.fillStyle = "#000";
  alpha.ctx.fillRect(0, 0, W, H);
  const press = (ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, fill: string, blur: number) => {
    ctx.filter = `blur(${blur}px)`;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  // Raised, crumbled rim pushed out around the print, then the pressed sole and heel
  press(height.ctx, 32, 50, 24, 42, "rgb(185,185,185)", 4);
  press(height.ctx, 32, 122, 20, 26, "rgb(185,185,185)", 4);
  press(height.ctx, 32, 50, 18, 36, "rgb(40,40,40)", 2);
  press(height.ctx, 32, 122, 15, 21, "rgb(55,55,55)", 2);
  // Tread: a few shallow bars across the sole
  height.ctx.filter = "blur(1px)";
  for (let y = 24; y < 84; y += 9) {
    height.ctx.fillStyle = `rgb(${rng.int(70, 95)},${rng.int(70, 95)},${rng.int(70, 95)})`;
    height.ctx.fillRect(18, y, 28, 3);
  }
  press(alpha.ctx, 32, 50, 22, 40, "rgba(255,255,255,0.85)", 4);
  press(alpha.ctx, 32, 122, 18, 24, "rgba(255,255,255,0.85)", 4);
  height.ctx.filter = alpha.ctx.filter = "none";
  const normalMap = heightToNormal(height.c, 4);
  const alphaMap = toTexture(alpha.c, false);
  for (const t of [normalMap, alphaMap]) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return { normalMap, alphaMap };
}

/**
 * A snowball splat: a packed, lumpy core with a broken rim and grains thrown outward along short rays.
 * The colour map carries alpha (porous, never a flat disc); the normal map gives it crumbly relief.
 */
export function snowSplatMaps() {
  const S = 256;
  const rng = createRng(131);
  const h = new Float32Array(S * S);
  const blob = (cx: number, cy: number, r: number, amp: number) => {
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(S - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(S - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / r;
        if (d < 1) h[y * S + x] += amp * (1 - d * d) * (1 - d * d);
      }
    }
  };
  // Core: many overlapping lumps
  for (let i = 0; i < 70; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * 46;
    blob(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, rng.range(8, 22), rng.range(0.25, 0.55));
  }
  // Rays of grains flung outward
  for (let k = 0; k < 14; k++) {
    const a = rng.range(0, Math.PI * 2);
    const len = rng.range(30, 70);
    for (let j = 0; j < 8; j++) {
      const r = 44 + (j / 8) * len + rng.range(-4, 4);
      blob(S / 2 + Math.cos(a) * r + rng.range(-3, 3), S / 2 + Math.sin(a) * r + rng.range(-3, 3), rng.range(1.5, 5) * (1 - j / 10), rng.range(0.3, 0.6));
    }
  }
  // Loose scattered grains
  for (let i = 0; i < 160; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(40, 118);
    blob(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, rng.range(1, 3), rng.range(0.25, 0.5));
  }

  const color = canvas(S, S);
  const height = canvas(S, S);
  const ci = color.ctx.createImageData(S, S);
  const hi = height.ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = Math.min(h[i], 1.2);
    // Porous: fine noise eats into the alpha so it reads as packed grains, not paint
    const grain = rng.next();
    const alpha = Math.min(1, Math.max(0, (v - 0.06) / 0.22)) * (0.82 + 0.18 * grain);
    const shade = 0.82 + 0.18 * Math.min(v, 1) + (grain - 0.5) * 0.06;
    ci.data[i * 4] = 236 * shade;
    ci.data[i * 4 + 1] = 242 * shade;
    ci.data[i * 4 + 2] = 255 * shade;
    ci.data[i * 4 + 3] = alpha * 255;
    const hv = Math.min(255, (v * 0.8 + grain * 0.08) * 255);
    hi.data[i * 4] = hi.data[i * 4 + 1] = hi.data[i * 4 + 2] = hv;
    hi.data[i * 4 + 3] = 255;
  }
  color.ctx.putImageData(ci, 0, 0);
  height.ctx.putImageData(hi, 0, 0);
  const map = toTexture(color.c, true);
  const normalMap = heightToNormal(height.c, 5);
  for (const t of [map, normalMap]) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return { map, normalMap };
}
