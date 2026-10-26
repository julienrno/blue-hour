import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import gsap from "gsap";
import { BOUNDS, buildCity, type BuildingSet, type LightSource } from "./city";
import { loadModels } from "./models";
import { preloadAssets, releaseAssets } from "./preload";
import { buildAntenna, type Antenna } from "./antenna";
import { createSky, createSnowfall, OVERLAY_LAYER, SNOW_LIGHTS } from "./snow";
import { createFogMaterial, FOG_LIGHTS, FOG_SETTINGS } from "./fog";
import { createPost } from "./post";
import { Focus } from "./cinematic";
import { WIND, windUniforms } from "./wind";
import { Player } from "./player";
import { Soundscape } from "./audio";
import type { SoundCloudMusic } from "./soundcloud";
import { groundHeight, POND, pondDistance, terrainHeight } from "./noise";
import { LampShow } from "./lampShow";
import { Footprints } from "./footprints";
import { interiorUniforms, knockOnRoom } from "./interiors";
import { Snowballs } from "./snowballs";
import { IPodViewModel } from "./ipod";
import { ShopView, type Venue } from "./shop";
import { StationView } from "./station";
import { buildPark, type Seat } from "./park";
import { CarAlarms } from "./alarms";
import { Rooftop } from "./rooftop";

const START = new THREE.Vector3(0, 1.68, 66);
const SPOTS = 6;
const SHADOW_SPOTS = 3;
const FPS = 60;
const INTRO_FOV = 70;
// How much thicker the volumetric fog is before the click
const INTRO_FOG = 2.2;
// Past this distance the fog has swallowed everything, so meshes are skipped entirely
const CULL_DISTANCE = 170;

export type ExperienceEvents = {
  onLockChange?: (locked: boolean) => void;
  /** 0-1 while a throw is being charged, -1 when released. */
  onCharge?: (level: number) => void;
  /** What E does here (e.g. "go in"), shown under the crosshair beside an E key, or null to hide it. */
  onPrompt?: (text: string | null) => void;
  /** Sound switched off or back on (m, or the control on screen). */
  onMuteChange?: (muted: boolean) => void;
  /** The intro's mist is three-quarters clear: time for the map, the instructions, the player and the iPod. */
  onUiIn?: () => void;
  /** Loading: 0-1 and a line about what is being built right now (1 once the city is ready to walk into). */
  onLoad?: (progress: number, line: string) => void;
};

// How long the intro's mist takes to clear (s)
const INTRO_MIST = 4.2;
// Seconds of camera movement smeared into each frame's motion blur
const EXPOSURE = 0.03;

export class Experience {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  sound?: Soundscape;
  /** The visible SoundCloud player, handed over by the page before start(). */
  music?: SoundCloudMusic;
  private post: ReturnType<typeof createPost>;
  private snow: ReturnType<typeof createSnowfall>;
  private lamps: LightSource[] = [];
  private others: LightSource[] = [];
  private spots: THREE.SpotLight[] = [];
  private player!: Player;
  private city!: ReturnType<typeof buildCity>;
  private mode: BuildingSet = "proc";
  ready: Promise<void>;
  private timer = new THREE.Timer();
  private raf = 0;
  private started = false;
  private walking = false;
  private frame = 0;
  private lastFrame = 0;
  private spotLamp: (LightSource | undefined)[] = [];
  private cullables: { obj: THREE.Object3D; center: THREE.Vector3; radius: number }[] = [];
  private sceneRT!: THREE.WebGLRenderTarget;
  private overlayRT!: THREE.WebGLRenderTarget;
  private fogRT!: THREE.WebGLRenderTarget;
  private fogMat = createFogMaterial();
  private fogQuad: FullScreenQuad;
  private focus = new Focus();
  private prevViewProj = new THREE.Matrix4();
  private frameTime = 1 / 60;
  private hasPrev = false;
  private lampShow!: LampShow;
  private prints = new Footprints();
  private snowballs!: Snowballs;
  private lastThrow = -1;
  private chargeStart = -1;
  private ipod = new IPodViewModel();
  private venues: Venue[] = [];
  private venueInside = (p: THREE.Vector3) => this.venues.some((v) => v.isInside(p));
  private prompt: string | null = null;
  private alarms!: CarAlarms;
  private rooftop!: Rooftop;
  /** The bench you are sitting on, and how far the settle into it has got (0-1). */
  private seat: { seat: Seat; k: number; from: THREE.Vector3; fromQ: THREE.Quaternion; toQ: THREE.Quaternion } | null = null;
  private rising: { from: THREE.Vector3; to: THREE.Vector3; k: number } | null = null;
  private shake = new THREE.Vector3();
  private quake = 0;
  private antenna?: Antenna;
  // 0..1 while dropping off something high: shakes the camera and streaks the picture for the whole fall
  private falling = 0;
  private rush = 0;
  private streak = 0;
  // The head roll laid on this frame (taken off again before anything moves the camera), and whether the fall has
  // the field of view (so the intro's own zoom is left alone)
  private roll = 0;
  private widened = false;

