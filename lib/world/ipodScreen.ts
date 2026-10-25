import type { NowPlaying } from "./soundcloud";

export const SCREEN_W = 320;
// Same proportions as the model's display window
export const SCREEN_H = 264;

const time = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const artCache = new Map<string, HTMLImageElement | null>();
function artwork(url: string | null, onLoad: () => void) {
  if (!url) return null;
  if (artCache.has(url)) return artCache.get(url)!;
  artCache.set(url, null);
  const img = new Image();
  // SoundCloud's image CDN allows CORS; without it the canvas could not be uploaded as a texture
  img.crossOrigin = "anonymous";
  img.onload = () => {
    artCache.set(url, img);
    onLoad();
  };
  img.src = url;
  return null;
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** Draws the iPod classic "Now Playing" screen for the current track. */
export function drawNowPlaying(ctx: CanvasRenderingContext2D, now: NowPlaying, redraw: () => void) {
  const W = SCREEN_W;
  const H = SCREEN_H;
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#fbfcfe");
  bg.addColorStop(1, "#dfe6f0");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Title bar
  const bar = ctx.createLinearGradient(0, 0, 0, 22);
  bar.addColorStop(0, "#fdfdfe");
  bar.addColorStop(1, "#c4ccd6");
  ctx.fillStyle = bar;
  ctx.fillRect(0, 0, W, 22);
  ctx.fillStyle = "#8a94a1";
  ctx.fillRect(0, 22, W, 1);
  ctx.fillStyle = "#111";
  ctx.font = "600 13px -apple-system, 'Helvetica Neue', Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Now Playing", W / 2, 12);
  ctx.textAlign = "left";
  ctx.fillText(now.playing ? "▶" : "❚❚", 8, 12);
  // Battery
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(W - 32, 7, 22, 10);
  ctx.fillStyle = "#333";
  ctx.fillRect(W - 10, 10, 2, 4);
  ctx.fillStyle = "#4fb43c";
  ctx.fillRect(W - 30, 9, 15, 6);

  ctx.fillStyle = "#555";
  ctx.font = "12px -apple-system, 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText(`${now.index + 1} of ${now.count}`, 10, 38);

  // Artwork with a soft reflection, like the classic's cover flow
  const ax = 12;
  const ay = 52;
  const as = 136;
  const img = artwork(now.artwork, redraw);
  if (img) ctx.drawImage(img, ax, ay, as, as);
  else {
    const g = ctx.createLinearGradient(ax, ay, ax + as, ay + as);
    g.addColorStop(0, "#28345a");
    g.addColorStop(1, "#0d1226");
    ctx.fillStyle = g;
    ctx.fillRect(ax, ay, as, as);
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "28px -apple-system, 'Helvetica Neue', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("♪", ax + as / 2, ay + as / 2);
    ctx.textAlign = "left";
  }
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(ax + 0.5, ay + 0.5, as - 1, as - 1);

  const tx = ax + as + 12;
  const tw = W - tx - 10;
  ctx.fillStyle = "#111";
  ctx.font = "700 15px -apple-system, 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText(fit(ctx, now.title, tw), tx, ay + 22);
  ctx.fillStyle = "#333";
  ctx.font = "13px -apple-system, 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText(fit(ctx, now.artist, tw), tx, ay + 44);
  ctx.fillStyle = "#666";
  ctx.fillText(fit(ctx, "blue hour", tw), tx, ay + 64);

  // Progress
  const py = H - 50;
  const progress = now.duration ? Math.min(now.position / now.duration, 1) : 0;
  ctx.fillStyle = "#fff";
  ctx.fillRect(12, py, W - 24, 10);
  ctx.strokeStyle = "#7b8694";
  ctx.strokeRect(12.5, py + 0.5, W - 25, 9);
  const pg = ctx.createLinearGradient(0, py, 0, py + 10);
  pg.addColorStop(0, "#9cc0ff");
  pg.addColorStop(1, "#3567d4");
  ctx.fillStyle = pg;
  ctx.fillRect(13, py + 1, (W - 26) * progress, 8);
  ctx.fillStyle = "#333";
  ctx.font = "12px -apple-system, 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText(time(now.position), 12, py + 24);
  ctx.textAlign = "right";
  ctx.fillText(`-${time(now.duration - now.position)}`, W - 12, py + 24);
  ctx.textAlign = "left";
}
