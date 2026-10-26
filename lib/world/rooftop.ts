import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Collider } from "./city";
import { snowify } from "./materials";

const EYE = 1.68;
// Metres a second on the ladder; a little quicker holding shift
const CLIMB_SPEED = 1.7;
const CLIMB_RUN = 2.6;
const RUNG = 0.3;
// The ladder hangs this far in from the street-side corner of the roof
const FROM_CORNER = 2.4;
const WALL_GAP = 0.2;
const HALF_WIDTH = 0.35;
// A roomy safety cage: wide hoops, far apart, so the climb is not a view through bars
const CAGE_R = 0.85;
const HOOP_EVERY = 1.6;
// Where your eye sits while climbing, out from the rungs (inside the cage)
const EYE_OUT = WALL_GAP + 0.42;
// Height map resolution over each block (m)
const CELL = 0.5;

type Phase = "idle" | "mount" | "on" | "over" | "back" | "off";

type Ladder = {
  block: Collider;
  /** Outward normal of the wall the ladder is on (horizontal, unit). */
  n: THREE.Vector3;
  /** Foot of the ladder on the wall face. */
  base: THREE.Vector3;
  groundY: number;
  roofY: number;
  /** Top of the parapet the ladder climbs over. */
  topY: number;
  /** Where you stand on the roof after climbing over (feet). */
  arrive: THREE.Vector3;
  colliders: Collider[];
  /** How far the wall stands behind the ladder's line, when the ladder is braced out past an overhang. */
  standoff?: number;
};

type Grid = { x0: number; z0: number; w: number; h: number; y: Float32Array };

/**
 * Fire ladders with safety cages up the end wall of every panel block, onto roofs you can walk around. You climb
 * them yourself (forward key up, back key down; over the parapet at the top, off onto the snow at the bottom).
 * The building sets are different models, so each block is measured from its own triangles: a height map gives
 * the roof level, its walkable extent and whatever stands up out of it (stair houses, lift rooms, parapets).
 */
export class Rooftop {
  group = new THREE.Group();
  private ladders: Ladder[] = [];
  private mesh?: THREE.Mesh;
  // Ladders that stay whatever the building set (the radio mast's)
  private fixed: Ladder[] = [];
  private phase: Phase = "idle";
  private active?: Ladder;
  private t = 0;
  private y = 0;
  private from = new THREE.Vector3();
  private fromY = 0;
  private lastRung = 0;
  private mat = snowify(new THREE.MeshStandardMaterial({ color: "#2c3240", roughness: 0.6, metalness: 0.55 }), { coat: 0.45, coatNoise: 0.4 });
  private ray = new THREE.Raycaster();
  /** A rung under the hand or boot (for the clank). */
  onRung?: () => void;

  /** Blocks whose solid box is replaced, and the roof colliders that replace them. */
  get colliders() {
    return { remove: this.ladders.map((l) => l.block), add: this.ladders.flatMap((l) => l.colliders) };
  }

  get busy() {
    return this.phase !== "idle";
  }

  /** True while you hang on the ladder waiting for the up / down keys. */
  get onLadder() {
    return this.phase === "on";
  }

  /** A ladder that is not on a building block and stays put when the building set changes. */
  addFixed(l: Omit<Ladder, "block" | "colliders">) {
    const ladder: Ladder = { ...l, block: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }, colliders: [] };
    this.fixed.push(ladder);
    const mesh = new THREE.Mesh(this.ladderGeometry(ladder), this.mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.noCull = true;
    this.group.add(mesh);
  }

  /** Measures every block in this building set and hangs a ladder on each. */
  place(group: THREE.Object3D, blocks: Collider[], groundAt: (x: number, z: number) => number) {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = undefined;
    }
    this.ladders = [];
    this.phase = "idle";
    const targets = blocks.filter((b) => b.maxX - b.minX > 8 && b.maxZ - b.minZ > 8);
    if (!targets.length) return;

    group.updateMatrixWorld(true);
    const grids = targets.map((b) => {
      const x0 = b.minX - 1;
      const z0 = b.minZ - 1;
      const w = Math.ceil((b.maxX - b.minX + 2) / CELL);
      const h = Math.ceil((b.maxZ - b.minZ + 2) / CELL);
      return { x0, z0, w, h, y: new Float32Array(w * h).fill(-Infinity) } as Grid;
    });
    const soups: number[][] = targets.map(() => []);
    this.rasterize(group, targets, grids, soups);

