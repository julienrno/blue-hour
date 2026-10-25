"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import type { Experience } from "@/lib/world/Experience";
import Minimap from "@/components/Minimap";
import { SoundCloudMusic, widgetSrc } from "@/lib/world/soundcloud";

const TITLE = "pov: it’s blue hour in eastern europe";

export default function BlueHour() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const expRef = useRef<Experience | null>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLIFrameElement>(null);
  const crosshairRef = useRef<HTMLDivElement>(null);
  const musicRef = useRef<SoundCloudMusic | null>(null);
  const [phase, setPhase] = useState<"intro" | "walking" | "paused">("intro");
  // The map, instructions, player and iPod, all at once three-quarters into the intro
  const [uiIn, setUiIn] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [exp, setExp] = useState<Experience | null>(null);

  const showToast = (text: string) => {
    const toast = toastRef.current;
    if (!toast) return;
    toast.textContent = text;
    gsap.fromTo(toast, { autoAlpha: 1 }, { autoAlpha: 0, duration: 1.2, delay: 1.4, ease: "sine.in" });
  };

  useEffect(() => {
    let disposed = false;
    import("@/lib/world/Experience").then(({ Experience }) => {
      if (disposed || !canvasRef.current) return;
      const exp = new Experience(canvasRef.current, {
        onLockChange: (locked) => setPhase(locked ? "walking" : "paused"),
        // Charging a throw opens the dot into a ring that tightens to full strength
        onCharge: (level) => {
          const el = crosshairRef.current;
          if (!el) return;
          el.style.transform = level < 0 ? "" : `scale(${1 + level * 2.2})`;
          el.style.opacity = level < 0 ? "" : String(0.85 + level * 0.15);
        },
        onPrompt: setPrompt,
        onUiIn: () => setUiIn(true),
        onBuildingsChange: (set) =>
          showToast(set === "proc" ? "buildings · panel blocks" : `buildings · model ${set.replace("building", "")}`),
      });
      expRef.current = exp;
      if (playerRef.current) {
        musicRef.current ??= new SoundCloudMusic(playerRef.current);
        exp.music = musicRef.current;
      }
      setExp(exp);
      const params = new URLSearchParams(window.location.search);
      if (params.has("shot")) gsap.ticker.lagSmoothing(0);
      if (params.has("cam")) {
        gsap.ticker.lagSmoothing(0);
        gsap.set(veilRef.current, { display: "none" });
        setPhase("walking");
        setUiIn(true);
      }
    });
    return () => {
      disposed = true;
      expRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    const veil = veilRef.current;
    if (!veil) return;
    if (phase === "walking") {
      gsap.to(veil, { autoAlpha: 0, duration: 1.2, ease: "sine.inOut" });
      return;
    }
    gsap.to(veil, { autoAlpha: 1, duration: 0.8, ease: "sine.out" });
    if (phase === "intro") {
      gsap.fromTo(
        veil.querySelectorAll("h1 span"),
        { opacity: 0, y: 6, filter: "blur(6px)" },
        { opacity: 1, y: 0, filter: "blur(0px)", duration: 1.6, stagger: 0.035, ease: "sine.out", delay: 0.6 }
      );
      gsap.fromTo(veil.querySelectorAll("p, small"), { opacity: 0 }, { opacity: 0.85, duration: 2, delay: 2.4 });
    }
  }, [phase]);

  const enter = async () => {
    const exp = expRef.current;
    if (!exp) return;
    // Start the music right inside the click, so the browser lets the player make sound
    if (phase === "intro") musicRef.current?.start();
    // Let the melt be seen: the title leaves as the mist starts to thin
    if (phase === "intro") gsap.to(veilRef.current, { autoAlpha: 0, duration: 0.9, ease: "sine.in" });
    await exp.start();
  };

  return (
    <main className="stage">
      <canvas ref={canvasRef} />
      {phase === "walking" && <div ref={crosshairRef} className="crosshair" />}
      {phase === "walking" && prompt && <div className="prompt">{prompt}</div>}
      <div ref={toastRef} className="toast" />
      {uiIn && <Minimap exp={exp} />}
      {uiIn && (
        <div className="hud">
          <span>wasd to walk</span>
          <span>hold to throw</span>
          <span>n for the next song</span>
          <span>esc to pause</span>
        </div>
      )}
      {/* Official SoundCloud player: loaded from the start so the click can start it, shown (as the widget terms
          require) once the walk begins, arriving with the map */}
      <iframe
        ref={playerRef}
        className={uiIn ? "sc-player is-on" : "sc-player"}
        title="snowfall by øneheart × reidenshi on SoundCloud"
        src={widgetSrc()}
        allow="autoplay"
        scrolling="no"
        frameBorder="no"
      />
      <div ref={veilRef} className="veil" onClick={enter}>
        <h1>
          {TITLE.split("").map((ch, i) => (
            <span key={i}>{ch}</span>
          ))}
        </h1>
        <p>{phase === "paused" ? "click to keep wandering" : "click to wander"}</p>
      </div>
    </main>
  );
}
