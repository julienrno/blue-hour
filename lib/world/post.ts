import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { CompositePass } from "./fog";
import { CinematicShader } from "./cinematic";
import { MistPass } from "./mist";

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uFade: { value: 0 },
    uGrain: { value: 0.035 },
    uLens: { value: 0 },
    uRush: { value: 0 },
    uAspect: { value: 16 / 9 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uFade;
    uniform float uGrain;
    uniform float uLens;
    uniform float uRush;
    uniform float uAspect;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main() {
      vec2 uv = vUv;
      // Up high the view bends like a wide lens without showing any more: the middle swells and the edges squeeze,
      // with the frame cropped in so its corners still land inside the picture
      if (uLens > 0.001) {
        vec2 d = (uv - 0.5) * vec2(uAspect, 1.0);
        float corner = dot(vec2(uAspect, 1.0) * 0.5, vec2(uAspect, 1.0) * 0.5);
        float k = 0.32 * uLens;
        float crop = (1.0 - 0.1 * uLens) / (1.0 + k);
        d *= crop * (1.0 + k * dot(d, d) / corner);
        uv = d / vec2(uAspect, 1.0) + 0.5;
      }
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      // Falling hard: the colour fringes spread and the edges close in
      vec2 off = c * r2 * (0.006 + 0.03 * uRush);
      vec3 col = vec3(texture2D(tDiffuse, uv - off).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv + off).b);

      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, col * vec3(0.9, 0.97, 1.08), smoothstep(0.05, 0.6, lum));
      col += vec3(0.004, 0.008, 0.025) * (1.0 - smoothstep(0.0, 0.2, lum));
      col *= 1.0 - smoothstep(0.2 - 0.12 * uRush, 0.9 - 0.3 * uRush, r2 * 1.7) * (0.6 + 0.3 * uRush);

      float g = hash(vUv * vec2(1931.0, 1171.0) + fract(uTime * 7.0)) - 0.5;
      col += g * uGrain * (0.25 + sqrt(max(lum, 0.0)));
      gl_FragColor = vec4(max(col, 0.0) * uFade, 1.0);
    }
  `,
};

export function createPost(renderer: THREE.WebGLRenderer) {
  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);
  const composite = new CompositePass();
  composer.addPass(composite);
  const cinematic = new ShaderPass(CinematicShader);
  composer.addPass(cinematic);
  const mist = new MistPass();
  composer.addPass(mist);
  const bloom = new UnrealBloomPass(size, 0.9, 0.85, 0.7);
  composer.addPass(bloom);
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  composer.addPass(new OutputPass());
  composer.addPass(new SMAAPass());
  return { composer, composite, cinematic, mist, bloom, grade };
}
