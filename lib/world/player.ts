import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { BOUNDS, type Collider } from "./city";

const EYE = 1.68;
const RADIUS = 0.45;
// Going up a jump feels the same as ever; coming down is slower and floaty, so a drop off a roof is a long glide
// down through the snow rather than a plunge
const GRAVITY = 11;
const GRAVITY_FALLING = 5.2;
const TERMINAL = 15;
// About 0.88 m of clearance: enough to land on a bonnet from the road
const JUMP_V = 4.4;
// Ledges up to this height can be stepped onto; anything with a top lower than the feet plus this is walkable
const STEP = 0.3;
// In the air you can pull yourself onto a ledge a little higher than you could step
const AIR_STEP = 0.45;

export class Player {
  controls: PointerLockControls;
  enabled = false;
  private keys = new Set<string>();
  private velocity = new THREE.Vector3();
  private bob = 0;
  private lastStepSign = 1;
  private feet = NaN;
  private vy = 0;
  private grounded = true;
  private dip = 0;
  private dipAge = 0;
  /** How fast you hit the ground last time (m/s), for the camera to shake with. */
  impact = 0;
  /** Falling speed right now (m/s, 0 on the ground). */
  get fallSpeed() {
    return this.grounded ? 0 : Math.max(0, -this.vy);
  }
  /** How far below the feet the ground is while in the air (m, 0 on the ground): a hop or a roof edge. */
  drop = 0;
  /** Set for one update when a jump starts. */
  jumped = false;
  inputActive = false;
  running = false;
  get airborne() {
    return !this.grounded;
  }
  onStep?: (intensity: number, landed?: boolean) => void;
  get feetY() {
    return this.feet;
  }
  /** Current horizontal velocity (m/s). */
  get motion() {
    return this.velocity;
  }

  constructor(
    private camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
    public colliders: Collider[],
    private heightAt: (x: number, z: number) => number
  ) {
    this.controls = new PointerLockControls(camera, dom);
    this.controls.pointerSpeed = 0.6;
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);
    window.addEventListener("blur", this.clearKeys);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.type === "keydown" && e.code === "Space" && !e.repeat && this.enabled && this.grounded) {
      this.vy = JUMP_V;
      this.grounded = false;
      this.jumped = true;
    }
    if (e.type === "keydown") this.keys.add(e.code);
    else this.keys.delete(e.code);
  };

  private clearKeys = () => this.keys.clear();

  /** Puts you down here, standing still (after a climb, or getting up from a bench). */
  place(x: number, feet: number, z: number) {
    this.camera.position.set(x, feet + EYE, z);
    this.feet = feet;
    this.vy = 0;
    this.grounded = true;
    this.drop = 0;
    this.velocity.set(0, 0, 0);
  }

  /** Up / down on a ladder: the forward and back keys (by position, so Z/S on AZERTY), -1..1. */
  get climbInput() {
    const k = this.keys;
    return (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
  }

  get shiftHeld() {
    return this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
  }

  /** Whether any movement key is held. */
  get wantsToMove() {
    return ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].some((k) => this.keys.has(k));
  }

  update(dt: number, time: number) {
    const k = this.keys;
    const input = new THREE.Vector2(
      (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0),
      (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0)
    );
    if (!this.enabled) input.set(0, 0);
    this.inputActive = input.lengthSq() > 0;
    if (input.lengthSq() > 1) input.normalize();

    this.running = k.has("ShiftLeft") || k.has("ShiftRight");
    const speed = this.running ? 5.4 : 2.4;
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const target = forward.multiplyScalar(input.y * speed).add(right.multiplyScalar(input.x * speed));
    // Less control in the air, so a jump carries its momentum
    this.velocity.lerp(target, 1 - Math.exp(-dt * (this.grounded ? 3 : 0.6)));

    const pos = this.camera.position;
    if (Number.isNaN(this.feet)) this.feet = this.heightAt(pos.x, pos.z);
    pos.x += this.velocity.x * dt;
    pos.z += this.velocity.z * dt;
    this.collide(pos);

    // Feet rest on the terrain or on anything with a top (car roofs and bonnets) they are above
    const support = this.supportAt(pos.x, pos.z);
    if (this.grounded) {
      if (support < this.feet - 0.25) {
        this.grounded = false;
        this.vy = 0;
      } else this.feet += (support - this.feet) * (1 - Math.exp(-dt * 12));
    }
    if (!this.grounded) {
      this.vy -= (this.vy > 0 ? GRAVITY : GRAVITY_FALLING) * dt;
      this.vy = Math.max(this.vy, -TERMINAL);
      this.feet += this.vy * dt;
      if (this.vy <= 0 && this.feet <= support) {
        this.onStep?.(Math.min(1, -this.vy / 4), true);
        this.impact = -this.vy;
        // The knees take it: a dip as deep as the landing was hard
        this.dip = Math.min(0.5, Math.max(0, -this.vy - 2) * 0.04);
        this.dipAge = 0;
        this.feet = Math.max(this.feet, support - 0.12);
        this.vy = 0;
        this.grounded = true;
      }
    }
    this.drop = this.grounded ? 0 : Math.max(0, this.feet - support);
    this.dip *= Math.exp(-dt * 5);
    const moving = this.velocity.length();
    this.bob += dt * moving * 2.4;
    const amp = Math.min(moving / 2, 1.3);
    const s = Math.sin(this.bob * 2);
    const grounded = this.grounded;
    pos.y = this.feet + EYE + (grounded ? s * 0.03 * amp : 0) + Math.sin(time * 0.5) * 0.006 - this.dip * Math.min(1, this.dipAge++ / 3);

    const sign = Math.sign(s);
    if (grounded && sign < 0 && this.lastStepSign >= 0 && moving > 0.4) this.onStep?.(Math.min(moving / 3, 1));
    this.lastStepSign = sign;
  }

  private get reach() {
    return this.grounded ? STEP : AIR_STEP;
  }

  private supportAt(x: number, z: number) {
    let y = this.heightAt(x, z);
    for (const c of this.colliders) {
      if (c.top === undefined || c.top < y || this.feet < c.top - this.reach) continue;
      if (x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ) y = c.top;
    }
    return y;
  }

  private collide(p: THREE.Vector3) {
    for (const c of this.colliders) {
      if (c.top !== undefined && this.feet >= c.top - this.reach) continue;
      if (c.bottom !== undefined && this.feet + 1.8 < c.bottom) continue;
      const cx = THREE.MathUtils.clamp(p.x, c.minX, c.maxX);
      const cz = THREE.MathUtils.clamp(p.z, c.minZ, c.maxZ);
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= RADIUS * RADIUS) continue;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * RADIUS;
        p.z = cz + (dz / d) * RADIUS;
      } else {
        const pushes = [p.x - c.minX, c.maxX - p.x, p.z - c.minZ, c.maxZ - p.z];
        const i = pushes.indexOf(Math.min(...pushes));
        if (i === 0) p.x = c.minX - RADIUS;
        if (i === 1) p.x = c.maxX + RADIUS;
        if (i === 2) p.z = c.minZ - RADIUS;
        if (i === 3) p.z = c.maxZ + RADIUS;
      }
    }
    p.x = THREE.MathUtils.clamp(p.x, BOUNDS.minX, BOUNDS.maxX);
    p.z = THREE.MathUtils.clamp(p.z, BOUNDS.minZ, BOUNDS.maxZ);
  }

  dispose() {
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKey);
    window.removeEventListener("blur", this.clearKeys);
    this.controls.dispose();
  }
}
