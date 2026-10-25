import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

const VIEW_Z = /* glsl */ `
  float viewZ(sampler2D depthTex, mat4 projInv, vec2 uv) {
    float d = texture2D(depthTex, uv).r;
    vec4 v = projInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return -v.z / v.w;
  }
`;

/** Auto-focus: a 1x1 target that eases toward the depth at the centre of the screen, like a camera hunting focus. */
export class Focus {
  private targets = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
  private index = 0;
  private quad: FullScreenQuad;
  private material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: null }, tPrev: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uBlend: { value: 0.06 } },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: /* glsl */ `
        uniform sampler2D tDepth;
        uniform sampler2D tPrev;
        uniform mat4 uProjInv;
        uniform float uBlend;
        ${VIEW_Z}
        void main() {
          float z = 0.0;
          for (int i = 0; i < 5; i++) {
            vec2 o = i == 0 ? vec2(0.0) : vec2(i == 1 ? 0.04 : i == 2 ? -0.04 : 0.0, i == 3 ? 0.04 : i == 4 ? -0.04 : 0.0);
            z += clamp(viewZ(tDepth, uProjInv, vec2(0.5) + o), 0.3, 20.0);
          }
          z /= 5.0;
          float prev = texture2D(tPrev, vec2(0.5)).r;
          gl_FragColor = vec4(prev <= 0.0 ? z : mix(prev, z, uBlend), 0.0, 0.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  update(renderer: THREE.WebGLRenderer, depth: THREE.Texture, projInv: THREE.Matrix4) {
    const read = this.targets[this.index];
    const write = this.targets[1 - this.index];
    this.material.uniforms.tDepth.value = depth;
    this.material.uniforms.tPrev.value = read.texture;
    this.material.uniforms.uProjInv.value.copy(projInv);
    renderer.setRenderTarget(write);
    this.quad.render(renderer);
    this.index = 1 - this.index;
    return write.texture;
  }
}

/** Depth of field (auto-focused disk blur) and camera motion blur, sharing one set of taps. */
export const CinematicShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    tFocus: { value: null },
    uProjInv: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uPrevViewProj: { value: new THREE.Matrix4() },
    uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
    uAperture: { value: 3.0 },
    uMaxCoc: { value: 7.0 },
    uShutter: { value: 0.72 },
  },
  vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform sampler2D tFocus;
    uniform mat4 uProjInv;
    uniform mat4 uCamWorld;
    uniform mat4 uPrevViewProj;
    uniform vec2 uTexel;
    uniform float uAperture;
    uniform float uMaxCoc;
    uniform float uShutter;
    varying vec2 vUv;


    const vec2 DISK[12] = vec2[](
      vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
      vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893),
      vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598)
    );

    void main() {
      float d = texture2D(tDepth, vUv).r;
      vec4 v = uProjInv * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      v /= v.w;
      float z = -v.z;
      vec3 world = (uCamWorld * v).xyz;
      vec4 pc = uPrevViewProj * vec4(world, 1.0);
      vec2 prevUv = pc.xy / pc.w * 0.5 + 0.5;
      vec2 vel = (vUv - prevUv) * uShutter;
      float vl = length(vel);
      if (vl > 0.065) vel *= 0.065 / vl;

      float focus = texture2D(tFocus, vec2(0.5)).r;
      float defocus = 1.0 - focus / max(z, 0.05);
      // Background softens like a long lens; the foreground stays crisper so walking never feels myopic
      // The eye settles within the street (never past 20 m), so the far end and the blocks along it go soft while
      // the parked cars just ahead stay close to sharp
      float coc = (defocus > 0.0 ? defocus : -defocus * 0.25) * uAperture;
      // Side vision: the edges of the frame always a little softer than where you look
      vec2 fromCentre = (vUv - 0.5) * vec2(uTexel.y / uTexel.x, 1.0);
      coc += smoothstep(0.25, 0.75, length(fromCentre)) * uAperture * 0.9;
      coc = min(coc, uMaxCoc);

      vec3 center = texture2D(tDiffuse, vUv).rgb;
      if (coc < 0.35 && length(vel / uTexel) < 0.6) {
        gl_FragColor = vec4(center, 1.0);
        return;
      }
      vec3 sum = center;
      // A per-pixel offset along the streak, so long blurs dissolve into grain instead of stepping into copies
      // (only on real streaks: on a still or slow frame it would just sprinkle dots along every hard edge)
      float jitter = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * smoothstep(3.0, 10.0, length(vel / uTexel));
      for (int i = 0; i < 12; i++) {
        float t = (float(i) + 0.5 + jitter) / 12.0 - 0.5;
        sum += texture2D(tDiffuse, vUv + DISK[i] * coc * uTexel + vel * t).rgb;
      }
      gl_FragColor = vec4(sum / 13.0, 1.0);
    }
  `,
};
