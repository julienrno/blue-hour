import * as THREE from "three";

/**
 * Every model the city needs, in the order the loading screen talks about them, with what it is doing meanwhile.
 * The files are fetched up front (so the percentage is real bytes, not a guess) and handed to three's file cache, so
 * the loaders that parse them later read them from memory.
 */
const ASSETS: { url: string; line: string }[] = [
  { url: "/models/opt/building-1.glb", line: "pouring concrete for the panel blocks" },
  { url: "/models/opt/streetlamp.glb", line: "wiring the street lamps" },
  { url: "/models/opt/car-2.glb", line: "parking the cars under the snow" },
  { url: "/models/opt/antenna.glb", line: "raising the radio mast" },
  { url: "/models/opt/supermarket.glb", line: "stocking the shelves of the 24h shop" },
  { url: "/models/opt/station2.glb", line: "filling the tanks at the petrol station" },
  { url: "/models/opt/bench.glb", line: "sweeping snow off the park benches" },
  { url: "/models/opt/playground.glb", line: "sweeping snow off the park benches" },
  { url: "/models/opt/ipod-hq.glb", line: "charging the ipod" },
];

// Used for a file whose size the server does not say
const UNKNOWN_SIZE = 1_000_000;

/** Downloads every asset, reporting 0..1 of the bytes and a line about the first one still on its way. */
export async function preloadAssets(onProgress: (fraction: number, line: string) => void) {
  THREE.Cache.enabled = true;
  const got = ASSETS.map(() => 0);
  const size = ASSETS.map(() => UNKNOWN_SIZE);
  const done = ASSETS.map(() => false);
  const report = () => {
    const total = size.reduce((a, b) => a + b, 0);
    const received = got.reduce((a, b, i) => a + Math.min(b, size[i]), 0);
    const next = ASSETS.find((_, i) => !done[i]);
    onProgress(total ? received / total : 1, next?.line ?? "");
  };
  report();
  await Promise.all(
    ASSETS.map(async (asset, i) => {
      try {
        const res = await fetch(asset.url);
        if (!res.ok || !res.body) throw new Error(res.statusText);
        const length = Number(res.headers.get("content-length"));
        if (length > 0) size[i] = length;
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          chunks.push(value);
          got[i] += value.length;
          report();
        }
        const buffer = new Uint8Array(got[i]);
        let at = 0;
        for (const c of chunks) {
          buffer.set(c, at);
          at += c.length;
        }
        THREE.Cache.add(`file:${asset.url}`, buffer.buffer);
      } catch {
        // The loader will try again on its own and the scene copes without the model
      }
      size[i] = Math.max(got[i], 1);
      done[i] = true;
      report();
    })
  );
}

/** Lets go of the downloaded files once everything has been built from them. */
export function releaseAssets() {
  THREE.Cache.clear();
  THREE.Cache.enabled = false;
}