  constructor(private canvas: HTMLCanvasElement, private events: ExperienceEvents = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;

    // A near plane at 20 cm (you never get closer than the body radius to anything) keeps far more depth precision
    // for surfaces that sit almost on top of each other
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.2, 1200);
    this.camera.position.copy(START);
    this.camera.layers.enable(OVERLAY_LAYER);

    this.scene.add(createSky());
    this.scene.add(new THREE.HemisphereLight("#5873c8", "#1a2246", 1.1));
    const moon = new THREE.DirectionalLight("#6f8be0", 0.35);
    moon.position.set(-40, 80, 30);
    this.scene.add(moon);

    for (let i = 0; i < SPOTS; i++) {
      const s = new THREE.SpotLight("#9fd8ff", 0, 34, 1.15, 0.75, 1.6);
      s.castShadow = i < SHADOW_SPOTS;
      // The scene is static, so a shadow map is only redrawn when its spot moves to another lamp
      s.shadow.autoUpdate = false;
      s.shadow.mapSize.set(1024, 1024);
      s.shadow.bias = -0.0004;
      s.shadow.normalBias = 0.04;
      s.shadow.radius = 4;
      s.shadow.camera.near = 0.5;
      s.shadow.camera.far = 34;
      this.scene.add(s, s.target);
      this.spots.push(s);
    }

    this.snow = createSnowfall();
    this.scene.add(this.snow.group);

