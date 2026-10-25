import * as THREE from "three";

export type Vent = { x: number; y: number; z: number };

/** Manhole cover with the ring of snow the heat has melted around it. */
export function manholeMeshes(vents: Vent[]) {
  const group = new THREE.Group();
  const cover = new THREE.CylinderGeometry(0.34, 0.34, 0.03, 28);
  const coverMat = new THREE.MeshStandardMaterial({ color: "#1d1f24", roughness: 0.45, metalness: 0.6 });
  const ringTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(64, 64, 10, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.55, "rgba(255,255,255,0.85)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  // Wet, dark asphalt where the snow has melted: glossy so the lamps glint in it
  const wetMat = new THREE.MeshStandardMaterial({
    color: "#15171c",
    roughness: 0.18,
    alphaMap: ringTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const wet = new THREE.CircleGeometry(1.15, 32).rotateX(-Math.PI / 2);
  for (const v of vents) {
    const ring = new THREE.Mesh(wet, wetMat);
    ring.position.set(v.x, v.y + 0.01, v.z);
    ring.receiveShadow = true;
    const lid = new THREE.Mesh(cover, coverMat);
    lid.position.set(v.x, v.y + 0.012, v.z);
    lid.receiveShadow = true;
    group.add(ring, lid);
  }
  return group;
}
