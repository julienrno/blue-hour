"use client";

import { useRef } from "react";
import type { Experience } from "@/lib/world/Experience";

// How far a stick's knob travels from its centre (px)
const STICK_REACH = 44;

/** An on-screen stick: reports where the knob is, -1..1 on each axis (x right, y up), and 0, 0 when let go. */
function Stick({ label, className, onMove }: { label: string; className: string; onMove: (x: number, y: number) => void }) {
  const knobRef = useRef<HTMLSpanElement>(null);
  const held = useRef<{ id: number; x: number; y: number } | null>(null);

  const move = (e: React.PointerEvent) => {
    const h = held.current;
    if (!h || h.id !== e.pointerId) return;
    let dx = e.clientX - h.x;
    let dy = e.clientY - h.y;
    const d = Math.hypot(dx, dy);
    if (d > STICK_REACH) {
      dx *= STICK_REACH / d;
      dy *= STICK_REACH / d;
    }
    if (knobRef.current) knobRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
    onMove(dx / STICK_REACH, -dy / STICK_REACH);
  };
  const release = (e: React.PointerEvent) => {
    if (held.current?.id !== e.pointerId) return;
    held.current = null;
    if (knobRef.current) knobRef.current.style.transform = "";
    onMove(0, 0);
  };

  return (
    <div
      className={`touch-stick ${className}`}
      aria-label={label}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const r = e.currentTarget.getBoundingClientRect();
        held.current = { id: e.pointerId, x: r.left + r.width / 2, y: r.top + r.height / 2 };
        move(e);
      }}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <span ref={knobRef} className="touch-knob" />
    </div>
  );
}

/**
 * Phones and tablets: a stick under each thumb (left walks, pushed to the rim to run; right looks around), a drag
 * anywhere else to look too, and buttons above the right stick to jump, throw (hold to wind up) and use whatever the
 * prompt offers.
 */
export default function TouchControls({ exp, prompt, muted }: { exp: Experience; prompt: string | null; muted: boolean }) {
  const looking = useRef<{ id: number; x: number; y: number } | null>(null);
  const action = prompt && prompt !== "@ladder" ? prompt : null;

  return (
    <div className="touch">
      {/* Everywhere that isn't a control: drag to look around */}
      <div
        className="touch-look"
        onPointerDown={(e) => {
          if (looking.current) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          looking.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
        }}
        onPointerMove={(e) => {
          const l = looking.current;
          if (!l || l.id !== e.pointerId) return;
          exp.look(e.clientX - l.x, e.clientY - l.y);
          l.x = e.clientX;
          l.y = e.clientY;
        }}
        onPointerUp={(e) => {
          if (looking.current?.id === e.pointerId) looking.current = null;
        }}
        onPointerCancel={(e) => {
          if (looking.current?.id === e.pointerId) looking.current = null;
        }}
      />

      <Stick label="Walk" className="is-walk" onMove={(x, y) => exp.setStick(x, y)} />
      <Stick label="Look around" className="is-look" onMove={(x, y) => exp.setLookStick(x, y)} />

      <div className="touch-buttons">
        {action && (
          <button type="button" className="touch-btn touch-action" onPointerDown={() => exp.use()}>
            {action}
          </button>
        )}
        <div className="touch-row">
          <button
            type="button"
            className="touch-btn"
            aria-label="Hold to throw a snowball"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              exp.throwStart();
            }}
            onPointerUp={() => exp.throwEnd()}
            onPointerCancel={() => exp.throwEnd()}
          >
            throw
          </button>
          <button type="button" className="touch-btn" onPointerDown={() => exp.jump()}>
            jump
          </button>
        </div>
      </div>

      <div className="touch-bar">
        <button type="button" className="touch-small" aria-label="Pause" onClick={() => exp.pause()}>
          <svg viewBox="0 0 12 14" aria-hidden="true">
            <path d="M2 1v12M10 1v12" />
          </svg>
        </button>
        <button type="button" className="touch-small" aria-label={muted ? "Unmute sound" : "Mute sound"} onClick={() => exp.toggleMute()}>
          <svg viewBox="0 0 20 16" aria-hidden="true">
            <path d="M2 5.5h3.5L10 2v12l-4.5-3.5H2z" />
            {muted ? <path d="M13.5 5.5l5 5M18.5 5.5l-5 5" /> : <path d="M13 5c1.3 1.6 1.3 4.4 0 6M15.5 3c2.4 2.8 2.4 7.2 0 10" />}
          </svg>
        </button>
      </div>
    </div>
  );
}
