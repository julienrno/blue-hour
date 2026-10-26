import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { SoundCloudMusic } from "./soundcloud";
import { drawNowPlaying, SCREEN_H, SCREEN_W } from "./ipodScreen";

// The full-resolution model (2048 textures), only re-encoded to webp
const MODEL = "/models/opt/ipod-hq.glb";
// Model space (front face toward +x): the display window fills the upper part of the front
const FRONT_X = 0.0139;
const SCREEN = { y: 0.05455, w: 0.0792, h: 0.0653 };

// Framing, as fractions of the screen (GTA IV phone): the top edge at 65% of the height, the right edge a little in
// from the side, and the bottom of the wheel runs off the frame
const LAYOUT = { top: 0.65, right: 0.055, height: 0.48, maxWidth: 0.24 };
// A long lens for the view model alone, so the device keeps its true proportions in the corner
const VM_FOV = 18;
const DIST = 1;

const smooth = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/** A soft rounded-rectangle glow, the light the LCD spills onto the plastic around it. */
function glowTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  // Draw the rectangle far off-canvas and keep only its blurred shadow (canvas filters are not everywhere)
  ctx.shadowColor = "#fff";
  ctx.shadowBlur = 34;
  ctx.shadowOffsetX = 1000;
  ctx.fillStyle = "#fff";
  ctx.fillRect(48 - 1000, 52, 160, 152);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The iPod drawn the way shooters draw a weapon: its own scene, narrow-FOV camera and full-resolution canvas over
 * the world (the world renders at a reduced pixel ratio; the device would look pixelated in it). It is lit by the
 * nearest street lamp from where that lamp really is, lags behind turns around its middle, bobs with your stride
 * and slides up when the walk begins.
 */
export class IPodViewModel {
  private renderer?: THREE.WebGLRenderer;
  private canvas = document.createElement("canvas");
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(VM_FOV, 1, 0.5, 2);
  private pivot = new THREE.Group();
  private group = new THREE.Group();
  private fit = new THREE.Group();
  private holder = new THREE.Group();
  private lamp = new THREE.DirectionalLight("#ffd9a8", 0);
  private screenCtx: CanvasRenderingContext2D;
  private screenTex: THREE.CanvasTexture;
  private drawn = "";
  private ratio = 0.586;
  private view = { w: 1, h: 1 };
  private lastYaw = 0;
  private lastPitch = 0;
  private sway = new THREE.Vector2();
  private swayVel = new THREE.Vector2();
  private bobPhase = 0;
  private land = 0;
  private wasGrounded = true;
  private raise = 0;
  private shown = false;
  private loaded = false;
  private lampColor = new THREE.Color("#cfe2ff");
  private lightTarget = 0;
  private lightLevel = 0;
  music?: SoundCloudMusic;

