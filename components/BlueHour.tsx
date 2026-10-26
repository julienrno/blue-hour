"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import type { Experience } from "@/lib/world/Experience";
import Minimap from "@/components/Minimap";
import { SoundCloudMusic, widgetSrc } from "@/lib/world/soundcloud";

const TITLE = "pov: it’s blue hour in eastern europe";

// The models that aren't generated in code, as their licences ask to be credited (CC BY 4.0 unless noted)
const CREDITS = [
  { what: "Soviet apartment building", who: "Colin.Greenall", url: "https://sketchfab.com/3d-models/low-poly-soviet-apartment-building-8k-05229ac1d1f94e6c8cacaad91110c602" },
  { what: "Audi 80", who: "l.corijn", url: "https://sketchfab.com/3d-models/audi-80-lowpoly-b3e18613e61a41b295052cf2b4b70099" },
  { what: "Street lamp", who: "Krayton Gaming", url: "https://sketchfab.com/3d-models/street-lamp-4438dd6844384d9ca0e1b7f12775fcc9" },
  { what: "Old antenna", who: "Apokalips123", url: "https://sketchfab.com/3d-models/old-antenna-5f0844c0fc704fbea51b34c05c61ee08" },
  { what: "Small red gas station", who: "SmashedBones", url: "https://sketchfab.com/3d-models/small-red-gas-station-1a0feafb044148e585bfe588afe617b8" },
  { what: "Super market", who: "dasy444", url: "https://sketchfab.com/3d-models/super-market-for-free-c14deca21a994978a8aa304561aced50", licence: "Sketchfab Standard" },
  { what: "USSR bench", who: "Nikita Filimonov", url: "https://sketchfab.com/3d-models/bench-2-ussr-game-ready-e5a9af56c9a247309e034f41a835f161" },
  { what: "Kids playground", who: "99.Miles", url: "https://sketchfab.com/3d-models/low-poly-kids-playground-61c6f6f70db14bbb89ecdfa04b99bbc6" },
  { what: "iPod Classic", who: "Timothy Ahene", url: "https://sketchfab.com/3d-models/ipod-classic-13dbe30b0e45408c8bfaddfe6a4e8786" },
];

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
  const [failed, setFailed] = useState(false);
  const [credits, setCredits] = useState(false);
  const enterRef = useRef<HTMLButtonElement>(null);
  // Set by the first pause: from then on the veil invites you back, including while it fades out on resume
  const [wandered, setWandered] = useState(false);
  useEffect(() => {
    if (phase === "paused") setWandered(true);
  }, [phase]);
  const loaderRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef({ v: 0 });
  const [keys, setKeys] = useState({ w: "W", a: "A", s: "S", d: "D", f: "F" });

  // Movement uses key positions; ask the browser which letters sit there on this keyboard (Chrome and Edge can tell).
  // Elsewhere (Safari, Firefox) the labels correct themselves the first time one of those keys is pressed
  useEffect(() => {
    const learn = (e: KeyboardEvent) => {
      const slot = ({ KeyW: "w", KeyA: "a", KeyS: "s", KeyD: "d", KeyF: "f" } as const)[e.code as "KeyW"];
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
        setKeys({ w: at("KeyW", "W"), a: at("KeyA", "A"), s: at("KeyS", "S"), d: at("KeyD", "D"), f: at("KeyF", "F") });
      })
      .catch(() => undefined);
  }, []);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [exp, setExp] = useState<Experience | null>(null);


  useEffect(() => {
    let disposed = false;
    import("@/lib/world/Experience").then(({ Experience }) => {
      if (disposed || !canvasRef.current) return;
      // Without WebGL there is no city to build: say so plainly instead of loading forever
      const probe = document.createElement("canvas");
      if (!(probe.getContext("webgl2") || probe.getContext("webgl"))) {
        setFailed(true);
        return;
      }
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
        onLockRefused: () => gsap.to(veilRef.current, { autoAlpha: 1, duration: 0.25, ease: "sine.out", overwrite: true }),
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
      // Coming back from a pause is quick; the first entrance keeps its slow melt
      gsap.to(veil, { autoAlpha: 0, duration: wandered ? 0.3 : 1.2, ease: "sine.inOut", overwrite: true });
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
        veil.querySelectorAll(".enter, small"),
        { opacity: 0 },
        { opacity: 0.85, duration: 2, delay: 2.4, onStart: () => setClickable(true) }
      );
    }
  }, [phase, loaded]);

  // Focus styles only for people moving around with the keyboard: Tab turns them on, the mouse turns them off (the
  // button is focused for them automatically, and browsers would otherwise light it up on load)
  useEffect(() => {
    const root = document.documentElement;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Tab") root.classList.add("using-keyboard");
    };
    const mouse = () => root.classList.remove("using-keyboard");
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", mouse);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", mouse);
    };
  }, []);

  // Keyboard users land on the way in as soon as it works (and on the way back when paused)
  useEffect(() => {
    if (phase === "walking" || !loaded) return;
    if (phase === "paused" || clickable) enterRef.current?.focus({ preventScroll: true });
  }, [phase, clickable, loaded]);

  const enter = async () => {
    const exp = expRef.current;
    if (!exp || (phase === "intro" && !clickable)) return;
    // Start the music right inside the click, so the browser lets the player make sound
    if (phase === "intro") musicRef.current?.start();
    // Let the melt be seen: the title leaves as the mist starts to thin. Resuming clears the screen right away
    if (phase === "intro") gsap.to(veilRef.current, { autoAlpha: 0, duration: 0.9, ease: "sine.in" });
    else gsap.to(veilRef.current, { autoAlpha: 0, duration: 0.25, ease: "sine.in", overwrite: true });
    await exp.start();
  };

  return (
    <main className="stage">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="First-person view of a snowy street of Soviet panel blocks at blue hour, street lamps glowing in the fog"
      />
      {phase === "walking" && <div ref={crosshairRef} className="crosshair" aria-hidden="true" />}
      {phase === "walking" && prompt && (
        <div className="prompt" role="status">
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
            <span className="or">or</span>
            <kbd>{keys.f}</kbd>
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
          <button
            type="button"
            className="hint sound-toggle"
            aria-label={muted ? "Unmute sound (M)" : "Mute sound (M)"}
            onClick={() => expRef.current?.toggleMute()}
          >
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
        {failed ? (
          <div className="loader" role="alert">
            <span className="loader-line">
              this walk needs WebGL, which this browser has turned off. try another browser, or turn on hardware
              acceleration in its settings.
            </span>
          </div>
        ) : loaded ? (
          <>
            <h1 aria-label={TITLE}>
              {TITLE.split("").map((ch, i) => (
                <span key={i} aria-hidden="true">
                  {ch}
                </span>
              ))}
            </h1>
            {/* A real button for keyboards and screen readers; with a mouse the whole screen works too */}
            <button
              ref={enterRef}
              type="button"
              className="enter"
              disabled={phase === "intro" && !clickable}
              aria-describedby="how-to"
            >
              {wandered ? "click to keep wandering" : "click to wander"}
            </button>
            {/* Credits: their own click, so opening them doesn't start the walk */}
            <button
              type="button"
              className="credits-toggle"
              aria-expanded={credits}
              onClick={(e) => {
                e.stopPropagation();
                setCredits((c) => !c);
              }}
            >
              credits
            </button>
            {credits && (
              <div className="credits" onClick={(e) => e.stopPropagation()}>
                <p>
                  Everything else is generated in code: the town, snow, fog, rooms behind the windows and every sound.
                  Models modified (simplified, rescaled, recoloured). CC BY 4.0 unless noted.
                </p>
                <ul>
                  {CREDITS.map((c) => (
                    <li key={c.url}>
                      <a href={c.url} target="_blank" rel="noreferrer">
                        {c.what}
                      </a>{" "}
                      by {c.who}
                      {c.licence ? ` · ${c.licence}` : ""}
                    </li>
                  ))}
                </ul>
                <p>
                  <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
                    CC BY 4.0
                  </a>{" "}
                  · music played through SoundCloud · type: Instrument Serif (OFL) · three.js, GSAP
                </p>
              </div>
            )}
            <p id="how-to" className="sr-only">
              Walk with W A S D or the up and down arrow keys, turn with the mouse or the left and right arrow keys,
              jump with Space, hold the mouse button or F to throw a snowball, press E to use a ladder or a bench, N for the
              next song, M to mute, and Escape to pause.
            </p>
          </>
        ) : (
          <div ref={loaderRef} className="loader">
            <h1 className="loader-name">blue hour</h1>
            <p className="loader-about">
              A first-person walk through a snowed-in town of Eastern European panel blocks at dusk. Climb the roofs and
              the radio mast, throw snowballs, find the 24h shop.
            </p>
            <div
              className="loader-bar"
              role="progressbar"
              aria-label="Loading"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={shown}
            >
              <i style={{ transform: `scaleX(${shown / 100})` }} />
            </div>
            <span className="loader-line">
              <span aria-live="polite">{line}…</span> <span aria-hidden="true">{shown}%</span>
            </span>
          </div>
        )}
      </div>
    </main>
  );
}
