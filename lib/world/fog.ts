import * as THREE from "three";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";
import { shopUniforms, stationUniforms } from "./shop";

export const FOG_LIGHTS = 14;

export const FOG_SETTINGS = {
  density: 0.034,
  heightFalloff: 0.045,
  ambient: new THREE.Color("#223a86"),
};

const NOISE = /* glsl */ `
  float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float noise3(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x), mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x), mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
`;

export function createFogMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      tDepth: { value: null },
      uProjInv: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uDensity: { value: FOG_SETTINGS.density },
      uFalloff: { value: FOG_SETTINGS.heightFalloff },
      uAmbient: { value: FOG_SETTINGS.ambient },
      uWind: { value: new THREE.Vector3(0.8, 0, 0.3) },
      uLightPos: { value: Array.from({ length: FOG_LIGHTS }, () => new THREE.Vector4(0, -999, 0, 0)) },
      uLightCol: { value: Array.from({ length: FOG_LIGHTS }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uFrame: { value: 0 },
      uShop: shopUniforms.uShop,
      uShopTop: shopUniforms.uShopTop,
      uShop2: stationUniforms.uShop,
      uShop2Top: stationUniforms.uShopTop,
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDepth;
      uniform mat4 uProjInv;
      uniform mat4 uCamWorld;
      uniform vec3 uCamPos;
      uniform float uTime;
      uniform float uDensity;
      uniform float uFalloff;
      uniform vec3 uAmbient;
      uniform vec3 uWind;
      uniform vec4 uLightPos[${FOG_LIGHTS}];
      uniform vec4 uLightCol[${FOG_LIGHTS}];
      uniform float uFrame;
      uniform vec4 uShop;
      uniform float uShopTop;
      uniform vec4 uShop2;
      uniform float uShop2Top;
      varying vec2 vUv;
      ${NOISE}

      const int STEPS = 36;
      const float MAX_DIST = 140.0;

      float density(vec3 p, float t) {
        // No weather inside the shop
        if ((p.x > uShop.x && p.x < uShop.z && p.z > uShop.y && p.z < uShop.w && p.y < uShopTop) ||
            (p.x > uShop2.x && p.x < uShop2.z && p.z > uShop2.y && p.z < uShop2.w && p.y < uShop2Top)) return 0.0;
        float h = exp(-max(p.y, 0.0) * uFalloff);
        vec3 q = p * 0.045 + uWind * uTime * 0.02;
        float n = noise3(q) * 0.65 + noise3(q * 2.7 + 4.0) * 0.35;
        // Close to the camera the fog stays even: drifting clumps there read as moving shadows on walls and snow
        float clumps = smoothstep(6.0, 30.0, t);
        return uDensity * h * mix(1.0, 0.45 + n * 1.1, clumps);
      }

      vec3 lamps(vec3 p, vec3 rd) {
        vec3 sum = vec3(0.0);
        for (int i = 0; i < ${FOG_LIGHTS}; i++) {
          vec4 L = uLightPos[i];
          vec4 C = uLightCol[i];
          vec3 d = p - L.xyz;
          float d2 = dot(d, d);
          vec3 dir = d * inversesqrt(d2 + 1e-4);
          float spot = C.w > 0.5 ? 1.0 : smoothstep(0.25, 0.75, -dir.y) + 0.12;
          float mu = dot(dir, -rd);
          float g = 0.45;
          float phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.25 + 0.1;
          sum += C.rgb * L.w * spot * phase * 50.0 / (d2 * 1.1 + 0.35);
        }
        return sum;
      }

      void main() {
        float depth = texture2D(tDepth, vUv).r;
        vec4 clip = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
        vec4 view = uProjInv * clip;
        view /= view.w;
        vec3 world = (uCamWorld * view).xyz;
        vec3 rd = normalize(world - uCamPos);
        float dist = depth >= 0.99999 ? 1000.0 : length(world - uCamPos);
        float march = min(dist, MAX_DIST);

        float jitter = fract(sin(dot(gl_FragCoord.xy + uFrame * 7.13, vec2(12.9898, 78.233))) * 43758.5453);
        vec3 scatter = vec3(0.0);
        float T = 1.0;
        float prev = 0.0;
        for (int i = 1; i <= STEPS; i++) {
          float f = (float(i) - 1.0 + jitter) / float(STEPS);
          float t = march * f * f;
          float dt = t - prev;
          prev = t;
          vec3 p = uCamPos + rd * t;
          float s = density(p, t);
          vec3 light = uAmbient + lamps(p, rd);
          float a = exp(-s * dt);
          scatter += T * light * (1.0 - a);
          T *= a;
        }
        if (dist > march) {
          float far = uDensity * 0.85 * exp(-max(uCamPos.y + rd.y * 40.0, 0.0) * uFalloff);
          float a = exp(-far * (dist - march));
          scatter += T * uAmbient * (1.0 - a);
          T *= a;
        }
        gl_FragColor = vec4(scatter, T);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
}

export class CompositePass extends Pass {
  private quad: FullScreenQuad;
  material: THREE.ShaderMaterial;

  constructor() {
    super();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tFog: { value: null },
        tOverlay: { value: null },
        tDepth: { value: null },
        uFogSize: { value: new THREE.Vector2(1, 1) },
        uNear: { value: 0.05 },
        uFar: { value: 1200 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene;
        uniform sampler2D tFog;
        uniform sampler2D tOverlay;
        uniform sampler2D tDepth;
        uniform vec2 uFogSize;
        uniform float uNear;
        uniform float uFar;
        varying vec2 vUv;
        float viewZ(float d) {
          return uNear * uFar / (uFar - d * (uFar - uNear));
        }
        // The fog is rendered at half resolution: upsample it from the texels whose depth matches this pixel's, so a
        // window frame, a lamp post or a doorway never picks up the fog (or the clear air) from just beside it
        vec4 fogAt(vec2 uv) {
          float z0 = viewZ(texture2D(tDepth, uv).r);
          vec2 p = uv * uFogSize - 0.5;
          vec2 base = floor(p);
          vec2 f = p - base;
          vec4 sum = vec4(0.0);
          float wsum = 0.0;
          for (int i = 0; i < 4; i++) {
            vec2 o = vec2(float(i - (i / 2) * 2), float(i / 2));
            vec2 tuv = (base + o + 0.5) / uFogSize;
            float z = viewZ(texture2D(tDepth, tuv).r);
            vec2 bw2 = mix(1.0 - f, f, o);
            float w = bw2.x * bw2.y * exp(-abs(z - z0) / max(z0, 0.1) * 12.0) + 1e-5;
            sum += texture2D(tFog, tuv) * w;
            wsum += w;
          }
          return sum / wsum;
        }
        // NaN/Inf pixels (e.g. half-float overflow on sharp highlights) get smeared by bloom into black flashes
        float finite(float x) {
          return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u ? 0.0 : x;
        }
        vec3 clean(vec3 c) {
          return clamp(vec3(finite(c.r), finite(c.g), finite(c.b)), 0.0, 40.0);
        }
        void main() {
          vec3 scene = clean(texture2D(tScene, vUv).rgb);
          vec4 fog = fogAt(vUv);
          fog = vec4(clean(fog.rgb), clamp(finite(fog.a), 0.0, 1.0));
          vec3 overlay = clean(texture2D(tOverlay, vUv).rgb);
          gl_FragColor = vec4(scene * fog.a + fog.rgb + overlay, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget) {
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}
