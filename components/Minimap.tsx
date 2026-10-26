"use client";

import { useEffect, useRef } from "react";
import type { Experience } from "@/lib/world/Experience";

const SIZE = 168;
const PX_PER_M = 1.4;
const ROAD_HALF = 5;
// Ring radius inset so the N badge riding on it stays inside the canvas
const INSET = 10;

type MapData = NonNullable<ReturnType<Experience["mapData"]>>;

function drawLayer(data: MapData) {
  const { bounds } = data;
  const w = Math.ceil((bounds.maxX - bounds.minX) * PX_PER_M);
  const h = Math.ceil((bounds.maxZ - bounds.minZ) * PX_PER_M);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const X = (x: number) => (x - bounds.minX) * PX_PER_M;
  const Z = (z: number) => (z - bounds.minZ) * PX_PER_M;

  ctx.fillStyle = "#1d2229";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#222a26";
  ctx.fillRect(X(50), Z(-270), (135 - 50) * PX_PER_M, 430 * PX_PER_M);

  if (data.pond) {
    const p = data.pond;
    ctx.fillStyle = "#2b3846";
    ctx.beginPath();
    ctx.ellipse(X(p.x), Z(p.z), p.rx * PX_PER_M, p.rz * PX_PER_M, -p.rot, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = "#3a414b";
  for (const b of data.buildings) ctx.fillRect(X(b.minX), Z(b.minZ), (b.maxX - b.minX) * PX_PER_M, (b.maxZ - b.minZ) * PX_PER_M);

  type Box = { minX: number; maxX: number; minZ: number; maxZ: number };
  const rect = (b: Box, inset = 0) =>
    [X(b.minX) + inset, Z(b.minZ) + inset, (b.maxX - b.minX) * PX_PER_M - inset * 2, (b.maxZ - b.minZ) * PX_PER_M - inset * 2] as const;

  // The gas station reads like one on a GTA map: a paved forecourt, the canopy as a lit outline over it, the two pump
  // islands under it and the shop behind, in the same yellow as the subtitles
  const st = data.station;
  ctx.fillStyle = "#2c323b";
  ctx.fillRect(...rect(st.forecourt));
  ctx.fillStyle = "rgba(201, 169, 58, 0.16)";
  ctx.fillRect(...rect(st.canopy));
  ctx.strokeStyle = "#c9a93a";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(...rect(st.canopy, 0.75));
  ctx.fillStyle = "#c9a93a";
  for (const b of st.islands) ctx.fillRect(...rect(b));
  ctx.fillRect(...rect(st.shop));

  // The radio mast: its platform, with the red of its lights at the centre
  if (data.antenna) {
    const a = data.antenna;
    ctx.fillStyle = "#3a414c";
    ctx.fillRect(...rect(a));
    ctx.fillStyle = "#e0402e";
    ctx.beginPath();
    ctx.arc(X((a.minX + a.maxX) / 2), Z((a.minZ + a.maxZ) / 2), 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // The shop: the places worth walking to
  for (const b of data.venues) ctx.fillRect(...rect(b));

  ctx.fillStyle = "#b9bec6";
  ctx.fillRect(X(-ROAD_HALF), 0, ROAD_HALF * 2 * PX_PER_M, h);

  ctx.strokeStyle = "#7c838c";
  ctx.lineWidth = 2.2 * PX_PER_M;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  data.trail.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z))));
  ctx.stroke();
  return c;
}

export default function Minimap({ exp }: { exp: Experience | null }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !exp) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    const ctx = canvas.getContext("2d")!;
    let layer: HTMLCanvasElement | null = null;
    let layerFor: unknown = null;
    let raf = 0;
    let last = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 33) return;
      last = now;
      const data = exp.mapData();
      if (!data) return;
      if (layerFor !== data.buildings) {
        layer = drawLayer(data);
        layerFor = data.buildings;
      }
      const { x, z, heading } = exp.pose();
      const r = SIZE / 2;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);

      ctx.save();
      ctx.beginPath();
      ctx.arc(r, r, r - INSET - 3, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = "#15191e";
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.translate(r, r);
      ctx.rotate(-heading);
      ctx.translate(-(x - data.bounds.minX) * PX_PER_M, -(z - data.bounds.minZ) * PX_PER_M);
      if (layer) ctx.drawImage(layer, 0, 0);
      ctx.restore();

      ctx.lineWidth = 6;
      ctx.strokeStyle = "rgba(10, 12, 16, 0.9)";
      ctx.beginPath();
      ctx.arc(r, r, r - INSET, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#4f9a5c";
      ctx.beginPath();
      ctx.arc(r, r, r - INSET, Math.PI * 0.53, Math.PI * 1.47);
      ctx.stroke();
      ctx.strokeStyle = "#4a77b8";
      ctx.beginPath();
      ctx.arc(r, r, r - INSET, -Math.PI * 0.47, Math.PI * 0.47);
      ctx.stroke();

      ctx.save();
      ctx.translate(r, r);
      ctx.fillStyle = "#f2f4f7";
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 6);
      ctx.lineTo(0, 3.5);
      ctx.lineTo(-5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      const na = -heading - Math.PI / 2;
      const nx = r + Math.cos(na) * (r - INSET);
      const ny = r + Math.sin(na) * (r - INSET);
      ctx.fillStyle = "#0b0d10";
      ctx.beginPath();
      ctx.arc(nx, ny, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f2f4f7";
      ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("N", nx, ny + 0.5);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [exp]);

  return <canvas ref={ref} className="minimap" style={{ width: SIZE, height: SIZE }} />;
}
