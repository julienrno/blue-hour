"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { SoundCloudMusic } from "@/lib/world/soundcloud";
import { drawNowPlaying, SCREEN_H, SCREEN_W } from "@/lib/world/ipodScreen";

const MODEL = "/models/opt/ipod.glb";
// Model space (metres, front face toward +x): the display and the click wheel on the front
const FRONT_X = 0.0139;
const SCREEN = { y: 0.0546, z: 0.0003, w: 0.066, h: 0.0495 };
const WHEEL = { y: -0.048, z: 0, r: 0.036, center: 0.012 };

/**
 * A 3D iPod classic in the corner, GTA-phone style, in its own small canvas so it stays crisp and unaffected by
 * the scene's fog and blur. Its screen mirrors the SoundCloud player. The wheel is clickable while paused.
 */
export default function IPod({ music }: { music: SoundCloudMusic | null }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !music) return;
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Kept dim and cool so it sits in the night scene rather than glowing like a sticker
    renderer.toneMappingExposure = 0.62;

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.25;
    const key = new THREE.DirectionalLight("#bccdff", 1.1);
    key.position.set(-1, 2, 2);
    const rim = new THREE.DirectionalLight("#6f8cff", 1.2);
    rim.position.set(2, 0.5, -1);
    scene.add(key, rim, new THREE.HemisphereLight("#8fa6e8", "#1a2140", 0.6));

    const camera = new THREE.PerspectiveCamera(24, canvas.clientWidth / canvas.clientHeight, 0.01, 10);
    camera.position.set(0, 0, 0.56);

    // The screen: a canvas texture laid just above the model's glass
    const screenCanvas = document.createElement("canvas");
    screenCanvas.width = SCREEN_W;
    screenCanvas.height = SCREEN_H;
    const sctx = screenCanvas.getContext("2d")!;
    const screenTex = new THREE.CanvasTexture(screenCanvas);
    screenTex.colorSpace = THREE.SRGBColorSpace;
    screenTex.anisotropy = 8;
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(SCREEN.w, SCREEN.h).rotateY(Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: screenTex, color: "#d9e2f0", toneMapped: false })
    );
    screen.position.set(FRONT_X + 0.0003, SCREEN.y, SCREEN.z);

    const holder = new THREE.Group();
    holder.add(screen);
    const pivot = new THREE.Group();
    pivot.add(holder);
    // Front toward the viewer, turned a little toward the middle of the screen
    holder.rotation.y = -Math.PI / 2;
    scene.add(pivot);

    let disposed = false;
    new GLTFLoader().load(MODEL, (gltf) => {
      if (disposed) return;
      gltf.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!m) return;
        m.envMapIntensity = 0.8;
        // Exported as blended (for the glass); drawn opaque, so the body never looks see-through
        m.transparent = false;
        m.opacity = 1;
        m.depthWrite = true;
      });
      holder.add(gltf.scene);
    });

    let drawn = "";
    const redraw = () => {
      drawn = "";
    };
    const updateScreen = () => {
      const now = music.state;
      const sig = `${now.title}|${now.artist}|${now.artwork}|${Math.floor(now.position / 1000)}|${now.duration}|${now.playing}|${now.index}`;
      if (sig === drawn) return;
      drawn = sig;
      drawNowPlaying(sctx, now, redraw);
      screenTex.needsUpdate = true;
    };

    // Clicks on the wheel: intersect the front face plane and read the angle around the wheel
    const ray = new THREE.Raycaster();
    const onClick = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      holder.updateMatrixWorld(true);
      const inv = holder.matrixWorld.clone().invert();
      const o = ray.ray.origin.clone().applyMatrix4(inv);
      const d = ray.ray.direction.clone().transformDirection(inv);
      if (Math.abs(d.x) < 1e-6) return;
      const t = (FRONT_X - o.x) / d.x;
      const p = o.addScaledVector(d, t);
      const dy = p.y - WHEEL.y;
      const dz = p.z - WHEEL.z;
      const dist = Math.hypot(dy, dz);
      if (dist > WHEEL.r) return;
      if (dist < WHEEL.center) return music.toggle();
      // Viewer's right is -z on the front face
      const a = Math.atan2(dy, -dz);
      if (a > Math.PI / 4 && a < (3 * Math.PI) / 4) music.skip(0);
      else if (a < -Math.PI / 4 && a > (-3 * Math.PI) / 4) music.toggle();
      else if (Math.abs(a) <= Math.PI / 4) music.skip(1);
      else music.skip(-1);
    };
    canvas.addEventListener("click", onClick);

    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 1000 / 30) return;
      last = now;
      const t = now / 1000;
      pivot.rotation.set(-0.12 + Math.sin(t * 0.6) * 0.015, 0.5 + Math.sin(t * 0.4) * 0.03, 0.07);
      pivot.position.y = Math.sin(t * 0.8) * 0.002;
      updateScreen();
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("click", onClick);
      screenTex.dispose();
      env.dispose();
      pmrem.dispose();
      renderer.dispose();
    };
  }, [music]);

  return <canvas ref={ref} className="ipod" aria-label="now playing on the iPod" />;
}
