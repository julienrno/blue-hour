import * as THREE from "three";
import type { Collider } from "./city";
import { meshHeight } from "./footprints";
import { POND, pondDistance } from "./noise";
import { radialTexture, snowSplatMaps } from "./textures";

const MAX_BALLS = 12;
const MAX_SPLATS = 48;
const BURST = 18;
const SPEED = 17;
const GRAVITY = 9.8;
const LIFE = 6;
// Splats are slowly covered by the falling snow
const SPLAT_FADE_START = 45;
const SPLAT_FADE_END = 90;

type Ball = { mesh: THREE.Mesh; vel: THREE.Vector3; age: number; live: boolean };
// `thin`: a pole or trunk, too narrow for a flat splat to sit on, so it only bursts
type Hit = { point: THREE.Vector3; normal: THREE.Vector3; hard: boolean; thin?: boolean };

/** Ground under a point: the snow mesh, or the ice on the pond. */
function surface(x: number, z: number) {
  const h = meshHeight(x, z);
  return pondDistance(x, z) < 1.1 ? Math.max(h, POND.ice) : h;
}

/** Colliders are footprints; give each a height: car decks carry their own, thin posts and trunks are tall, kiosks low. */
function heightOf(c: Collider) {
  if (c.top !== undefined) return c.top;
  if (c.height !== undefined) return c.height;
  const size = Math.max(c.maxX - c.minX, c.maxZ - c.minZ);
  if (size < 1) return 7;
  if (size < 6) return 3;
  return 60;
}

/**
 * Throwing snowballs: each ball flies on a ballistic arc, bursts into a puff of snow on whatever it hits
 * (ground, ice, walls, cars, poles) and leaves a white splat stuck to that surface, which the snowfall slowly covers.
 */
export class Snowballs {
  group = new THREE.Group();
  onSplat?: (point: THREE.Vector3, hard: boolean) => void;
  /** A splat just stuck at `point`: something that moves (a sliding door) can take it along with `attach`. */
  onStick?: (mesh: THREE.Object3D, point: THREE.Vector3) => void;
  private balls: Ball[] = [];
  private splats: { mesh: THREE.Mesh; born: number; base: number }[] = [];
  private nextSplat = 0;
  private burst: THREE.Points;
  private burstVel: THREE.Vector3[] = [];
  private burstAge: number[] = [];
  private nextBurst = 0;
  private t = 0;

  private ray = new THREE.Raycaster();
  private m = new THREE.Matrix4();

  /** `solids` are the real meshes (buildings, cars) that balls should hit instead of their boxes. */
  constructor(
    private colliders: () => Collider[],
    private solids: () => THREE.Object3D[]
  ) {
    const snow = new THREE.MeshStandardMaterial({ color: "#eef3ff", roughness: 0.9 });
    const ballGeo = new THREE.IcosahedronGeometry(0.065, 2);
    for (let i = 0; i < MAX_BALLS; i++) {
      const mesh = new THREE.Mesh(ballGeo, snow);
      mesh.visible = false;
      mesh.castShadow = false;
      this.group.add(mesh);
      this.balls.push({ mesh, vel: new THREE.Vector3(), age: 0, live: false });
    }

    const maps = snowSplatMaps();
    const splatGeo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < MAX_SPLATS; i++) {
      const mat = new THREE.MeshStandardMaterial({
        map: maps.map,
        normalMap: maps.normalMap,
        normalScale: new THREE.Vector2(1, 1),
        roughness: 1,
        // Snow on a wall still catches the light bouncing up off the snowy ground
        emissive: "#5d6d96",
        emissiveIntensity: 0.45,
        emissiveMap: maps.map,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
      });
      const mesh = new THREE.Mesh(splatGeo, mat);
      mesh.visible = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.splats.push({ mesh, born: -1e6, base: 1 });
    }

