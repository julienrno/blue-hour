import * as THREE from "three";

type RoadMaps = { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture; halfWidth: number; tileLength: number; zRange: [number, number] };
type SnowOptions = { coat?: number; sparkle?: number; coatNoise?: number; detail?: boolean; contact?: number; road?: RoadMaps };

// Ground height baked into a texture (filled in by the city) so shaders know where the snow surface is
export const groundUniforms = {
  uGroundTex: { value: null as THREE.Texture | null },
  uGroundBox: { value: new THREE.Vector4(0, 0, 1, 1) },
};

const NOISE = /* glsl */ `
  float snHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float snNoise(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(snHash(i), snHash(i + vec3(1,0,0)), f.x), mix(snHash(i + vec3(0,1,0)), snHash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(snHash(i + vec3(0,0,1)), snHash(i + vec3(1,0,1)), f.x), mix(snHash(i + vec3(0,1,1)), snHash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
`;

export function snowify<T extends THREE.MeshStandardMaterial>(mat: T, opts: SnowOptions): T {
  const coat = opts.coat ?? 0;
  const sparkle = opts.sparkle ?? 0;
  const coatNoise = opts.coatNoise ?? 0.25;
  const detail = opts.detail ?? false;
  const contact = opts.contact ?? 0;
  const road = opts.road;
  mat.customProgramCacheKey = () => `snow-${coat > 0}-${sparkle > 0}-${detail}-${contact > 0}-${!!road}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCoat = { value: coat };
    shader.uniforms.uContact = { value: contact };
    shader.uniforms.uGroundTex = groundUniforms.uGroundTex;
    shader.uniforms.uGroundBox = groundUniforms.uGroundBox;
    shader.uniforms.uCoatNoise = { value: coatNoise };
    shader.uniforms.uSparkle = { value: sparkle };
    if (road) {
      shader.uniforms.uRoadMap = { value: road.map };
      shader.uniforms.uRoadNormal = { value: road.normalMap };
      shader.uniforms.uRoadRough = { value: road.roughnessMap };
      shader.uniforms.uRoad = { value: new THREE.Vector4(road.halfWidth, road.tileLength, road.zRange[0], road.zRange[1]) };
    }
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSnowPos;")
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
        #ifdef USE_INSTANCING
          vSnowPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vSnowPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`
      );
    let frag = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
      varying vec3 vSnowPos;
      uniform float uCoat;
      uniform float uCoatNoise;
      uniform float uSparkle;
      uniform float uContact;
      uniform sampler2D uGroundTex;
      uniform vec4 uGroundBox;
      ${NOISE}`
    );
    if (detail) {
      // Second, rotated sample of the same normal map plus a low-frequency albedo wash hide the tiling
      frag = frag
        .replace(
          "#include <normal_fragment_maps>",
          THREE.ShaderChunk.normal_fragment_maps.replace(
            "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
            `vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
            vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * vNormalMapUv * 0.37 + vec2(0.31, 0.17);
            vec3 mapN2 = texture2D( normalMap, uv2 ).xyz * 2.0 - 1.0;
            mapN = normalize(vec3(mapN.xy + mapN2.xy, mapN.z * mapN2.z));`
          )
        )
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
          {
            float wash = snNoise(vec3(vSnowPos.xz * 0.12, 0.0)) * 0.6 + snNoise(vec3(vSnowPos.xz * 0.5, 3.0)) * 0.4;
            diffuseColor.rgb *= 0.93 + wash * 0.1;
          }`
        );
    }
    if (road) {
      // The road is painted into the ground itself, so ruts fade into the plowed banks with no seam
      frag = frag
        .replace(
          "#include <map_pars_fragment>",
          `#include <map_pars_fragment>
          uniform sampler2D uRoadMap;
          uniform sampler2D uRoadNormal;
          uniform sampler2D uRoadRough;
          uniform vec4 uRoad;
          float roadMask() {
            float edge = abs(vSnowPos.x) + (snNoise(vec3(vSnowPos.z * 0.35, 0.0, 1.3)) - 0.5) * 0.9 + (snNoise(vec3(vSnowPos.xz * 2.5, 4.1)) - 0.5) * 0.25;
            float along = smoothstep(uRoad.z, uRoad.z + 4.0, vSnowPos.z) * (1.0 - smoothstep(uRoad.w - 4.0, uRoad.w, vSnowPos.z));
            return (1.0 - smoothstep(uRoad.x - 1.1, uRoad.x + 0.5, edge)) * along;
          }
          vec2 roadUv() { return vec2((vSnowPos.x + uRoad.x) / (2.0 * uRoad.x), -vSnowPos.z / uRoad.y); }`
        )
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
          float roadK = roadMask();
          diffuseColor.rgb = mix(diffuseColor.rgb, texture2D(uRoadMap, roadUv()).rgb, roadK);`
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, texture2D(uRoadRough, roadUv()).g, roadK);`
        )
        .replace(
          "mapN.xy *= normalScale;",
          `mapN = normalize(mix(mapN, texture2D(uRoadNormal, roadUv()).xyz * 2.0 - 1.0, roadK));
          mapN.xy *= normalScale;`
        );
    }
    if (coat > 0) {
      frag = frag.replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          vec3 wN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          float n = snNoise(vSnowPos * 3.0) * 0.6 + snNoise(vSnowPos * 11.0) * 0.4;
          float s = smoothstep(1.0 - uCoat, 1.0 - uCoat + 0.18, wN.y + (n - 0.5) * uCoatNoise);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.9, 0.98), s);
          roughnessFactor = mix(roughnessFactor, 0.78, s);
          metalnessFactor = mix(metalnessFactor, 0.0, s);
        }`
      );
    }
    if (contact > 0) {
      // Snow banked against anything standing in it: a noisy band above the ground, shaded like the ground
      frag = frag.replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          float ground = texture2D(uGroundTex, (vSnowPos.xz - uGroundBox.xy) / uGroundBox.zw).r;
          float above = vSnowPos.y - ground;
          float n = snNoise(vec3(vSnowPos.xz * 1.1, 0.0)) * 0.6 + snNoise(vec3(vSnowPos.xz * 6.0, 1.7)) * 0.25 + snNoise(vSnowPos * 22.0) * 0.15;
          float drift = uContact * (0.3 + n);
          float c = 1.0 - smoothstep(drift * 0.9, drift, above);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.91, 0.98), c);
          roughnessFactor = mix(roughnessFactor, 0.85, c);
          metalnessFactor = mix(metalnessFactor, 0.0, c);
          totalEmissiveRadiance *= 1.0 - c;
          vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          normal = normalize(mix(normal, upView, c * 0.6));
        }`
      );
    }
    if (sparkle > 0) {
      frag = frag.replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
        {
          vec3 cell = floor(vSnowPos * 70.0);
          float h = snHash(cell);
          vec3 rn = normalize(vec3(snHash(cell + 1.3) * 2.0 - 1.0, snHash(cell + 7.1) + 0.2, snHash(cell + 3.7) * 2.0 - 1.0));
          vec3 v = normalize(cameraPosition - vSnowPos);
          float facing = pow(max(dot(reflect(-v, rn), normalize(vec3(0.0, 1.0, 0.0) + v * 0.3)), 0.0), 40.0);
          float lum = dot(gl_FragColor.rgb, vec3(0.333));
          float d = distance(cameraPosition, vSnowPos);
          float g = step(0.985, h) * facing * smoothstep(0.08, 0.6, lum) * (1.0 - smoothstep(3.0, 22.0, d));
          gl_FragColor.rgb += vec3(0.85, 0.95, 1.0) * g * uSparkle * 6.0;
        }`
      );
    }
    shader.fragmentShader = frag;
  };
  return mat;
}
