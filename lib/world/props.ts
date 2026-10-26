import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { createRng } from "./random";
import { BARK_TILE } from "./textures";

function colored(geo: THREE.BufferGeometry, color: THREE.Color) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const colors = new Float32Array(g.getAttribute("position").count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([color.r, color.g, color.b], i);
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

export function treeGeometry(seed: number, kind: "birch" | "dark" | "bush") {
  const rng = createRng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const birch = kind === "birch";
  const trunkCol = new THREE.Color(birch ? "#ffffff" : "#3a3740");
  const twigCol = new THREE.Color(birch ? "#2c2228" : "#25222a");
  const maxDepth = kind === "bush" ? 3 : 5;

  // One continuous tapered tube per branch: separate cylinders left cracks and snow-catching ledges at every bend
  const tube = (points: THREE.Vector3[], r0: number, r1: number, radial: number, color: THREE.Color) => {
    const rings = points.length;
    const pos: number[] = [];
    const uvs: number[] = [];
    const idx: number[] = [];
    const around = Math.max(1, Math.round((Math.PI * 2 * r0) / BARK_TILE.around));
    let normal = new THREE.Vector3();
    let travelled = 0;
    for (let i = 0; i < rings; i++) {
      const tangent = (i < rings - 1 ? points[i + 1].clone().sub(points[i]) : points[i].clone().sub(points[i - 1])).normalize();
      if (i === 0) {
        normal = Math.abs(tangent.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(tangent).normalize() : new THREE.Vector3(1, 0, 0).cross(tangent).normalize();
      } else {
        travelled += points[i].distanceTo(points[i - 1]);
        normal.sub(tangent.clone().multiplyScalar(normal.dot(tangent))).normalize();
      }
      const binormal = tangent.clone().cross(normal);
      const r = THREE.MathUtils.lerp(r0, r1, i / (rings - 1));
      for (let j = 0; j <= radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        const off = normal.clone().multiplyScalar(Math.cos(a) * r).addScaledVector(binormal, Math.sin(a) * r);
        pos.push(points[i].x + off.x, points[i].y + off.y, points[i].z + off.z);
        uvs.push((j / radial) * around, (points[0].y + travelled) / BARK_TILE.along);
      }
    }
    for (let i = 0; i < rings - 1; i++) {
      for (let j = 0; j < radial; j++) {
        const a = i * (radial + 1) + j;
        const b = a + radial + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    parts.push(colored(geo, color));
  };

  const branch = (start: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, depth: number) => {
    const segs = depth <= 1 ? 6 : depth < 3 ? 2 : 1;
    const points = [start.clone()];
    let d = dir.clone();
    for (let s = 0; s < segs; s++) {
      points.push(points[s].clone().addScaledVector(d, len / segs));
      d = d.clone().add(new THREE.Vector3(rng.range(-0.06, 0.06), birch && depth > 2 ? -0.08 : 0, rng.range(-0.06, 0.06))).normalize();
    }
    const endRad = rad * 0.7;
    tube(points, rad, endRad, depth === 0 ? 14 : depth < 3 ? 7 : 3, trunkCol.clone().lerp(twigCol, Math.min(depth / 2, 1)));
    const p = points[points.length - 1];
    const along = (t: number) => {
      const f = t * segs;
      const i = Math.min(Math.floor(f), segs - 1);
      return points[i].clone().lerp(points[i + 1], f - i);
    };
    if (depth >= maxDepth) return;
    const kids = depth === 0 ? rng.int(5, 8) : rng.int(2, 3);
    for (let k = 0; k < kids; k++) {
      const from = along(depth === 0 ? rng.range(0.3, 0.95) : rng.range(0.55, 1));
      const spread = depth === 0 ? 1.1 : 0.75;
      const nd = d
        .clone()
        .add(new THREE.Vector3(rng.range(-1, 1), rng.range(-0.1, 0.6), rng.range(-1, 1)).multiplyScalar(spread))
        .normalize();
      if (birch && depth >= 3) nd.y -= 0.35;
      nd.normalize();
      branch(from, nd, len * rng.range(0.5, 0.72), rad * 0.5, depth + 1);
    }
    // The leader carries on at the same radius and heading, so the joint has no step
    if (depth < 2) branch(p, d.clone().add(new THREE.Vector3(rng.range(-0.1, 0.1), 0.3, rng.range(-0.1, 0.1))).normalize(), len * 0.6, endRad, depth + 1);
  };

  const height = kind === "bush" ? 1.4 : rng.range(5.5, 8);
  branch(new THREE.Vector3(), new THREE.Vector3(rng.range(-0.06, 0.06), 1, rng.range(-0.06, 0.06)).normalize(), height, kind === "bush" ? 0.03 : 0.17, 0);
  return mergeGeometries(parts)!;
}

function superEllipsoid(a: number, b: number, c: number, n: number, seg = 48) {
  const g = new THREE.SphereGeometry(1, seg, seg / 2);
  const pos = g.getAttribute("position");
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const r = Math.pow(Math.pow(Math.abs(v.x), n) + Math.pow(Math.abs(v.y), n) + Math.pow(Math.abs(v.z), n), -1 / n);
    pos.setXYZ(i, v.x * r * a, v.y * r * b, v.z * r * c);
  }
  g.computeVertexNormals();
  return g;
}

export function carParts(seed: number) {
  const rng = createRng(seed);
  const long = rng.range(4.0, 4.3);
  const body = superEllipsoid(long / 2, 0.36, 0.86, 3.6);
  const bp = body.getAttribute("position");
  for (let i = 0; i < bp.count; i++) {
    const x = bp.getX(i);
    const y = bp.getY(i);
    if (y > 0.2) bp.setY(i, y + Math.sin((x / long) * Math.PI) * 0.06 + rng.range(-0.01, 0.01));
  }
  body.computeVertexNormals();
  body.translate(0, 0.7, 0);
  const glass = superEllipsoid(1.2, 0.44, 0.8, 3.0);
  const gp = glass.getAttribute("position");
  for (let i = 0; i < gp.count; i++) {
    const y = gp.getY(i);
    if (y > 0) {
      gp.setX(i, gp.getX(i) * (1 - y * 0.6));
      gp.setZ(i, gp.getZ(i) * (1 - y * 0.25));
    }
  }
  glass.computeVertexNormals();
  glass.translate(-0.15, 1.12, 0);
  const wheels: THREE.BufferGeometry[] = [];
  for (const [x, z] of [
    [1.25, 0.74],
    [-1.25, 0.74],
    [1.25, -0.74],
    [-1.25, -0.74],
  ]) {
    const w = new THREE.CylinderGeometry(0.31, 0.31, 0.2, 20);
    w.rotateX(Math.PI / 2);
    w.translate(x, 0.31, z);
    wheels.push(w);
  }
  return { body, glass, wheels: mergeGeometries(wheels)! };
}

export function streetLampGeometry() {
  const pole = new THREE.CylinderGeometry(0.075, 0.12, 8, 12);
  pole.translate(0, 4, 0);
  const base = new THREE.CylinderGeometry(0.18, 0.22, 0.6, 12);
  base.translate(0, 0.3, 0);
  const arm = new THREE.CylinderGeometry(0.045, 0.045, 1.5, 8);
  arm.rotateZ(Math.PI / 2 - 0.12);
  arm.translate(-0.72, 7.95, 0);
  const head = new RoundedBoxGeometry(0.95, 0.2, 0.42, 3, 0.08);
  head.translate(-1.55, 7.9, 0);
  return mergeGeometries([pole, base, arm, head].map((g) => (g.index ? g.toNonIndexed() : g)))!;
}

export function parkLampGeometry() {
  const pole = new THREE.CylinderGeometry(0.055, 0.08, 4.2, 10);
  pole.translate(0, 2.1, 0);
  const disc = new THREE.CylinderGeometry(0.5, 0.42, 0.1, 24);
  disc.translate(0, 4.3, 0);
  const cap = new THREE.SphereGeometry(0.5, 24, 6, 0, Math.PI * 2, 0, 0.5);
  cap.translate(0, 3.92, 0);
  return mergeGeometries([pole, disc, cap].map((g) => g.toNonIndexed()))!;
}

export function balconyGeometry() {
  const w = 2.7;
  const d = 1.15;
  const slab = new THREE.BoxGeometry(w, 0.14, d);
  slab.translate(0, 0, d / 2);
  const front = new THREE.BoxGeometry(w, 0.95, 0.06);
  front.translate(0, 0.54, d - 0.03);
  const left = new THREE.BoxGeometry(0.06, 0.95, d);
  left.translate(-w / 2 + 0.03, 0.54, d / 2);
  const right = left.clone();
  right.translate(w - 0.06, 0, 0);
  return mergeGeometries([slab, front, left, right])!;
}
