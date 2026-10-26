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
  const playerRef = useRef<HTMLIFrameElement>(null);
  const crosshairRef = useRef<HTMLDivElement>(null);
  const musicRef = useRef<SoundCloudMusic | null>(null);
  const [phase, setPhase] = useState<"intro" | "walking" | "paused">("intro");
  // The map, instructions, player and iPod, all at once three-quarters into the intro
  const [uiIn, setUiIn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [clickable, setClickable] = useState(false);
  // Loading screen: the percentage shown (eased towards the real one), what is being built, and whether it is done
  const [shown, setShown] = useState(0);
  const [line, setLine] = useState("waking the city up");
  const [loaded, setLoaded] = useState(false);
  // Set by the first pause: from then on the veil invites you back, including while it fades out on resume
  const [wandered, setWandered] = useState(false);
  useEffect(() => {
    if (phase === "paused") setWandered(true);
  }, [phase]);
  const loaderRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef({ v: 0 });
  const [keys, setKeys] = useState({ w: "W", a: "A", s: "S", d: "D" });

  // Movement uses key positions; ask the browser which letters sit there on this keyboard (Chrome and Edge can tell).
  // Elsewhere (Safari, Firefox) the labels correct themselves the first time one of those keys is pressed
  useEffect(() => {
    const learn = (e: KeyboardEvent) => {
      const slot = ({ KeyW: "w", KeyA: "a", KeyS: "s", KeyD: "d" } as const)[e.code as "KeyW"];
      if (!slot || e.key.length !== 1 || !/\p{L}/u.test(e.key)) return;
      const label = e.key.toUpperCase();
      setKeys((k) => (k[slot] === label ? k : { ...k, [slot]: label }));
    };
    window.addEventListener("keydown", learn);
    return () => window.removeEventListener("keydown", learn);
  }, []);
  useEffect(() => {
    const kb = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
    kb?.getLayoutMap?.()
      .then((map) => {
        const at = (code: string, fallback: string) => (map.get(code) ?? fallback).toUpperCase();
        setKeys({ w: at("KeyW", "W"), a: at("KeyA", "A"), s: at("KeyS", "S"), d: at("KeyD", "D") });
      })
      .catch(() => undefined);
  }, []);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [exp, setExp] = useState<Experience | null>(null);


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
        onLoad: (progress, text) => {
          if (text) setLine(text);
          const last = progress >= 1;
          gsap.to(pctRef.current, {
            v: progress * 100,
            duration: last ? 0.4 : 0.35,
            ease: "power1.out",
            overwrite: true,
            onUpdate: () => setShown(Math.floor(pctRef.current.v)),
            // At 100: a breath, then the counter fades and the title comes in
            onComplete: last
              ? () =>
                  gsap.to(loaderRef.current, {
                    autoAlpha: 0,
                    duration: 0.7,
                    delay: 0.3,
                    ease: "sine.in",
                    onComplete: () => setLoaded(true),
                  })
              : undefined,
          });
        },
        onMuteChange: setMuted,
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
    if (phase === "intro" && loaded) {
      gsap.fromTo(
        veil.querySelectorAll("h1 span"),
        { opacity: 0, y: 6, filter: "blur(6px)" },
        { opacity: 1, y: 0, filter: "blur(0px)", duration: 1.6, stagger: 0.035, ease: "sine.out", delay: 0.6 }
      );
      // The click only counts once "click to wander" starts to appear, so nobody skips the title
      gsap.fromTo(
        veil.querySelectorAll("p, small"),
        { opacity: 0 },
        { opacity: 0.85, duration: 2, delay: 2.4, onStart: () => setClickable(true) }
      );
    }
  }, [phase, loaded]);

  const enter = async () => {
    const exp = expRef.current;
    if (!exp || (phase === "intro" && !clickable)) return;
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
      {phase === "walking" && prompt && (
        <div className="prompt">
          {prompt === "@ladder" ? (
            <>
              {/* On the ladder: the forward and back keys climb */}
              <kbd>{keys.w}</kbd>
              <kbd>{keys.s}</kbd>
              climb
            </>
          ) : (
            <>
              <kbd>E</kbd>
              {prompt}
            </>
          )}
        </div>
      )}
      {uiIn && <Minimap exp={exp} />}
      {uiIn && (
        <div className="hud">
          <span className="hint">
            {/* Laid out as on the keyboard, with the letters this keyboard actually prints there (ZQSD on AZERTY) */}
            <span className="keys">
              <kbd>{keys.w}</kbd>
              <span className="row">
                <kbd>{keys.a}</kbd>
                <kbd>{keys.s}</kbd>
                <kbd>{keys.d}</kbd>
              </span>
            </span>
            walk
          </span>
          <span className="hint">
            <svg className="icon" viewBox="0 0 12 18" aria-hidden="true">
              <rect x="1" y="1" width="10" height="16" rx="5" />
              <path d="M6 4v3" />
            </svg>
            hold to throw
          </span>
          <span className="hint">
            <kbd>N</kbd>
            next song
          </span>
          <span className="hint">
            <kbd className="word">esc</kbd>
            pause
          </span>
          <button className="hint sound-toggle" onClick={() => expRef.current?.toggleMute()}>
            <kbd>M</kbd>
            <svg className="icon" viewBox="0 0 20 16" aria-hidden="true">
              <path d="M2 5.5h3.5L10 2v12l-4.5-3.5H2z" />
              {muted ? <path d="M13.5 5.5l5 5M18.5 5.5l-5 5" /> : <path d="M13 5c1.3 1.6 1.3 4.4 0 6M15.5 3c2.4 2.8 2.4 7.2 0 10" />}
            </svg>
            {muted ? "unmute" : "mute"}
          </button>
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
      <div ref={veilRef} className={phase === "intro" && !clickable ? "veil is-waiting" : "veil"} onClick={enter}>
        {loaded ? (
          <>
            <h1>
              {TITLE.split("").map((ch, i) => (
                <span key={i}>{ch}</span>
              ))}
            </h1>
            {/* Looks like a button, but the whole screen is the button */}
            <p className="enter">{wandered ? "click to keep wandering" : "click to wander"}</p>
          </>
        ) : (
          <div ref={loaderRef} className="loader" aria-live="polite">
            <span className="loader-pct">{shown}%</span>
            <span className="loader-line">{line}…</span>
          </div>
        )}
      </div>
    </main>
  );
}