  constructor() {
    const c = document.createElement("canvas");
    c.width = SCREEN_W;
    c.height = SCREEN_H;
    this.screenCtx = c.getContext("2d")!;
    this.screenTex = new THREE.CanvasTexture(c);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    this.screenTex.anisotropy = 8;
    // A backlit LCD: unlit and outside tone mapping, so it glows against the dusk instead of greying with it
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(SCREEN.w, SCREEN.h).rotateY(Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: this.screenTex, color: "#e4ecff", toneMapped: false })
    );
    screen.position.set(FRONT_X + 0.0004, SCREEN.y, 0);
    screen.renderOrder = 1;
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(SCREEN.w * 1.6, SCREEN.h * 1.68).rotateY(Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: glowTexture(),
        color: "#9fbcff",
        transparent: true,
        opacity: 0.32,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      })
    );
    glow.position.set(FRONT_X + 0.0002, SCREEN.y, 0);
    glow.renderOrder = 2;
    this.holder.add(screen, glow);
    this.holder.rotation.y = -Math.PI / 2;
    this.fit.add(this.holder);
    this.group.add(this.fit);
    this.pivot.add(this.group);
    this.pivot.visible = false;

    // Blue-hour sky from above, snow bounce from below, and the nearest lamp as the key light
    this.scene.add(new THREE.HemisphereLight("#6f86c8", "#1e2748", 0.42));
    const sky = new THREE.DirectionalLight("#90a6e2", 0.28);
    sky.position.set(-0.6, 1, 0.8);
    this.scene.add(sky, this.lamp, this.pivot);

    this.canvas.className = "ipod-vm";
    this.canvas.setAttribute("aria-hidden", "true");
  }

  /** Puts the iPod's canvas just above the world's, below the menus. */
  mount(after: HTMLCanvasElement) {
    after.insertAdjacentElement("afterend", this.canvas);
    // Decoration: the track it shows is in the SoundCloud player's title
    this.canvas.setAttribute("aria-hidden", "true");
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.1;
    this.renderer = r;
    this.resize();
  }

  async load() {
    if (!this.renderer) return;
    const gltf = await new GLTFLoader().loadAsync(MODEL);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.1;
    pmrem.dispose();
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false;
      const m = mesh.material as THREE.MeshStandardMaterial;
      m.transparent = false;
      m.opacity = 1;
      m.depthWrite = true;
      for (const tex of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.emissiveMap, m.aoMap]) if (tex) tex.anisotropy = aniso;
    });
    this.holder.add(gltf.scene);
    // Normalise: centred on its bounding box and one unit tall, so the layout can size it in screen terms
    this.pivot.position.set(0, 0, 0);
    this.pivot.rotation.set(0, 0, 0);
    this.group.position.set(0, 0, 0);
    this.group.rotation.set(0, 0, 0);
    this.group.scale.setScalar(1);
    this.pivot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    this.holder.position.sub(center);
    this.fit.scale.setScalar(1 / size.y);
    this.ratio = size.x / size.y;
    this.loaded = true;
    this.resize();
  }

  /** Slide into view (after the intro). */
  show() {
    this.shown = true;
    this.pivot.visible = true;
  }

  /**
   * How much lamp light is around you (0 in the dark between lamps, ~1 right under one). Only the amount is used,
   * eased over a couple of seconds and always from the same soft angle: tracking each lamp's real direction made
   * the iPod flick between lit and dull every few steps, out of step with what you see.
   */
  setLight(level: number, color: THREE.Color) {
    this.lightTarget = THREE.MathUtils.clamp(level, 0, 1);
    this.lampColor.lerp(color, 0.05);
  }

  /** Sized in CSS pixels from the window. */
  private sizes() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const height = Math.min(LAYOUT.height * H, (LAYOUT.maxWidth * W) / this.ratio);
    return { W, H, height, width: height * this.ratio };
  }

  /** The canvas covers only the iPod's corner; the camera renders that corner of a full-screen frustum. */
  resize() {
    if (!this.renderer) return;
    const { W, H, height, width } = this.sizes();
    // Room around the iPod for sway and bob; the bottom of the frame clips it as intended
    const pad = height * 0.14;
    const right = W * (1 - LAYOUT.right);
    const x0 = Math.max(0, Math.floor(right - width - pad));
    const y0 = Math.max(0, Math.floor(H * LAYOUT.top - pad));
    const w = Math.min(W, Math.ceil(right + pad)) - x0;
    const h = H - y0;
    Object.assign(this.canvas.style, { left: `${x0}px`, top: `${y0}px`, width: `${w}px`, height: `${h}px` });
    this.renderer.setSize(w, h, false);
    this.camera.aspect = W / H;
    this.camera.setViewOffset(W, H, x0, y0, w, h);
    this.camera.updateProjectionMatrix();
    this.view = { w: W, h: H };
  }

  update(dt: number, t: number, view: THREE.Camera, s: { speed: number; grounded: boolean }) {
    if (!this.pivot.visible) return;
    this.raise += ((this.shown ? 1 : 0) - this.raise) * smooth(3.2, dt);

    // Lag: pushed against fast turns, springing back
    const e = new THREE.Euler().setFromQuaternion(view.quaternion, "YXZ");
    let dyaw = e.y - this.lastYaw;
    if (dyaw > Math.PI) dyaw -= Math.PI * 2;
    if (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const dpitch = e.x - this.lastPitch;
    this.lastYaw = e.y;
    this.lastPitch = e.x;
    const kick = new THREE.Vector2(THREE.MathUtils.clamp(-dyaw, -0.08, 0.08), THREE.MathUtils.clamp(dpitch, -0.08, 0.08));
    this.swayVel.addScaledVector(kick, 9).addScaledVector(this.sway, -90 * dt).multiplyScalar(Math.exp(-11 * dt));
    this.sway.addScaledVector(this.swayVel, dt);

    // A dip when you land
    if (s.grounded && !this.wasGrounded) this.land = 1;
    this.wasGrounded = s.grounded;
    this.land *= Math.exp(-6 * dt);

    // Walking bob: a figure-eight in step with the stride
    const walk = s.grounded ? Math.min(s.speed / 2.4, 1.6) : 0;
    this.bobPhase += dt * (4 + s.speed * 1.6);
    const bobX = Math.sin(this.bobPhase) * walk;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * walk;
    const idle = Math.sin(t * 0.9);

    // Screen layout in the view camera's frame at DIST: one frustum half-height spans half the window
    const hh = DIST * Math.tan(THREE.MathUtils.degToRad(VM_FOV / 2));
    const toWorld = (2 * hh) / this.view.h;
    const { W, H, height: hPx, width: wPx } = this.sizes();
    const height = hPx * toWorld;
    const width = wPx * toWorld;
    const u = hh * 0.01;
    // The pivot sits in the middle of the part you can see (top edge to the bottom of the frame), so turning rocks
    // the iPod around its middle instead of letting it dangle from the top
    const right = (W * (1 - LAYOUT.right) - W / 2) * toWorld;
    const top = (H / 2 - H * LAYOUT.top) * toWorld;
    const px = right - width / 2;
    const py = (top - hh) / 2;
    const centerY = top - height / 2;
    this.pivot.position.set(
      px + bobX * 0.9 * u + this.sway.x * 8 * u,
      py + bobY * 0.8 * u + idle * 0.25 * u + this.sway.y * 10 * u - this.land * 2.2 * u - (1 - this.raise) * height * 1.1,
      -DIST
    );
    this.pivot.rotation.set(
      this.sway.y * 0.45 - (1 - this.raise) * 0.3,
      this.sway.x * 0.6,
      -this.sway.x * 0.35 + bobX * 0.006,
      "YXZ"
    );
    // Within the pivot: the iPod's own resting tilt, a few degrees toward the middle of the screen
    this.group.position.set(0, centerY - py, 0);
    this.group.rotation.set(0.04, -0.16, 0.025, "YXZ");
    this.group.scale.setScalar(height);

    // Lamp light: a soft key from above and slightly in front, following how lit the street around you is
    this.lightLevel += (this.lightTarget - this.lightLevel) * smooth(0.8, dt);
    this.lamp.position.set(-0.3, 1, 0.5);
    this.lamp.color.copy(this.lampColor);
    this.lamp.intensity = 0.25 + 0.75 * this.lightLevel;

    this.updateScreen();
  }

  render() {
    if (!this.renderer || !this.loaded) return;
    this.canvas.style.visibility = this.pivot.visible ? "visible" : "hidden";
    if (this.pivot.visible) this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer?.dispose();
    this.canvas.remove();
  }

  private updateScreen() {
    if (!this.music) return;
    const now = this.music.state;
    const sig = `${now.title}|${now.artist}|${now.artwork}|${Math.floor(now.position / 1000)}|${now.duration}|${now.playing}|${now.index}`;
    if (sig === this.drawn) return;
    this.drawn = sig;
    drawNowPlaying(this.screenCtx, now, () => (this.drawn = ""));
    this.screenTex.needsUpdate = true;
  }
}