    const n = BURST * 6;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3).fill(-9999), 3));
    for (let i = 0; i < n; i++) {
      this.burstVel.push(new THREE.Vector3());
      this.burstAge.push(99);
    }
    this.burst = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ map: radialTexture(), color: "#e8eeff", size: 0.05, transparent: true, depthWrite: false, opacity: 0.9 })
    );
    this.burst.frustumCulled = false;
    this.group.add(this.burst);
    this.group.userData.noCull = true;
  }

  /** Throw from the camera toward where it looks, carrying the thrower's own speed; `power` 0-1 from holding. */
  throw(camera: THREE.Camera, carry: THREE.Vector3, power = 0) {
    const ball = this.balls.find((b) => !b.live) ?? this.balls.reduce((a, b) => (a.age > b.age ? a : b));
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
    // Leaves straight below the centre of view, so the arc stays in line with the dot and simply drops
    ball.mesh.position.copy(camera.position).addScaledVector(fwd, 0.35).add(new THREE.Vector3(0, -0.12, 0));
    // A full charge throws about 1.8x harder with a higher arc: roughly three times the reach
    ball.vel.copy(fwd).multiplyScalar(SPEED * (1 + 0.8 * power)).add(new THREE.Vector3(0, 1.2 + 1.6 * power, 0)).addScaledVector(carry, 0.6);
    ball.age = 0;
    ball.live = true;
    ball.mesh.visible = true;
  }

  update(dt: number, t: number) {
    this.t = t;
    for (const b of this.balls) {
      if (!b.live) continue;
      b.age += dt;
      // Two substeps keep fast balls from skipping through thin poles
      for (let s = 0; s < 2 && b.live; s++) {
        const h = dt / 2;
        const prev = b.mesh.position.clone();
        b.vel.y -= GRAVITY * h;
        b.mesh.position.addScaledVector(b.vel, h);
        const hit = this.collide(prev, b.mesh.position);
        if (hit) {
          this.splat(hit, b.vel);
          b.live = false;
          b.mesh.visible = false;
        }
      }
      if (b.age > LIFE) {
        b.live = false;
        b.mesh.visible = false;
      }
    }

    for (const s of this.splats) {
      if (!s.mesh.visible) continue;
      const fade = THREE.MathUtils.smoothstep(t - s.born, SPLAT_FADE_START, SPLAT_FADE_END);
      (s.mesh.material as THREE.MeshStandardMaterial).opacity = s.base * (1 - fade);
      if (fade >= 1) s.mesh.visible = false;
    }

    const pos = this.burst.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < this.burstAge.length; i++) {
      if (this.burstAge[i] > 0.9) continue;
      this.burstAge[i] += dt;
      const v = this.burstVel[i];
      v.y -= GRAVITY * 0.6 * dt;
      v.multiplyScalar(Math.exp(-2.5 * dt));
      pos.setXYZ(i, pos.getX(i) + v.x * dt, pos.getY(i) + v.y * dt, pos.getZ(i) + v.z * dt);
      if (this.burstAge[i] > 0.9) pos.setXYZ(i, 0, -9999, 0);
    }
    pos.needsUpdate = true;
  }

  private collide(from: THREE.Vector3, to: THREE.Vector3): Hit | null {
    const ground = surface(to.x, to.z);
    if (to.y <= ground) {
      const point = to.clone().setY(ground);
      return { point, normal: new THREE.Vector3(0, 1, 0), hard: pondDistance(to.x, to.z) < 1 };
    }
    let nearSolid = false;
    for (const c of this.colliders()) {
      // Buildings and cars have real meshes: their boxes only say "look closer"
      const meshed = c.top !== undefined || heightOf(c) >= 60;
      const pad = meshed ? 0.8 : 0;
      if (to.x < c.minX - pad || to.x > c.maxX + pad || to.z < c.minZ - pad || to.z > c.maxZ + pad) continue;
      const top = heightOf(c);
      if (to.y > top + pad) continue;
      if (meshed) {
        nearSolid = true;
        continue;
      }
      // Lamp posts and tree trunks are round: hit a vertical cylinder inside the box, not the box itself
      const w = Math.max(c.maxX - c.minX, c.maxZ - c.minZ);
      if (w < 1) {
        const cx = (c.minX + c.maxX) / 2;
        const cz = (c.minZ + c.maxZ) / 2;
        const radius = w * 0.25;
        const dx = to.x - cx;
        const dz = to.z - cz;
        const d = Math.hypot(dx, dz);
        if (d > radius) continue;
        const normal = new THREE.Vector3(dx, 0, dz).divideScalar(Math.max(d, 1e-4));
        return { point: new THREE.Vector3(cx, to.y, cz).addScaledVector(normal, radius), normal, hard: true, thin: true };
      }
      // Kiosks: the box is close enough
      if (from.y > top) return { point: to.clone().setY(top), normal: new THREE.Vector3(0, 1, 0), hard: true };
      const point = to.clone();
      const normal = new THREE.Vector3();
      if (from.x < c.minX) (point.x = c.minX), normal.set(-1, 0, 0);
      else if (from.x > c.maxX) (point.x = c.maxX), normal.set(1, 0, 0);
      else if (from.z < c.minZ) (point.z = c.minZ), normal.set(0, 0, -1);
      else if (from.z > c.maxZ) (point.z = c.maxZ), normal.set(0, 0, 1);
      else normal.set(0, 1, 0);
      return { point, normal, hard: true };
    }
    return nearSolid ? this.raycastSolids(from, to) : null;
  }

  /** Hit test against the actual building and car geometry along this step. */
  private raycastSolids(from: THREE.Vector3, to: THREE.Vector3): Hit | null {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 1e-5) return null;
    dir.divideScalar(len);
    this.ray.set(from, dir);
    this.ray.far = len + 0.07;
    const hit = this.ray.intersectObjects(this.solids(), true).find((h) => h.face && h.object.visible);
    if (!hit || !hit.face) return null;
    const obj = hit.object as THREE.InstancedMesh;
    if (obj.isInstancedMesh && hit.instanceId !== undefined) {
      obj.getMatrixAt(hit.instanceId, this.m);
      this.m.premultiply(obj.matrixWorld);
    } else this.m.copy(hit.object.matrixWorld);
    const normal = hit.face.normal.clone().transformDirection(this.m);
    if (normal.dot(dir) > 0) normal.negate();
    return { point: hit.point.clone(), normal, hard: true };
  }

  private splat(hit: Hit, vel: THREE.Vector3) {
    if (hit.thin) {
      this.puff(hit, vel);
      return;
    }
    const s = this.splats[this.nextSplat];
    this.nextSplat = (this.nextSplat + 1) % MAX_SPLATS;
    const m = s.mesh;
    // A pooled splat may have been riding on a door: bring it back into the world first
    if (m.parent !== this.group) this.group.add(m);
    m.position.copy(hit.point).addScaledVector(hit.normal, 0.012);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal);
    m.rotateZ(Math.random() * Math.PI * 2);
    // Stretched a little along the direction of travel on the surface, bigger when it hit fast
    const size = 0.36 + Math.min(vel.length() / SPEED, 1.2) * 0.14 + Math.random() * 0.08;
    m.scale.set(size * (1 + Math.random() * 0.25), size, 1);
    // On snow a splat is mostly relief; on walls and cars it stands out as packed white
    s.base = hit.normal.y > 0.9 && !hit.hard ? 0.8 : 1;
    (m.material as THREE.MeshStandardMaterial).opacity = s.base;
    m.visible = true;
    s.born = this.t;
    this.onStick?.(m, hit.point);

    this.puff(hit, vel);
  }

  /** The burst of loose snow flying off the impact, plus its sound. */
  private puff(hit: Hit, vel: THREE.Vector3) {
    const pos = this.burst.geometry.getAttribute("position") as THREE.BufferAttribute;
    const reflect = vel.clone().normalize().reflect(hit.normal);
    for (let k = 0; k < BURST; k++) {
      const i = this.nextBurst;
      this.nextBurst = (this.nextBurst + 1) % this.burstAge.length;
      const spray = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2);
      this.burstVel[i]
        .copy(hit.normal)
        .multiplyScalar(1.2 + Math.random() * 1.5)
        .addScaledVector(reflect, 0.8)
        .add(spray);
      this.burstAge[i] = 0;
      pos.setXYZ(i, hit.point.x + hit.normal.x * 0.05, hit.point.y + hit.normal.y * 0.05, hit.point.z + hit.normal.z * 0.05);
    }
    pos.needsUpdate = true;
    this.onSplat?.(hit.point, hit.hard);
  }
}