    const geos: THREE.BufferGeometry[] = [];
    targets.forEach((b, i) => {
      const ladder = this.measure(b, grids[i], soups[i], groundAt, blocks);
      if (!ladder) return;
      this.ladders.push(ladder);
      geos.push(this.ladderGeometry(ladder));
    });
    if (!geos.length) return;
    this.mesh = new THREE.Mesh(mergeGeometries(geos)!, this.mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);
  }

  /** One pass over the set's triangles: tops go into each block's height map, everything into its triangle soup. */
  private rasterize(group: THREE.Object3D, blocks: Collider[], grids: Grid[], soups: number[][]) {
    const m = new THREE.Matrix4();
    const inst = new THREE.Matrix4();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const pad = 2;
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.getAttribute("position");
      const index = mesh.geometry.index;
      const tris = (index ? index.count : pos.count) / 3;
      const im = mesh as THREE.InstancedMesh;
      const count = im.isInstancedMesh ? im.count : 1;
      const vi = (t: number, j: number) => (index ? index.getX(t * 3 + j) : t * 3 + j);
      for (let k = 0; k < count; k++) {
        m.copy(mesh.matrixWorld);
        if (im.isInstancedMesh) {
          im.getMatrixAt(k, inst);
          m.multiply(inst);
        }
        for (let t = 0; t < tris; t++) {
          a.fromBufferAttribute(pos, vi(t, 0)).applyMatrix4(m);
          b.fromBufferAttribute(pos, vi(t, 1)).applyMatrix4(m);
          c.fromBufferAttribute(pos, vi(t, 2)).applyMatrix4(m);
          const cx = (a.x + b.x + c.x) / 3;
          const cz = (a.z + b.z + c.z) / 3;
          const bi = blocks.findIndex((q) => cx > q.minX - pad && cx < q.maxX + pad && cz > q.minZ - pad && cz < q.maxZ + pad);
          if (bi < 0) continue;
          soups[bi].push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
          n.subVectors(b, a).cross(c.clone().sub(a));
          const len = n.length();
          if (len < 1e-9 || Math.abs(n.y / len) < 0.6) continue;
          this.fill(grids[bi], a, b, c);
        }
      }
    });
  }

  /** Writes the highest point of a flat-ish triangle into every height-map cell whose centre it covers. */
  private fill(g: Grid, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
    const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - g.x0) / CELL));
    const i1 = Math.min(g.w - 1, Math.floor((Math.max(a.x, b.x, c.x) - g.x0) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - g.z0) / CELL));
    const j1 = Math.min(g.h - 1, Math.floor((Math.max(a.z, b.z, c.z) - g.z0) / CELL));
    const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(d) < 1e-12) return;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = g.x0 + (i + 0.5) * CELL;
        const pz = g.z0 + (j + 0.5) * CELL;
        const l1 = ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / d;
        const l2 = ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
        const y = l1 * a.y + l2 * b.y + l3 * c.y;
        const k = j * g.w + i;
        if (y > g.y[k]) g.y[k] = y;
      }
    }
  }

  private measure(b: Collider, g: Grid, soup: number[], groundAt: (x: number, z: number) => number, others: Collider[]): Ladder | null {
    const at = (i: number, j: number) => (i < 0 || j < 0 || i >= g.w || j >= g.h ? -Infinity : g.y[j * g.w + i]);
    // The roof is the most common height over the block
    const counts = new Map<number, number>();
    for (const y of g.y) {
      if (!(y > 5)) continue;
      const k = Math.round(y * 5) / 5;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    if (!counts.size) return null;
    const roofY = [...counts].sort((p, q) => q[1] - p[1])[0][0];
    const flat = (y: number) => y > roofY - 0.3 && y < roofY + 0.35;

    // The walkable rectangle: every flat roof cell
    let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
    for (let j = 0; j < g.h; j++) {
      for (let i = 0; i < g.w; i++) {
        if (!flat(at(i, j))) continue;
        i0 = Math.min(i0, i);
        i1 = Math.max(i1, i);
        j0 = Math.min(j0, j);
        j1 = Math.max(j1, j);
      }
    }
    if (i1 - i0 < 6 || j1 - j0 < 6) return null;
    const rect = { minX: g.x0 + i0 * CELL, maxX: g.x0 + (i1 + 1) * CELL, minZ: g.z0 + j0 * CELL, maxZ: g.z0 + (j1 + 1) * CELL };
    const colliders: Collider[] = [{ ...rect, top: roofY }];
    // Everything else the height map found becomes something you stand on at its own height: parapets you can jump
    // onto, lower wings you can drop to, stair houses too tall to climb. Where there is nothing (past the edge, the
    // gaps between wings) there is nothing to hold you: you can walk off and fall. Cells are merged into strips per
    // row, then strips that repeat row after row into blocks, to keep the list short
    const groundY = groundAt((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2);
    type Strip = { i0: number; i1: number; top: number; j0: number; j1: number };
    let open: Strip[] = [];
    const done: Strip[] = [];
    for (let j = 0; j <= g.h; j++) {
      const row: Strip[] = [];
      if (j < g.h) {
        let cur: Strip | null = null;
        for (let i = 0; i <= g.w; i++) {
          const y = i < g.w ? at(i, j) : -Infinity;
          const inRoof = i >= i0 && i <= i1 && j >= j0 && j <= j1 && flat(y);
          const solid = !inRoof && y > groundY + 0.6;
          if (cur && (!solid || Math.abs(y - cur.top) > 0.25)) {
            row.push(cur);
            cur = null;
          }
          if (solid && !cur) cur = { i0: i, i1: i, top: y, j0: j, j1: j };
          else if (solid && cur) {
            cur.i1 = i;
            cur.top = Math.max(cur.top, y);
          }
        }
      }
      // Carry on strips that line up with the row above; close the rest
      const next: Strip[] = [];
      for (const r of row) {
        const prev = open.find((o) => o.i0 === r.i0 && o.i1 === r.i1 && Math.abs(o.top - r.top) < 0.25);
        if (prev) {
          prev.j1 = j;
          prev.top = Math.max(prev.top, r.top);
          next.push(prev);
          open = open.filter((o) => o !== prev);
        } else next.push(r);
      }
      done.push(...open);
      open = next;
    }
    done.push(...open);
    for (const st of done) {
      colliders.push({
        minX: g.x0 + st.i0 * CELL,
        maxX: g.x0 + (st.i1 + 1) * CELL,
        minZ: g.z0 + st.j0 * CELL,
        maxZ: g.z0 + (st.j1 + 1) * CELL,
        top: st.top,
      });
    }

    // Which wall: the short end first (on blocks running along the street the north end, across it the street end),
    // then the far end, then the long sides. A wall that another block stands right against is skipped: two blocks
    // built end to end get their ladders on their outer ends, not in the crack between them
    const alongZ = b.maxZ - b.minZ >= b.maxX - b.minX;
    const street = new THREE.Vector3(b.minX > 0 ? -1 : 1, 0, 0);
    const ends = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
    const sides = [street, street.clone().negate()];
    const faces = alongZ ? [...ends, ...sides] : [...sides, ...ends];
    const clear = (p: THREE.Vector3, n: THREE.Vector3) =>
      [0.6, 1.4, 2.4, 3.5].every((s) => {
        const q = p.clone().addScaledVector(n, s);
        return !others.some((o) => o !== b && q.x > o.minX - 0.4 && q.x < o.maxX + 0.4 && q.z > o.minZ - 0.4 && q.z < o.maxZ + 0.4);
      });

    const soupGeo = new THREE.BufferGeometry();
    soupGeo.setAttribute("position", new THREE.Float32BufferAttribute(soup, 3));
    const soupMesh = new THREE.Mesh(soupGeo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const cell = (p: THREE.Vector3) => [Math.floor((p.x - g.x0) / CELL), Math.floor((p.z - g.z0) / CELL)] as const;
    let found: Ladder | null = null;
    for (const n of faces) {
      // A wall facing along z runs along x, and the other way round
      const onZ = n.z !== 0;
      const sgn = onZ ? n.z : n.x;
      const edge = onZ ? (sgn > 0 ? rect.maxZ : rect.minZ) : sgn > 0 ? rect.maxX : rect.minX;
      // How far the flat roof reaches along that wall, a couple of metres in (wings and bays can make it narrower
      // than the whole roof)
      let lo = Infinity;
      let hi = -Infinity;
      const inside = edge - sgn * 2.5;
      for (let k = 0; k < (onZ ? g.w : g.h); k++) {
        const ci = onZ ? k : Math.floor((inside - g.x0) / CELL);
        const cj = onZ ? Math.floor((inside - g.z0) / CELL) : k;
        if (!flat(at(ci, cj))) continue;
        const v = onZ ? g.x0 + (k + 0.5) * CELL : g.z0 + (k + 0.5) * CELL;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      if (!(hi > lo)) continue;
      // Near the street-side corner if there is clear roof behind it there, otherwise a little further in
      for (const inset of [FROM_CORNER, 3.2, 4, 5, 6.5, 8, 10]) {
        const side = onZ ? (b.maxX < 0 ? hi - inset : lo + inset) : hi - inset;
        if (side < lo || side > hi) continue;
        // The wall itself, a few storeys up, with one ray into this block's triangles
        const from = onZ ? new THREE.Vector3(side, 9, edge + sgn * 8) : new THREE.Vector3(edge + sgn * 8, 9, side);
        this.ray.set(from, n.clone().negate());
        this.ray.far = 20;
        const hit = this.ray.intersectObject(soupMesh)[0];
        if (!hit) continue;
        const face = onZ ? hit.point.z : hit.point.x;
        const base = onZ ? new THREE.Vector3(side, 0, face) : new THREE.Vector3(face, 0, side);
        if (!clear(base, n)) continue;
        const groundY = groundAt(base.x + n.x * 0.8, base.z + n.z * 0.8);
        base.y = groundY;
        // The parapet top just inside the wall, and a clear spot on the roof beyond it
        let topY = roofY;
        for (let s = 0.1; s < 1.2; s += 0.25) {
          const [ci, cj] = cell(base.clone().addScaledVector(n, -s));
          topY = Math.max(topY, Math.min(at(ci, cj), roofY + 1.5));
        }
        let arrive: THREE.Vector3 | null = null;
        for (let s = 1.3; s < 4; s += 0.25) {
          const p = base.clone().addScaledVector(n, -s);
          const [ci, cj] = cell(p);
          if ([-1, 0, 1].every((di) => [-1, 0, 1].every((dj) => flat(at(ci + di, cj + dj))))) {
            arrive = p.setY(roofY);
            break;
          }
        }
        if (!arrive) continue;
        found = { block: b, n, base, groundY, roofY, topY, arrive, colliders };
        break;
      }
      if (found) break;
    }
    soupGeo.dispose();
    return found;
  }

  private ladderGeometry(l: Ladder) {
    const parts: THREE.BufferGeometry[] = [];
    const t = new THREE.Vector3(0, 1, 0).cross(l.n);
    const yaw = Math.atan2(l.n.x, l.n.z);
    const y0 = l.groundY + 0.35;
    const y1 = l.topY + 1.0;
    const h = y1 - y0;
    // Built facing +z at the origin, then turned to the wall and moved to the foot of the ladder
    const local: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      const rail = new THREE.BoxGeometry(0.06, h, 0.07);
      rail.translate(s * HALF_WIDTH, y0 + h / 2, WALL_GAP);
      local.push(rail);
      // Braced back to the wall (further back when the ladder stands out past an overhang)
      const back = l.standoff ?? 0;
      for (let y = y0 + 1; y < y1; y += 3) {
        const bracket = new THREE.BoxGeometry(0.045, 0.045, WALL_GAP + back);
        bracket.translate(s * HALF_WIDTH, y, (WALL_GAP - back) / 2);
        local.push(bracket);
      }
    }
    for (let y = y0 + RUNG; y < y1 - 0.1; y += RUNG) {
      const rung = new THREE.CylinderGeometry(0.02, 0.02, HALF_WIDTH * 2, 6);
      rung.rotateZ(Math.PI / 2);
      rung.translate(0, y, WALL_GAP);
      local.push(rung);
    }
    const cage0 = y0 + 2.6;
    const cage1 = y1 - 0.3;
    for (let y = cage0; y < cage1; y += HOOP_EVERY) {
      const hoop = new THREE.TorusGeometry(CAGE_R, 0.018, 5, 18, Math.PI);
      hoop.rotateX(Math.PI / 2);
      hoop.translate(0, y, WALL_GAP);
      local.push(hoop);
      // Short ties from the rails out to the wider hoop
      for (const s of [-1, 1]) {
        const tie = new THREE.BoxGeometry(CAGE_R - HALF_WIDTH, 0.035, 0.035);
        tie.translate(s * (HALF_WIDTH + CAGE_R) / 2, y, WALL_GAP);
        local.push(tie);
      }
    }
    // Straps only at the sides: nothing across the middle of the view out
    for (const a of [Math.PI / 6, (5 * Math.PI) / 6]) {
      const strap = new THREE.BoxGeometry(0.04, cage1 - cage0, 0.014);
      strap.rotateY(-a + Math.PI / 2);
      strap.translate(Math.cos(a) * CAGE_R, (cage0 + cage1) / 2, WALL_GAP + Math.sin(a) * CAGE_R);
      local.push(strap);
    }
    for (const s of [-1, 1]) {
      const handle = new THREE.TorusGeometry(0.38, 0.024, 5, 10, Math.PI);
      handle.rotateY(Math.PI / 2);
      handle.translate(s * HALF_WIDTH, y1 - 0.38, WALL_GAP - 0.38);
      local.push(handle);
    }
    const place = new THREE.Matrix4().makeRotationY(yaw).setPosition(l.base.x, 0, l.base.z);
    for (const g of local) parts.push((g.index ? g.toNonIndexed() : g).applyMatrix4(place));
    void t;
    return mergeGeometries(parts)!;
  }

  private eyeOn(l: Ladder, y: number) {
    // Hand over hand: a little sway with each rung
    const sway = Math.sin((y / RUNG) * Math.PI) * 0.02;
    const t = new THREE.Vector3(0, 1, 0).cross(l.n);
    return l.base.clone().addScaledVector(l.n, EYE_OUT).addScaledVector(t, sway).setY(y);
  }

  private bottom(l: Ladder) {
    return l.groundY + EYE;
  }

  private top(l: Ladder) {
    return l.topY + 1.25;
  }

  /** What E would do here, if anything. */
  prompt(feet: THREE.Vector3) {
    if (this.phase === "on") return "@ladder";
    if (this.busy) return null;
    return this.nearby(feet)?.kind ?? null;
  }

  private nearby(feet: THREE.Vector3) {
    for (const l of [...this.ladders, ...this.fixed]) {
      const foot = l.base.clone().addScaledVector(l.n, 0.8);
      if (Math.hypot(feet.x - foot.x, feet.z - foot.z) < 1.2 && feet.y < l.groundY + 1) return { l, kind: "climb" as const };
      if (Math.hypot(feet.x - l.arrive.x, feet.z - l.arrive.z) < 1.4 && Math.abs(feet.y - l.roofY) < 0.6) return { l, kind: "climb down" as const };
    }
    return null;
  }

  /** Steps onto the ladder that `prompt` offered (at the bottom, or at the top from the roof). */
  begin(feet: THREE.Vector3, camera: THREE.Vector3) {
    const near = this.nearby(feet);
    if (!near || this.busy) return false;
    this.active = near.l;
    this.from.copy(camera);
    this.t = 0;
    this.phase = near.kind === "climb" ? "mount" : "back";
    this.y = near.kind === "climb" ? this.bottom(near.l) : this.top(near.l);
    this.lastRung = this.y;
    return true;
  }

  /**
   * Moves the eye on the ladder. `climb` is the up/down input (-1..1). Returns the eye for this frame, plus `done`
   * (where to stand) once you are off the ladder, or null when you are not on one.
   */
  update(dt: number, climb: number, run: boolean): { eye: THREE.Vector3; done?: THREE.Vector3 } | null {
    const l = this.active;
    if (!l || this.phase === "idle") return null;
    this.t += dt;
    const ease = (k: number) => k * k * (3 - 2 * k);
    switch (this.phase) {
      case "mount":
      case "back": {
        const k = Math.min(this.t / 0.7, 1);
        const eye = new THREE.Vector3().lerpVectors(this.from, this.eyeOn(l, this.y), ease(k));
        if (this.phase === "back") eye.y += Math.sin(k * Math.PI) * 0.3;
        if (k >= 1) [this.phase, this.t] = ["on", 0];
        return { eye };
      }
      case "on": {
        const speed = run ? CLIMB_RUN : CLIMB_SPEED;
        const top = this.top(l);
        const bottom = this.bottom(l);
        this.y = THREE.MathUtils.clamp(this.y + climb * speed * dt, bottom, top);
        if (Math.abs(this.y - this.lastRung) >= RUNG) {
          this.lastRung = this.y;
          this.onRung?.();
        }
        const eye = this.eyeOn(l, this.y);
        // Pushing on at either end carries you off the ladder
        if (climb > 0 && this.y >= top) [this.phase, this.t, this.from, this.fromY] = ["over", 0, eye.clone(), this.y];
        if (climb < 0 && this.y <= bottom) [this.phase, this.t, this.from, this.fromY] = ["off", 0, eye.clone(), this.y];
        return { eye };
      }
      case "over": {
        const k = Math.min(this.t / 0.9, 1);
        const end = l.arrive.clone().setY(l.roofY + EYE);
        const eye = new THREE.Vector3().lerpVectors(this.from, end, ease(k));
        eye.y += Math.sin(k * Math.PI) * 0.35;
        if (k >= 1) {
          this.phase = "idle";
          return { eye, done: l.arrive.clone() };
        }
        return { eye };
      }
      case "off": {
        const k = Math.min(this.t / 0.5, 1);
        const stand = l.base.clone().addScaledVector(l.n, 1.25).setY(l.groundY);
        const eye = new THREE.Vector3().lerpVectors(this.from, stand.clone().setY(l.groundY + EYE), ease(k));
        if (k >= 1) {
          this.phase = "idle";
          return { eye, done: stand };
        }
        return { eye };
      }
    }
    return null;
  }
}
