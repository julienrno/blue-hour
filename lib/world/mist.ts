import * as THREE from "three";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";

const VERT = "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

// Dual-filter (Kawase) blur: a quarter-res copy blurred a few times reads like an out-of-focus lens, not a box blur
const KAWASE = new THREE.ShaderMaterial({
  uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uOffset: { value: 0 } },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    uniform float uOffset;
    varying vec2 vUv;
    void main() {
      vec2 o = (uOffset + 0.5) * uTexel;
      vec3 c = texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb
             + texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb;
      gl_FragColor = vec4(c * 0.25, 1.0);
    }
  `,
  depthTest: false,
  depthWrite: false,
});

const COMPOSITE = new THREE.ShaderMaterial({
  uniforms: {
    tDiffuse: { value: null },
    tBlur: { value: null },
    uMist: { value: 1 },
    uTime: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tBlur;
    uniform float uMist;
    uniform float uTime;
    uniform float uAspect;
    varying vec2 vUv;

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float fbm(vec2 p) {
      float s = 0.0;
      float a = 0.5;
      for (int i = 0; i < 4; i++) {
        s += a * noise(p);
        p = p * 2.03 + 7.1;
        a *= 0.5;
      }
      return s;
    }

    void main() {
      vec2 ca = (vUv - 0.5) * vec2(uAspect, 1.0);
      float r = length(ca);
      // Drifting, self-warped mist: it rolls slowly sideways instead of sitting on the lens
      vec2 q = ca * 1.7 + vec2(uTime * 0.035, uTime * 0.01);
      vec2 w = vec2(fbm(q * 1.6 + 3.1 + uTime * 0.02), fbm(q * 1.6 - 1.7 - uTime * 0.015));
      float n = fbm(q + w * 0.8);

      // The mist parts from the middle of the frame outward along a ragged front
      float front = mix(-0.55, 1.9, 1.0 - uMist);
      float amount = smoothstep(front - 0.5, front + 0.05, r + (n - 0.5) * 0.8) * min(uMist * 4.0, 1.0);

      vec3 sharp = texture2D(tDiffuse, vUv).rgb;
      vec3 blur = texture2D(tBlur, vUv).rgb;
      vec3 col = mix(sharp, blur, smoothstep(0.0, 0.6, amount));
      // The veil takes its light from the scene behind it, so lamps glow through and dark areas stay cool
      vec3 veil = blur * 1.15 + vec3(0.035, 0.045, 0.07) * (0.5 + n);
      col = mix(col, veil, amount * (0.3 + 0.45 * n));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
  depthTest: false,
  depthWrite: false,
});

/**
 * Intro "out of the mist" pass: the frame starts behind a soft, drifting veil that thins from the centre outward.
 * Disabled (zero cost) once the mist has cleared.
 */
export class MistPass extends Pass {
  uniforms = COMPOSITE.uniforms;
  private a: THREE.WebGLRenderTarget;
  private b: THREE.WebGLRenderTarget;
  private quad = new FullScreenQuad();

  constructor() {
    super();
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.a = new THREE.WebGLRenderTarget(1, 1, opts);
    this.b = new THREE.WebGLRenderTarget(1, 1, opts);
  }

  setSize(width: number, height: number) {
    const w = Math.max(1, Math.round(width / 4));
    const h = Math.max(1, Math.round(height / 4));
    this.a.setSize(w, h);
    this.b.setSize(w, h);
    KAWASE.uniforms.uTexel.value.set(1 / w, 1 / h);
    COMPOSITE.uniforms.uAspect.value = width / height;
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    let src: THREE.Texture = readBuffer.texture;
    let dst = this.a;
    let other = this.b;
    this.quad.material = KAWASE;
    for (const offset of [0, 1, 2, 3, 4]) {
      KAWASE.uniforms.tSrc.value = src;
      KAWASE.uniforms.uOffset.value = offset;
      renderer.setRenderTarget(dst);
      this.quad.render(renderer);
      src = dst.texture;
      [dst, other] = [other, dst];
    }
    this.quad.material = COMPOSITE;
    COMPOSITE.uniforms.tDiffuse.value = readBuffer.texture;
    COMPOSITE.uniforms.tBlur.value = src;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.a.dispose();
    this.b.dispose();
    this.quad.dispose();
  }
}