    this.fogQuad = new FullScreenQuad(this.fogMat);
    this.post = createPost(this.renderer);
    this.allocateTargets();
    this.ready = this.init();
  }

  /**
   * Tells the loading screen how far along we are, then lets the counter catch up before the next step (they block
   * the page while they run, so the number would otherwise sit behind the line it belongs to).
   */
  private async stage(progress: number, line: string) {
    this.events.onLoad?.(progress, line);
    await new Promise((r) => setTimeout(r, 380));
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  }

  private async init() {
    // Downloads are most of the wait; the rest is building, measuring and warming up the GPU
    await preloadAssets((f, line) => this.events.onLoad?.(f * 0.72, line));
    await this.stage(0.74, "laying the street and the snow on it");
    const models = await loadModels();
    this.scene.add(this.camera);
    this.city = buildCity(this.scene, models);
    if (models.antenna) {
      this.antenna = buildAntenna(models.antenna, groundHeight);
      this.scene.add(this.antenna.group);
      this.city.colliders.push(...this.antenna.colliders);
      this.city.lights.push(...this.antenna.lights);
    }
    this.lamps = this.city.lights.filter((l) => l.lamp);
    this.collectCullables();

    this.player = new Player(this.camera, document.body, [], groundHeight);
    this.player.onStep = (i, landed) => {
      this.sound?.step(i);
      this.leavePrint(landed);
    };
    this.scene.add(this.prints.mesh);
    this.snowballs = new Snowballs(
      () => this.player.colliders,
      () => [this.city.groups[this.mode], ...this.city.carMeshes, ...(this.antenna ? [this.antenna.group] : [])]
    );
    this.snowballs.onStick = (mesh, point) => this.venues.forEach((v) => v.stick(mesh, point));
    this.snowballs.onSplat = (point, hard) => this.sound?.splatSound(point.distanceTo(this.camera.position), hard);
    this.alarms = new CarAlarms(this.city.cars, () => this.city.carMeshes);
    this.scene.add(this.alarms.group);
    this.snowballs.onHit = (point, object) => this.onSnowballHit(point, object);
    this.rooftop = new Rooftop();
    this.rooftop.onRung = () => this.sound?.rung();
    if (this.antenna) this.rooftop.addFixed(this.antenna.ladder);
    this.scene.add(this.rooftop.group);
    this.scene.add(this.snowballs.group);
    await this.stage(0.8, "furnishing the shop, the petrol station and the park");
    this.venues = [new ShopView(this.city.shop, groundHeight), new StationView(this.city.station, groundHeight)];
    for (const v of this.venues) this.scene.add(v.group);
    this.ipod.mount(this.canvas);
    await Promise.allSettled([
      buildPark(this.city.park).then((g) => this.scene.add(g)),
      ...this.venues.map((v) => v.load(this.renderer)),
      this.ipod.load(),
    ]);

    this.lampShow = new LampShow(this.lamps, START);
    this.lampShow.onSwitch = (l) => {
      const d = l.position.distanceTo(this.camera.position);
      if (d < 70) this.sound?.lampOn(d);
    };
    this.player.controls.addEventListener("lock", () => {
      this.player.enabled = true;
      this.sound?.duck(false);
      this.events.onLockChange?.(true);
    });
    this.player.controls.addEventListener("unlock", () => {
      this.player.enabled = false;
      this.sound?.duck(true);
      this.events.onLockChange?.(false);
    });

    await this.stage(0.88, "measuring every roof for a ladder");
    // The panel-block model, or the generated blocks if it failed to load
    this.setBuildings(this.city.buildingSets.includes("building1") ? "building1" : "proc");
    releaseAssets();
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKey);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    this.applyDebugView();
    // Every material compiled before the first frame, so the walk does not stutter the first time you turn around
    await this.stage(0.94, "teaching the fog how to hold the light");
    await this.renderer.compileAsync(this.scene, this.camera).catch(() => undefined);
    this.events.onLoad?.(1, "the lamps are coming on");
    this.loop();
  }

  private collectCullables() {
    this.scene.updateMatrixWorld(true);
    const s = new THREE.Vector3();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || o.userData.noCull) return;
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === this.camera) return;
      let sphere: THREE.Sphere | null;
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
        sphere = (mesh as THREE.InstancedMesh).boundingSphere;
      } else {
        mesh.geometry.computeBoundingSphere();
        sphere = mesh.geometry.boundingSphere;
      }
      if (!sphere) return;
      mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
      const radius = sphere.radius * Math.max(s.x, s.y, s.z);
      if (radius > 120) return;
      this.cullables.push({ obj: mesh, center: sphere.center.clone().applyMatrix4(mesh.matrixWorld), radius });
    });
  }

  private cull() {
    const p = this.camera.position;
    // The fog thins with height: up on a roof or the mast you see much further, so things keep further away too
    const reach = CULL_DISTANCE + Math.max(0, p.y - 12) * 4.5;
    for (const c of this.cullables) c.obj.visible = p.distanceTo(c.center) - c.radius < reach;
  }

  /** Top-down data for the minimap: footprints of the visible buildings, the road and the park trail. */
  mapData() {
    if (!this.city) return null;
    return { buildings: this.city.buildingColliders[this.mode], venues: [this.city.shop.bounds], station: this.city.station.map, antenna: this.antenna?.footprint, trail: this.city.trail.map((p) => ({ x: p.x, z: p.y })), bounds: BOUNDS, pond: POND };
  }

  /** Player position and heading (radians, 0 = facing -z). */
  pose() {
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    return { x: this.camera.position.x, z: this.camera.position.z, heading: Math.atan2(f.x, -f.z) };
  }

  private setBuildings(mode: BuildingSet) {
    this.mode = mode;
    for (const [set, group] of Object.entries(this.city.groups)) group.visible = set === mode;
    // Every block with a fire ladder trades its solid box for a walkable roof and whatever stands up out of it
    this.rooftop.place(this.city.groups[mode], this.city.buildingColliders[mode], groundHeight);
    const swap = this.rooftop.colliders;
    const blocks = this.city.buildingColliders[mode].filter((c) => !swap.remove.includes(c));
    this.player.colliders = [...this.city.colliders, ...blocks, ...swap.add];
    this.others = this.city.lights.filter((l) => !l.lamp && (!l.set || l.set === mode));
    this.spots.forEach((s) => (s.shadow.needsUpdate = true));
  }


  private allocateTargets() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    for (const rt of [this.sceneRT, this.overlayRT, this.fogRT]) rt?.dispose();
    // One depth texture shared by both targets so the snow overlay is occluded by the world
    const depth = new THREE.DepthTexture(size.x, size.y);
    depth.type = THREE.FloatType;
    const opts = { type: THREE.HalfFloatType, depthBuffer: true };
    this.sceneRT = new THREE.WebGLRenderTarget(size.x, size.y, { ...opts, depthTexture: depth });
    this.overlayRT = new THREE.WebGLRenderTarget(size.x, size.y, { ...opts, depthTexture: depth });
    this.fogRT = new THREE.WebGLRenderTarget(Math.ceil(size.x / 2), Math.ceil(size.y / 2), { type: THREE.HalfFloatType, depthBuffer: false });
    this.fogMat.uniforms.tDepth.value = depth;
    const c = this.post.composite.material.uniforms;
    c.tScene.value = this.sceneRT.texture;
    c.tOverlay.value = this.overlayRT.texture;
    c.tFog.value = this.fogRT.texture;
    c.tDepth.value = depth;
    c.uFogSize.value.set(this.fogRT.width, this.fogRT.height);
    c.uNear.value = this.camera.near;
    c.uFar.value = this.camera.far;
    this.snow.uniforms.uViewport.value = window.innerHeight / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.snow.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    const cu = this.post.cinematic.uniforms;
    cu.tDepth.value = depth;
    cu.uTexel.value.set(1 / size.x, 1 / size.y);
    // Blur radii are tuned in CSS pixels; scale them to the drawing buffer
    cu.uAperture.value = 5.0 * this.renderer.getPixelRatio();
    cu.uMaxCoc.value = 8.0 * this.renderer.getPixelRatio();
  }

  private applyDebugView() {
    (window as unknown as { __bh: Experience }).__bh = this;
    const cam = new URLSearchParams(window.location.search).get("cam");
    if (!cam) {
      // The scene waits at street level inside a cloud; clicking lets the mist thin and the fog settle
      const p = START.clone().setY(START.y + groundHeight(START.x, START.z));
      this.camera.position.copy(p);
      this.camera.lookAt(p.x, p.y + 0.6, p.z - 30);
      const g = this.post.grade.uniforms;
      this.post.mist.uniforms.uMist.value = 0.92;
      this.fogMat.uniforms.uDensity.value = FOG_SETTINGS.density * INTRO_FOG;
      // Start at the intro's wider view so the settle on click begins exactly where the frame already is
      this.camera.fov = INTRO_FOV;
      this.camera.updateProjectionMatrix();
      gsap.to(g.uFade, { value: 1, duration: 3, ease: "sine.inOut" });
      return;
    }
    const fog = new URLSearchParams(window.location.search).get("fog");
    if (fog !== null) this.fogMat.uniforms.uDensity.value = Number(fog);
    const [x, y, z, yaw, pitch] = cam.split(",").map(Number);
    this.camera.position.set(x, y + groundHeight(x, z), z);
    this.camera.rotation.set(pitch || 0, yaw || 0, 0, "YXZ");
    this.post.grade.uniforms.uFade.value = 1;
    this.post.mist.uniforms.uMist.value = 0;
    this.post.mist.enabled = false;
    this.lampShow.allOn();
    this.ipod.show();
    this.started = true;
    this.walking = true;
    this.player.enabled = true;
  }

  async start() {
    await this.ready;
    if (!this.started) {
      this.started = true;
      const g = this.post.grade.uniforms;
      const mist = this.post.mist.uniforms;
      const cam = this.camera;
      const fov = { v: cam.fov };
      const apply = () => {
        cam.fov = fov.v;
        cam.updateProjectionMatrix();
      };
      apply();
      this.lampShow.begin(this.camera.position, this.timer.getElapsed());
      gsap
        .timeline()
        .to(g.uFade, { value: 1, duration: 0.6, ease: "sine.out" }, 0)
        .to(mist.uMist, { value: 0, duration: INTRO_MIST, ease: "power2.inOut", onComplete: () => void (this.post.mist.enabled = false) }, 0)
        .to(this.fogMat.uniforms.uDensity, { value: FOG_SETTINGS.density, duration: 5.5, ease: "power2.out" }, 0)
        .to(fov, { v: 60, duration: 3.6, ease: "power2.inOut", onUpdate: apply }, 0)
        .call(() => (this.walking = true), [], 1.4)
        // Everything on screen arrives together, on the intro's own clock (not on pointer lock or the music loading,
        // which made it land at a different moment every time)
        .call(
          () => {
            this.ipod.show();
            this.events.onUiIn?.();
          },
          [],
          INTRO_MIST * 0.75
        );
    }
    if (!this.sound) {
      this.sound = new Soundscape();
      await this.sound.begin(this.music);
      if (this.muted) this.sound.setMuted(true);
    }
    this.lock();
  }

  lock() {
    try {
      this.player.controls.lock();
    } catch {
      this.player.enabled = true;
    }
  }

  /** Press to pick up a snowball; the longer you hold, the harder and further it flies when you let go. */
  /** No snowballs indoors. */
  private get canThrow() {
    return !this.venueInside(this.camera.position);
  }

  private onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || !this.walking || !this.player.controls.isLocked || !this.canThrow) return;
    const t = this.timer.getElapsed();
    if (t - this.lastThrow < 0.3) return;
    this.chargeStart = t;
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button !== 0 || this.chargeStart < 0) return;
    const t = this.timer.getElapsed();
    const power = this.chargePower(t);
    this.chargeStart = -1;
    this.events.onCharge?.(-1);
    if (!this.walking || !this.player.controls.isLocked || !this.canThrow) return;
    this.lastThrow = t;
    this.snowballs.throw(this.camera, this.player.motion, power);
    this.sound?.throwSound();
  };

  /** 0 for a tap, 1 after holding for about a second. */
  private chargePower(t: number) {
    return this.chargeStart < 0 ? 0 : THREE.MathUtils.smoothstep(t - this.chargeStart, 0.12, 1.0);
  }

  private onKey = (e: KeyboardEvent) => {
    // Shortcuts follow the letter printed on the key, so they work on AZERTY and other layouts too (on a French
    // keyboard M sits where QWERTY has the semicolon). Walking keeps the physical WASD position instead.
    // Layouts without Latin letters fall back to the key's position
    const typed = e.key.toLowerCase();
    const letter = /^[a-z]$/.test(typed) ? typed : e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : "";
    if (letter === "m" && !e.repeat) this.toggleMute();
    if (letter === "n" && this.started) this.music?.skip(1);
    if (letter === "e" && !e.repeat && this.walking && this.player.enabled) {
      let handled = false;
      for (const v of this.venues) {
        const did = v.interact(this.camera.position);
        if (!did) continue;
        handled = true;
        if (v.sliding) this.sound?.doorSlide();
        if (did === "open" && !v.isInside(this.camera.position)) this.sound?.doorChime();
        break;
      }
      if (!handled) this.interact();
    }
    // Keyboard media keys, when the browser hands them to the page rather than to the media session
    if (e.key === "MediaTrackNext") this.music?.skip(1);
    if (e.key === "MediaTrackPrevious") this.music?.skip(-1);
    if (e.key === "MediaPlayPause") this.music?.toggle();
  };

  private get feet() {
    return new THREE.Vector3(this.camera.position.x, this.player.feetY, this.camera.position.z);
  }

  /** The nearest bench seat you could sit on from here. */
  private benchNear() {
    const f = this.feet;
    // Only from in front of it, where your legs would go: never through the backrest
    return (
      this.city.park.seats.find(
        (s) => Math.hypot(f.x - s.eye.x, f.z - s.eye.z) < 1.5 && (f.x - s.eye.x) * s.facing.x + (f.z - s.eye.z) * s.facing.z > 0.3 && f.y < s.ground + 0.6
      ) ?? null
    );
  }

  /** E's job when no door is in reach: the fire ladder, a bench, or getting up again. */
  private localPrompt() {
    if (this.rooftop.onLadder) return "@ladder";
    if (this.rooftop.busy || this.rising) return null;
    if (this.seat) return "stand up";
    return this.rooftop.prompt(this.feet) ?? (this.benchNear() ? "sit" : null);
  }

  private interact() {
    if (this.rooftop.busy || this.rising) return;
    if (this.seat) return this.standUp();
    if (this.rooftop.begin(this.feet, this.camera.position)) return;
    const seat = this.benchNear();
    if (!seat) return;
    // Turn to face the way the bench looks, keeping a slight downward tilt, while sinking onto it
    const toQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.06, Math.atan2(-seat.facing.x, -seat.facing.z), 0, "YXZ"));
    this.seat = { seat, k: 0, from: this.camera.position.clone(), fromQ: this.camera.quaternion.clone(), toQ };
  }

  private updateSeat(dt: number) {
    const s = this.seat!;
    if (s.k < 1) {
      s.k = Math.min(1, s.k + dt / 0.9);
      const e = s.k * s.k * (3 - 2 * s.k);
      this.camera.position.lerpVectors(s.from, s.seat.eye, e);
      // The turn hands over to the mouse: only steered while settling in
      this.camera.quaternion.slerpQuaternions(s.fromQ, s.toQ, e);
    } else {
      // Sitting still, breathing
      this.camera.position.y = s.seat.eye.y + Math.sin(this.timer.getElapsed() * 0.9) * 0.004;
      if (this.player.wantsToMove) this.standUp();
    }
  }

  private standUp() {
    const s = this.seat;
    if (!s || this.rising) return;
    this.seat = null;
    this.rising = { from: this.camera.position.clone(), to: s.seat.stand.clone(), k: 0 };
  }

  /**
   * Falling buffets the camera, more the faster you drop (so more from higher up), and a hard landing jolts it,
   * settling over a second or so. Smooth noise, not random jitter, so it reads as wind and impact.
   */
  private shakeCamera(dt: number, t: number) {
    const p = this.player;
    if (p.impact > 0) {
      this.quake = Math.max(this.quake, THREE.MathUtils.clamp((p.impact - 3) / 12, 0, 1));
      p.impact = 0;
    }
    this.quake *= Math.exp(-dt * 3.5);
    // The buffeting starts the moment the ground falls away (a real drop, not a hop), grows with the speed and holds
    // right down to the impact
    const target = p.airborne ? Math.max(THREE.MathUtils.smoothstep(p.drop, 1.6, 5), THREE.MathUtils.smoothstep(p.fallSpeed, 4, 9)) : 0;
    this.falling += (target - this.falling) * (1 - Math.exp(-dt * (target > this.falling ? 9 : 3)));
    // How hard the air is tearing past: drives the shake, the roll, the widening view, the vignette and the roar
    // (Builds quickly, and lets go over most of a second after you land, so touching down is not a hard cut)
    const rush = this.falling * THREE.MathUtils.smoothstep(p.fallSpeed, 2, 14);
    this.rush += (rush - this.rush) * (1 - Math.exp(-dt * (rush > this.rush ? 6 : 1.6)));
    const amp = this.falling * 0.014 + this.rush * 0.07 + this.quake * 0.12;
    // Faster and faster buffeting as you speed up, and the head rolling with it
    const quick = 1 + this.rush * 0.8;
    const n = (f: number, o: number) => Math.sin(t * f * quick + o) * 0.6 + Math.sin(t * f * quick * 1.73 + o * 2.1) * 0.4;
    this.shake.set(n(23, 0) * amp, n(29, 1.3) * amp * 0.7, n(19, 2.7) * amp);
    this.camera.position.add(this.shake);
    this.roll = (this.rush * 0.045 + this.quake * 0.03) * n(7, 4.2);
    if (this.roll !== 0) this.camera.rotateZ(this.roll);
  }

  /** The drop pulls the world away from you: the view widens as you pick up speed and snaps back on landing. */
  private fallView(dt: number) {
    const target = 60 + this.rush * 16;
    if (target > 60.01) this.widened = true;
    if (!this.widened) return;
    const fov = this.camera.fov + (target - this.camera.fov) * (1 - Math.exp(-dt * 2.5));
    if (target <= 60.01 && Math.abs(fov - 60) < 0.02) {
      this.widened = false;
      this.camera.fov = 60;
    } else this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /**
   * How high above the street you are, 0..1 (a roof is about half, the mast's platform all of it): the fog thickens
   * and climbs with you, and the lens bends.
   */
  private updateAltitude(dt: number) {
    const p = this.camera.position;
    const target = THREE.MathUtils.smoothstep(p.y - groundHeight(p.x, p.z), 8, 64);
    this.altitude += (target - this.altitude) * (1 - Math.exp(-dt * 2));
    this.fogMat.uniforms.uAltitude.value = this.altitude;
    this.post.grade.uniforms.uLens.value = this.altitude;
    this.post.grade.uniforms.uAspect.value = this.camera.aspect;
  }
  private altitude = 0;

  /** Getting up: lean forward over your knees, then rise and step clear of the bench. */
  private updateRising(dt: number) {
    const r = this.rising!;
    r.k = Math.min(1, r.k + dt / 0.85);
    const e = r.k * r.k * (3 - 2 * r.k);
    const end = r.to.clone().setY(r.to.y + 1.68);
    this.camera.position.lerpVectors(r.from, end, e);
    // Rising is slower than moving forward at first: the weight goes over the feet before the legs straighten
    this.camera.position.y = THREE.MathUtils.lerp(r.from.y, end.y, THREE.MathUtils.smoothstep(r.k, 0.25, 1)) - Math.sin(r.k * Math.PI) * 0.06;
    if (r.k >= 1) {
      this.rising = null;
      this.player.place(r.to.x, r.to.y, r.to.z);
    }
  }

  /** A snowball landed: on a parked car its alarm goes off; on a building, someone in that room reacts. */
  private onSnowballHit(point: THREE.Vector3, object?: THREE.Object3D) {
    const car = this.alarms.carAt(point);
    if (car) {
      if (this.alarms.trigger(car, this.timer.getElapsed())) {
        const toCar = new THREE.Vector3(car.x, 0.8, car.z).sub(this.camera.position);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const pan = right.dot(toCar.clone().normalize()) * 0.8;
        this.sound?.carAlarm(toCar.length(), pan);
      }
      return;
    }
    let o: THREE.Object3D | null = object ?? null;
    while (o && o !== this.city.groups[this.mode]) o = o.parent;
    if (o) knockOnRoom(point);
  }

  private nearest(list: LightSource[], n: number) {
    const p = this.camera.position;
    return [...list].sort((a, b) => a.position.distanceToSquared(p) - b.position.distanceToSquared(p)).slice(0, n);
  }

  // Only the n nearest lights are real; each one fades out as it approaches the distance of the first light left out,
  // so a light handed over to another lamp is already dark and nothing pops on or off
  private ranked(list: LightSource[], n: number) {
    const p = this.camera.position;
    const sorted = this.nearest(list, n + 1);
    const cut = sorted[n] ? sorted[n].position.distanceTo(p) : Infinity;
    return sorted.slice(0, n).map((l) => {
      const d = l.position.distanceTo(p);
      const fade = cut === Infinity ? 1 : THREE.MathUtils.smoothstep(cut - d, 0, cut * 0.3);
      return { l, w: l.strength * (l.power ?? 1) * fade };
    });
  }

  private updateLights() {
    const spots = this.ranked(this.lamps, SPOTS);
    this.spots.forEach((s, i) => {
      const r = spots[i];
      if (!r) return;
      if (this.spotLamp[i] !== r.l) {
        this.spotLamp[i] = r.l;
        s.shadow.needsUpdate = true;
      }
      s.position.copy(r.l.position);
      s.target.position.set(r.l.position.x, 0, r.l.position.z);
      s.color.copy(r.l.color);
      s.intensity = 42 * r.w;
    });
    // How lit the street is around you, from every nearby lamp at once (so it changes smoothly as you walk)
    let light = 0;
    const cam = this.camera.position;
    for (const r of spots) light += r.w / (1 + r.l.position.distanceToSquared(cam) / 90);
    if (spots[0]) this.ipod.setLight(light, spots[0].l.color);
    const snowU = this.snow.uniforms.uLights.value;
    this.ranked(this.lamps, SNOW_LIGHTS).forEach(({ l, w }, i) => snowU[i].set(l.position.x, l.position.y, l.position.z, w));
    const fog = [...this.ranked(this.lamps, 9), ...this.ranked([...this.others, ...this.alarms.lights], FOG_LIGHTS - 9)];
    const fp = this.fogMat.uniforms.uLightPos.value;
    const fc = this.fogMat.uniforms.uLightCol.value;
    fog.forEach(({ l, w }, i) => {
      fp[i].set(l.position.x, l.position.y, l.position.z, w);
      fc[i].set(l.color.r, l.color.g, l.color.b, l.omni ? 1 : 0);
    });
  }

  private render(dt: number) {
    const r = this.renderer;
    r.autoClear = true;
    this.camera.layers.set(0);
    r.setRenderTarget(this.sceneRT);
    r.render(this.scene, this.camera);

    r.autoClear = false;
    this.camera.layers.set(OVERLAY_LAYER);
    r.setRenderTarget(this.overlayRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this.scene, this.camera);
    r.autoClear = true;
    this.camera.layers.enable(0);

    const u = this.fogMat.uniforms;
    u.uProjInv.value.copy(this.camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(this.camera.matrixWorld);
    u.uCamPos.value.copy(this.camera.position);
    u.uFrame.value = this.frame++ % 64;
    r.setRenderTarget(this.fogRT);
    this.fogQuad.render(r);

    const cu = this.post.cinematic.uniforms;
    cu.tFocus.value = this.focus.update(r, this.sceneRT.depthTexture!, this.camera.projectionMatrixInverse);
    cu.uProjInv.value.copy(this.camera.projectionMatrixInverse);
    cu.uCamWorld.value.copy(this.camera.matrixWorld);
    const viewProj = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    cu.uPrevViewProj.value.copy(this.hasPrev ? this.prevViewProj : viewProj);
    // A fixed exposure, not a fixed fraction of a frame: the streaks stay as long as the low-battery 30 fps look
    // (which felt right) when the frame rate climbs back up, instead of shrinking with every extra frame
    this.frameTime += (Math.max(dt, 1 / 120) - this.frameTime) * 0.1;
    // Falling: longer streaks and the world rushing up past the edges of the frame
    cu.uShutter.value = (EXPOSURE / this.frameTime) * (1 + 1.2 * this.falling + 0.8 * this.rush);
    // The upward streak eases off after touchdown instead of vanishing on the frame you land
    const streak = this.falling * Math.min(1, 0.35 + this.player.fallSpeed / 10);
    this.streak = Math.max(streak, this.streak * Math.exp(-dt * 2.5));
    cu.uFall.value = this.streak;

    this.post.composer.render(dt);
    this.ipod.render();
    this.prevViewProj.copy(viewProj);
    this.hasPrev = true;
  }

  private loop = (now = performance.now()) => {
    this.raf = requestAnimationFrame(this.loop);
    const interval = 1000 / FPS;
    const elapsed = now - this.lastFrame;
    // 120 Hz screens would otherwise render twice as many frames for no visible gain
    if (elapsed < interval - 1) return;
    this.lastFrame = now - (elapsed % interval);
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.05);
    const t = this.timer.getElapsed();
    // The shake is laid on top of the camera each frame: take last frame's off before anything moves it
    this.camera.position.sub(this.shake);
    this.shake.set(0, 0, 0);
    if (this.roll !== 0) this.camera.rotateZ(-this.roll);
    this.roll = 0;
    if (this.walking) {
      const climb = this.rooftop.update(dt, this.player.enabled ? this.player.climbInput : 0, this.player.shiftHeld);
      if (climb) {
        this.camera.position.copy(climb.eye);
        if (climb.done) this.player.place(climb.done.x, climb.done.y, climb.done.z);
      } else if (this.seat) this.updateSeat(dt);
      else if (this.rising) this.updateRising(dt);
      else {
        this.player.update(dt, t);
        this.shakeCamera(dt, t);
      }
      this.fallView(dt);
      this.sound?.fallWind(this.rush);
      this.post.grade.uniforms.uRush.value = this.rush;
      this.player.jumped = false;
    }
    this.alarms.update(t);
    this.camera.updateMatrixWorld();
    if (this.frame % 10 === 0) this.cull();
    this.lampShow.update(t);
    this.updateLights();
    this.updateLife(t);
    this.snowballs.update(dt, t);
    if (this.venues.length) {
      const states = this.venues.map((v) => {
        const st = v.update(dt, this.camera.position);
        if (st.closed && v.sliding) this.sound?.doorSlide();
        return st;
      });
      const s = {
        inside: Math.max(...states.map((x) => x.inside)),
        hum: Math.max(...states.map((x) => x.hum)),
        prompt: states.find((x) => x.prompt)?.prompt ?? null,
      };
      this.sound?.setInside(s.inside);
      // Indoors everything is close and bright: a little less bloom, a little less blur. The doors standing open only
      // matter to the sound (inside reads 0.7 then, 1 once they shut), so the picture settles once as you step in
      // instead of losing its glow and softness again halfway down the aisle when the doors close behind you
      const look = Math.min(1, s.inside / 0.7);
      const pr = this.renderer.getPixelRatio();
      this.post.bloom.strength = 0.9 * (1 - 0.45 * look);
      // The tubes still glow; the white tiles and walls must not haze over the whole room
      this.post.bloom.threshold = 0.7 + 1.3 * look;
      this.post.cinematic.uniforms.uAperture.value = 5.0 * pr * (1 - 0.4 * look) * (1 + 0.5 * this.falling);
      this.sound?.shopHum(s.hum);
      const prompt = this.walking ? s.prompt ?? this.localPrompt() : null;
      if (prompt !== this.prompt) {
        this.prompt = prompt;
        this.events.onPrompt?.(prompt);
      }
    }
    this.ipod.music = this.music;
    this.ipod.update(dt, t, this.camera, { speed: this.player.motion.length(), grounded: !this.player.airborne });
    if (this.chargeStart >= 0) this.events.onCharge?.(this.chargePower(t));
    this.snow.uniforms.uTime.value = t;
    this.updateWeather(dt, t);
    this.snow.uniforms.uCenter.value.copy(this.camera.position);
    this.fogMat.uniforms.uTime.value = t;
    this.updateAltitude(dt);
    this.post.grade.uniforms.uTime.value = t;
    if (this.post.mist.enabled) this.post.mist.uniforms.uTime.value = t;
    this.render(dt);
  };

  /** Small things that keep the street alive: rooms switching lights and the failing lamp's buzz. */
  private updateLife(t: number) {
    interiorUniforms.uRoomTime.value = t;
    this.prints.update(t);
    if (!this.sound) return;
    const p = this.camera.position;
    const failing = this.lampShow.failing;
    if (failing) {
      const near = Math.max(0, 1 - failing.position.distanceTo(p) / 22);
      const power = failing.power ?? 1;
      this.sound.buzz(near * (power < 0.95 ? 1 : 0.15) * (power > 0.01 ? 1 : 0.4));
    }
  }

  /** A boot print where you just stepped: not on the ice, a car roof or before the walk has begun. */
  private leavePrint(both = false) {
    if (!this.walking || !this.player.enabled) return;
    const p = this.camera.position;
    if (pondDistance(p.x, p.z) < 1.05) return;
    if (this.venueInside(p)) return;
    if (this.player.feetY > terrainHeight(p.x, p.z) + 0.2) return;
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    this.prints.step(p.x, p.z, Math.atan2(f.x, -f.z), this.timer.getElapsed(), both);
  }

  /** A light storm: slow gusts push the snow sideways and swell the wind, and the air curls around you as you walk. */
  private updateWeather(dt: number, t: number) {
    const u = this.snow.uniforms;
    const wave = 0.5 + 0.5 * (Math.sin(t * 0.13) * 0.55 + Math.sin(t * 0.31 + 1.7) * 0.3 + Math.sin(t * 0.77 + 4.1) * 0.15);
    const gust = wave * wave;
    u.uGust.value = gust;
    windUniforms.uWindTime.value = t;
    windUniforms.uWindGust.value = gust;
    u.uDrift.value.addScaledVector(WIND, dt * (0.8 + 1.5 * gust));
    const step = this.weatherPrev ? this.camera.position.distanceTo(this.weatherPrev) : 0;
    this.weatherPrev = (this.weatherPrev ?? new THREE.Vector3()).copy(this.camera.position);
    const speed = dt > 0 ? Math.min(step / dt / 5.4, 1) : 0;
    u.uMove.value += (speed - u.uMove.value) * (1 - Math.exp(-1.2 * dt));
    u.uSwirl.value += dt * (0.8 + 1.4 * u.uMove.value + 0.8 * gust);
    this.sound?.gust(gust);
  }
  private weatherPrev?: THREE.Vector3;

  private onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.post.composer.setSize(w, h);
    this.ipod.resize();
    this.allocateTargets();
  };

  /** Mutes or unmutes everything; remembered if the sound hasn't started yet. */
  muted = false;
  toggleMute() {
    this.muted = !this.muted;
    this.sound?.setMuted(this.muted);
    if (!this.sound) this.music?.setVolume(this.muted ? 0 : 0.54);
    this.events.onMuteChange?.(this.muted);
  }

  /** Away from the tab, everything goes quiet (wind, the shop's hum, the music) and picks up again on return. */
  private musicWasPlaying = false;
  private onVisibility = () => {
    if (document.hidden) {
      this.musicWasPlaying = !!this.music?.state.playing;
      this.music?.pause();
      void this.sound?.ctx.suspend();
    } else {
      void this.sound?.ctx.resume();
      if (this.musicWasPlaying) this.music?.play();
    }
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKey);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    this.player?.dispose();
    this.sound?.dispose();
    gsap.globalTimeline.clear();
    for (const rt of [this.sceneRT, this.overlayRT, this.fogRT]) rt.dispose();
    this.ipod.dispose();
    this.events.onPrompt?.(null);
    this.renderer.dispose();
  }
}
