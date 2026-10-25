import * as THREE from "three";
import { POND } from "./noise";
import { WIND } from "./wind";
import type { LightSource } from "./city";

const MAX_LAMPS = 4;

/**
 * A frozen pond: one flat sheet laid over a basin carved into the terrain, so the snowy bank cuts a ragged
 * shoreline across it. Everything else is in the shader: black clear ice and milky patches, wind-blown snow
 * streaks thickening toward the shore, trapped bubbles, frozen ripples in the normal, and a
 * fresnel sheen of the foggy sky so the ice reads as glossy even away from the lamps. Nearby lamps are mirrored
 * analytically as soft vertical streaks, the way lights smear across real ice, without rendering a reflection pass.
 */
export function createPond(lamps: LightSource[] = []) {
  const near = lamps.slice(0, MAX_LAMPS);
  const lampPos = Array.from({ length: MAX_LAMPS }, (_, i) => (near[i] ? near[i].position.clone() : new THREE.Vector3(0, -999, 0)));
  const lampCol = Array.from({ length: MAX_LAMPS }, (_, i) => (near[i] ? near[i].color.clone().multiplyScalar(near[i].strength) : new THREE.Color(0, 0, 0)));
  const geo = new THREE.CircleGeometry(1, 96);
  geo.rotateX(-Math.PI / 2);
  geo.scale(POND.rx * 1.3, 1, POND.rz * 1.3);
  geo.rotateY(POND.rot);

  const mat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.1, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPond = { value: new THREE.Vector4(POND.x, POND.z, POND.rx, POND.rz) };
    shader.uniforms.uPondRot = { value: POND.rot };
    shader.uniforms.uLampPos = { value: lampPos };
    shader.uniforms.uLampCol = { value: lampCol };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vIcePos;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvIcePos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        varying vec3 vIcePos;
        uniform vec4 uPond;
        uniform float uPondRot;
        uniform vec3 uLampPos[${MAX_LAMPS}];
        uniform vec3 uLampCol[${MAX_LAMPS}];
        float iceSnow;
        float iceRough;
        vec3 iceN = vec3(0.0, 1.0, 0.0);
        float iceMilky = 0.0;

        float iHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        vec2 iHash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
        float iNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(iHash(i), iHash(i + vec2(1.0, 0.0)), f.x), mix(iHash(i + vec2(0.0, 1.0)), iHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float iFbm(vec2 p) {
          float s = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) { s += a * iNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
          return s;
        }
        `
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        {
          vec2 p = vIcePos.xz;
          vec2 rel = p - uPond.xy;
          float c = cos(uPondRot);
          float s = sin(uPondRot);
          vec2 lp = vec2(rel.x * c - rel.y * s, rel.x * s + rel.y * c) / uPond.zw;
          float shore = length(lp);

          vec2 W = normalize(vec2(${WIND.x.toFixed(3)}, ${WIND.z.toFixed(3)}));
          vec2 Wp = vec2(-W.y, W.x);
          float milky = smoothstep(0.38, 0.75, iFbm(p * 0.11 + 3.0));
          // Snow blown across the ice lies in long streaks along the wind, and piles up near the bank
          float streak = iFbm(vec2(dot(p, W) * 0.07, dot(p, Wp) * 0.55));
          iceSnow = smoothstep(0.6, 0.8, streak * 0.75 + iFbm(p * 0.45) * 0.3 + smoothstep(0.5, 1.05, shore) * 0.6);

          // Air bubbles frozen in the milky ice
          vec2 bc = floor(p * 3.5);
          vec2 bf = fract(p * 3.5) - 0.25 - iHash2(bc) * 0.5;
          float bubble = (1.0 - smoothstep(0.03, 0.07, length(bf))) * step(0.72, iHash(bc + 3.1)) * milky;

          vec3 clearIce = vec3(0.006, 0.014, 0.02);
          vec3 milkyIce = vec3(0.15, 0.19, 0.24);
          vec3 col = mix(clearIce, milkyIce, milky * 0.75);
          col += vec3(0.35, 0.4, 0.46) * bubble;
          col = mix(col, vec3(0.78, 0.82, 0.92), iceSnow);
          diffuseColor.rgb = col;
          iceMilky = milky;
          iceRough = mix(mix(0.08, 0.22, milky), 0.92, iceSnow);
        }`
      )
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = iceRough;")
      .replace(
        "#include <normal_fragment_maps>",
        /* glsl */ `#include <normal_fragment_maps>
        {
          // Frozen ripples: a gentle slope field, flattened where snow lies
          vec2 p = vIcePos.xz * 0.6;
          float e = 0.15;
          float h0 = iFbm(p);
          vec2 g = vec2(iFbm(p + vec2(e, 0.0)) - h0, iFbm(p + vec2(0.0, e)) - h0) / e;
          vec3 nW = normalize(vec3(-g.x * 0.05, 1.0, -g.y * 0.05) * vec3(1.0 - iceSnow * 0.8, 1.0, 1.0 - iceSnow * 0.8));
          iceN = nW;
          normal = normalize(mat3(viewMatrix) * nW);
        }`
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
        {
          // Sheen of the hazy sky at grazing angles, the way dark ice looks glossy even without a lamp
          float fres = 0.03 + 0.97 * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 5.0);
          float glossy = 1.0 - iceSnow;
          totalEmissiveRadiance += vec3(0.11, 0.15, 0.3) * fres * glossy * 1.4;

          // Lamps mirrored in the ice: compare the reflected view ray with the direction to each lamp head.
          // The match is much looser vertically than sideways, which stretches each glint into a streak toward you.
          vec3 R = reflect(normalize(vIcePos - cameraPosition), iceN);
          for (int i = 0; i < ${MAX_LAMPS}; i++) {
            vec3 L = normalize(uLampPos[i] - vIcePos);
            vec3 dv = L - R;
            float dy = dv.y;
            float dh2 = dot(dv.xz, dv.xz);
            float streak = exp(-dh2 / 0.0012 - dy * dy / 0.03);
            float halo = exp(-dot(dv, dv) * 14.0) * 0.12;
            totalEmissiveRadiance += uLampCol[i] * (streak * 2.2 + halo) * glossy * (1.0 - iceMilky * 0.5);
          }
        }`
      );
  };
  mat.customProgramCacheKey = () => "frozen-pond";

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(POND.x, POND.ice, POND.z);
  mesh.receiveShadow = true;
  return mesh;
}
