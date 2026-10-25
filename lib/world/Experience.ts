import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import gsap from "gsap";
import { BOUNDS, buildCity, type BuildingSet, type LightSource } from "./city";
import { loadModels } from "./models";
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
import { interiorUniforms } from "./interiors";
import { Snowballs } from "./snowballs";
import { IPodViewModel } from "./ipod";
import { ShopView, type Venue } from "./shop";
import { StationView } from "./station";
import { buildPark } from "./park";

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
  onBuildingsChange?: (set: string) => void;
  /** 0-1 while a throw is being charged, -1 when released. */
  onCharge?: (level: number) => void;
  /** A short instruction to show (e.g. "e to go in"), or null to hide it. */
  onPrompt?: (text: string | null) => void;
  /** The intro's mist is three-quarters clear: time for the map, the instructions, the player and the iPod. */
  onUiIn?: () => void;
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

  private async init() {
    const models = await loadModels();
    this.scene.add(this.camera);
    this.city = buildCity(this.scene, models);
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
      () => [this.city.groups[this.mode], ...this.city.carMeshes]
    );
    this.snowballs.onStick = (mesh, point) => this.venues.forEach((v) => v.stick(mesh, point));
    this.snowballs.onSplat = (point, hard) => this.sound?.splatSound(point.distanceTo(this.camera.position), hard);
    this.scene.add(this.snowballs.group);
    this.venues = [new ShopView(this.city.shop, groundHeight), new StationView(this.city.station, groundHeight)];
    buildPark(this.city.park)
      .then((g) => this.scene.add(g))
      .catch(() => undefined);
    for (const v of this.venues) {
      this.scene.add(v.group);
      v.load(this.renderer).catch(() => undefined);
    }
    this.ipod.mount(this.canvas);
    this.ipod.load().catch(() => undefined);

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

    const wanted = new URLSearchParams(window.location.search).get("buildings");
    const sets = this.city.buildingSets;
    this.setBuildings(sets.find((s) => s === wanted) ?? (sets.includes("building1") ? "building1" : "proc"), false);
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKey);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    this.applyDebugView();
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
    for (const c of this.cullables) c.obj.visible = p.distanceTo(c.center) - c.radius < CULL_DISTANCE;
  }

  /** Top-down data for the minimap: footprints of the visible buildings, the road and the park trail. */
  mapData() {
    if (!this.city) return null;
    return { buildings: this.city.buildingColliders[this.mode], venues: [this.city.shop.bounds], station: this.city.station.map, trail: this.city.trail.map((p) => ({ x: p.x, z: p.y })), bounds: BOUNDS, pond: POND };
  }

  /** Player position and heading (radians, 0 = facing -z). */
  pose() {
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    return { x: this.camera.position.x, z: this.camera.position.z, heading: Math.atan2(f.x, -f.z) };
  }

  setBuildings(mode: BuildingSet, announce = true) {
    this.mode = mode;
    for (const [set, group] of Object.entries(this.city.groups)) group.visible = set === mode;
    this.player.colliders = [...this.city.colliders, ...this.city.buildingColliders[mode]];
    this.others = this.city.lights.filter((l) => !l.lamp && (!l.set || l.set === mode));
    this.spots.forEach((s) => (s.shadow.needsUpdate = true));
    if (announce) this.events.onBuildingsChange?.(mode);
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
    if (e.code === "KeyM" && this.sound) this.sound.toggleMute();
    if (e.code === "KeyN" && this.started) this.music?.skip(1);
    if (e.code === "KeyE" && !e.repeat && this.walking && this.player.enabled) {
      for (const v of this.venues) {
        const did = v.interact(this.camera.position);
        if (!did) continue;
        if (v.sliding) this.sound?.doorSlide();
        if (did === "open" && !v.isInside(this.camera.position)) this.sound?.doorChime();
        break;
      }
    }
    // Keyboard media keys, when the browser hands them to the page rather than to the media session
    if (e.key === "MediaTrackNext") this.music?.skip(1);
    if (e.key === "MediaTrackPrevious") this.music?.skip(-1);
    if (e.key === "MediaPlayPause") this.music?.toggle();
    if (e.code === "KeyB") {
      const sets = this.city.buildingSets;
      this.setBuildings(sets[(sets.indexOf(this.mode) + 1) % sets.length]);
    }
  };

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
    const fog = [...this.ranked(this.lamps, 9), ...this.ranked(this.others, FOG_LIGHTS - 9)];
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
    cu.uShutter.value = EXPOSURE / this.frameTime;

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
    if (this.walking) {
      this.player.update(dt, t);
      this.player.jumped = false;
    }
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
      this.post.cinematic.uniforms.uAperture.value = 5.0 * pr * (1 - 0.4 * look);
      this.sound?.shopHum(s.hum);
      const prompt = this.walking ? s.prompt : null;
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
