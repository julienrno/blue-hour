import * as THREE from "three";

// Mean wind (m/s) carrying the snow; gusts scale it up to about 2.3x
export const WIND = new THREE.Vector3(0.75, 0, 0.28);

/** Shared by everything the wind moves; Experience writes them once per frame. */
export const windUniforms = {
  uWindTime: { value: 0 },
  uWindGust: { value: 0 },
};

/**
 * Trees lean and sway with the gusts. The trunk base stays planted (bend grows with height squared),
 * each tree has its own phase, and outer branches tremble a little on their own.
 * Only the drawn position moves: snow coating and shadows keep the rest pose, which is invisible at this amplitude.
 */
export function sway(material: THREE.Material, height: number) {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.uWindTime = windUniforms.uWindTime;
    shader.uniforms.uWindGust = windUniforms.uWindGust;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uWindTime;\nuniform float uWindGust;")
      .replace(
        "#include <project_vertex>",
        /* glsl */ `
        vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        {
          vec3 dir = normalize(vec3(${WIND.x.toFixed(3)}, 0.0, ${WIND.z.toFixed(3)}));
          vec3 side = vec3(-dir.z, 0.0, dir.x);
          #ifdef USE_INSTANCING
            vec3 base = instanceMatrix[3].xyz;
          #else
            vec3 base = vec3(0.0);
          #endif
          float phase = base.x * 0.17 + base.z * 0.13;
          float h = clamp(transformed.y / ${height.toFixed(1)}, 0.0, 1.5);
          float bend = h * h;
          float strength = 0.05 + 0.13 * uWindGust;
          float osc = sin(uWindTime * 1.1 + phase) * 0.6 + sin(uWindTime * 2.3 + phase * 1.7) * 0.25;
          vec3 offset = dir * bend * strength * (0.6 + osc) + side * bend * strength * 0.25 * sin(uWindTime * 0.9 + phase * 2.3);
          // Twigs: the further from the trunk axis, the more they tremble. The phase is the same all along a branch
          // (it only depends on which way the branch points, with a whole multiple so it wraps cleanly),
          // so a branch sways as one piece instead of rippling like a snake
          float reach = length(transformed.xz);
          float heading = atan(transformed.z, transformed.x);
          float twig = reach * (0.006 + 0.01 * uWindGust) * sin(uWindTime * 3.1 + heading * 2.0 + phase);
          offset += vec3(dir.x * twig, twig * 0.5, dir.z * twig);
          mvPosition.xyz += offset;
        }
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
        `
      );
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => key() + "|sway";
  return material;
}
