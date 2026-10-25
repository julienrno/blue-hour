import * as THREE from "three";
import { shopUniforms, stationUniforms } from "./shop";
import { createRng } from "./random";
import { FOG_SETTINGS } from "./fog";

export const SNOW_LIGHTS = 8;
export const OVERLAY_LAYER = 1;

type FlakeLayer = { count: number; box: THREE.Vector3; size: [number, number]; seed: number };

function flakeLayer({ count, box, size, seed }: FlakeLayer, shared: ReturnType<typeof sharedUniforms>) {
  const rng = createRng(seed);
  const pos = new Float32Array(count * 3);
  const rnd = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    pos.set([rng.next() * box.x, rng.next() * box.y, rng.next() * box.z], i * 3);
    rnd.set([rng.next(), rng.next()], i * 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aRnd", new THREE.BufferAttribute(rnd, 2));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uBox: { value: box },
      uSize: { value: new THREE.Vector2(...size) },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uBox;
      uniform vec3 uCenter;
      uniform vec3 uDrift;
      uniform float uGust;
      uniform float uMove;
      uniform float uSwirl;
      uniform vec2 uSize;
      uniform float uPixelRatio;
      uniform float uViewport;
      uniform vec2 uNear;
      uniform float uDensity;
      uniform float uFalloff;
      uniform vec3 uAmbient;
      uniform vec4 uLights[${SNOW_LIGHTS}];
      uniform vec4 uShop;
      uniform float uShopTop;
      uniform vec4 uShop2;
      uniform float uShop2Top;
      attribute vec2 aRnd;
      varying vec3 vColor;
      varying float vStretch;
      varying float vNear;

      void main() {
        float speed = mix(0.55, 1.15, aRnd.x);
        vec3 p = position;
        float t = uTime;
        p.y -= t * speed;
        // Wind drift is integrated on the CPU so gusts can speed it up without the flakes jumping
        p.xz += uDrift.xz * mix(0.7, 1.2, aRnd.y);
        float flutter = 0.35 + 0.2 * uGust;
        p.x += sin(t * mix(0.6, 1.4, aRnd.y) + aRnd.x * 50.0) * flutter + sin(t * 2.3 + aRnd.y * 20.0) * 0.06;
        p.z += cos(t * mix(0.5, 1.1, aRnd.x) + aRnd.y * 40.0) * flutter;
        vec3 origin = uCenter - uBox * vec3(0.5, 0.35, 0.5);
        p = mod(p - origin, uBox) + origin;

        // Eddies around the body: near the camera the air curls, more so when walking and in gusts
        vec3 r = p - uCenter;
        // Speed changes only how fast the eddy turns (uSwirl is integrated on the CPU), never its size,
        // so starting or stopping can't whip every nearby flake sideways at once
        float prox = exp(-dot(r, r) / 10.0);
        float energy = prox * (0.35 + 0.35 * uMove + 0.3 * uGust);
        float ang = prox * 0.55 * sin(uSwirl + aRnd.y * 6.283);
        float ca = cos(ang);
        float sa = sin(ang);
        r.xz = mat2(ca, -sa, sa, ca) * r.xz;
        // Phases come from the flake's world position, so walking doesn't shake the field in step with you
        r += vec3(sin(t * 2.1 + p.z * 1.7 + aRnd.x * 9.0), 0.6 * sin(t * 1.7 + p.x * 1.9 + aRnd.y * 7.0), cos(t * 1.9 + p.y * 2.3 + aRnd.x * 5.0)) * 0.22 * energy;
        r.y += energy * 0.3 * sin(t * 1.3 + aRnd.y * 12.0);
        p = uCenter + r;
        // It doesn't snow in the shop
        if ((p.x > uShop.x && p.x < uShop.z && p.z > uShop.y && p.z < uShop.w && p.y < uShopTop) ||
            (p.x > uShop2.x && p.x < uShop2.z && p.z > uShop2.y && p.z < uShop2.w && p.y < uShop2Top)) {
          vColor = vec3(0.0);
          vStretch = 1.0;
          vNear = 0.0;
          gl_PointSize = 0.0;
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }

        vec3 light = uAmbient * 2.2;
        for (int i = 0; i < ${SNOW_LIGHTS}; i++) {
          vec4 L = uLights[i];
          vec3 d = p - L.xyz;
          float d2 = dot(d, d);
          float down = smoothstep(0.2, 0.8, -d.y * inversesqrt(d2 + 1e-4));
          light += vec3(0.62, 0.86, 1.0) * L.w * (down * 1.0 + 0.15) * 40.0 / (d2 + 2.0);
        }

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = -mv.z;
        float fogT = exp(-uDensity * 0.9 * exp(-max(p.y, 0.0) * uFalloff) * dist);
        float size = mix(uSize.x, uSize.y, pow(aRnd.x, 3.0));
        float px = size * uViewport / dist;
        float drawn = max(px, 1.5);
        gl_PointSize = drawn * uPixelRatio;
        // Sub-pixel flakes keep their energy by dimming instead of growing to a fixed 1px dot
        float coverage = px / drawn;
        // Keep-out zone around the lens: flakes fade before they can get close to the camera
        float keepOut = smoothstep(uNear.x, uNear.y, dist);
        vStretch = mix(1.0, 1.35 + 0.25 * uGust, smoothstep(8.0, 3.0, dist));
        // Flakes passing right by the lens are out of focus: softer and dimmer, never hard dots
        vNear = 1.0 - smoothstep(0.9, 2.6, dist);
        vColor = light * fogT * coverage * keepOut * 2.6 * (1.0 - 0.45 * vNear);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vStretch;
      varying float vNear;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        c.y /= vStretch;
        float d = length(c) * 2.0;
        float a = exp(-d * d * mix(4.0, 2.4, vNear));
        if (a < 0.01) discard;
        gl_FragColor = vec4(vColor * a, 1.0);
      }
    `,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.layers.set(OVERLAY_LAYER);
  return points;
}

function sharedUniforms() {
  return {
    uTime: { value: 0 },
    uCenter: { value: new THREE.Vector3() },
    uDrift: { value: new THREE.Vector3() },
    uGust: { value: 0 },
    uMove: { value: 0 },
    uSwirl: { value: 0 },
    uPixelRatio: { value: 1 },
    uViewport: { value: 600 },
    uNear: { value: new THREE.Vector2(0.7, 1.6) },
    uDensity: { value: FOG_SETTINGS.density },
    uFalloff: { value: FOG_SETTINGS.heightFalloff },
    uAmbient: { value: FOG_SETTINGS.ambient },
    uLights: { value: Array.from({ length: SNOW_LIGHTS }, () => new THREE.Vector4(0, -999, 0, 0)) },
    uShop: shopUniforms.uShop,
    uShopTop: shopUniforms.uShopTop,
    uShop2: stationUniforms.uShop,
    uShop2Top: stationUniforms.uShopTop,
  };
}

export function createSnowfall() {
  const uniforms = sharedUniforms();
  const group = new THREE.Group();
  group.add(flakeLayer({ count: 46000, box: new THREE.Vector3(60, 30, 60), size: [0.00625, 0.0175], seed: 3 }, uniforms));
  group.layers.set(OVERLAY_LAYER);
  return { group, uniforms };
}

export function createSky() {
  const geo = new THREE.SphereGeometry(900, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uZenith: { value: new THREE.Color("#050a1e") }, uHorizon: { value: new THREE.Color("#1a2a66") } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      varying vec3 vDir;
      void main() {
        gl_FragColor = vec4(mix(uHorizon, uZenith, pow(clamp(vDir.y, 0.0, 1.0), 0.5)), 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1;
  return mesh;
}
