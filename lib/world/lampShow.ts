import * as THREE from "three";
import type { LightSource } from "./city";

const BULB_INTENSITY = 14;

const hash = (n: number) => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * Street lamp power over time. On entering, the lamps switch on one by one from where you stand outward, each with
 * the stutter of an old sodium fitting before it warms up to full. One lamp near the start is failing for good and
 * keeps stuttering every few seconds. Power scales the bulb, the spot light, the fog glow and the lit snow.
 */
export class LampShow {
  private delay = new Map<LightSource, number>();
  private stutters = new Set<LightSource>();
  private clicked = new Set<LightSource>();
  private start = Infinity;
  failing?: LightSource;
  onSwitch?: (lamp: LightSource) => void;

  constructor(private lamps: LightSource[], origin: THREE.Vector3) {
    lamps.forEach((l, i) => {
      if (hash(i + 3.7) < 0.55) this.stutters.add(l);
      l.power = 0;
    });
    // The failing lamp: the street lamp closest to a point a little way down the street from the start
    const spot = origin.clone().add(new THREE.Vector3(0, 0, -38));
    this.failing = [...lamps].sort((a, b) => a.position.distanceToSquared(spot) - b.position.distanceToSquared(spot))[0];
  }

  /** Begin the switch-on wave from `origin`; `at` is the clock time it starts. */
  begin(origin: THREE.Vector3, at: number) {
    this.start = at;
    this.lamps.forEach((l, i) => {
      const d = Math.hypot(l.position.x - origin.x, l.position.z - origin.z);
      this.delay.set(l, 0.9 + d * 0.032 + hash(i + 9.1) * 0.25);
    });
  }

  /** Everything on at once (debug views). */
  allOn() {
    this.start = -1e6;
    this.lamps.forEach((l) => this.delay.set(l, 0));
  }

  update(t: number) {
    for (const l of this.lamps) {
      const local = t - this.start - (this.delay.get(l) ?? 0);
      let p = this.warmup(local, this.stutters.has(l));
      if (l === this.failing && local > 3) p *= this.failure(t);
      l.power = p;
      if (local >= 0 && !this.clicked.has(l)) {
        this.clicked.add(l);
        this.onSwitch?.(l);
      }
      const mat = l.bulb?.material as THREE.MeshStandardMaterial | undefined;
      if (mat) mat.emissiveIntensity = BULB_INTENSITY * Math.max(p, 0.02);
    }
  }

  private warmup(local: number, stutter: boolean) {
    if (local < 0) return 0;
    if (stutter) {
      if (local < 0.05) return 0.8;
      if (local < 0.12) return 0;
      if (local < 0.17) return 0.6;
      if (local < 0.3) return 0.05;
    }
    // Old sodium lamps come on dim and warm up over a second or so
    return 0.3 + 0.7 * THREE.MathUtils.smoothstep(local, stutter ? 0.3 : 0, 1.6);
  }

  /** Mostly steady, then every ~9 s a short burst of stuttering. */
  private failure(t: number) {
    const cycle = t % 9.3;
    if (cycle > 1.1) return 1;
    const step = Math.floor(t * 14);
    return hash(step) < 0.45 ? 0.08 : 0.85;
  }
}
