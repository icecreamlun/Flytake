/**
 * San Francisco Bay: one huge plane at sea level (y = 0) that follows the camera to the horizon and
 * sits under the terrain (land above 0 simply occludes it).
 *
 * Built on MeshStandardMaterial (so it gets IBL reflections of the sky, the GGX sun glitter path,
 * received shadows and the shared aerial-perspective fog for free) with an onBeforeCompile patch:
 *  - four scrolling octaves of a tiling normal map, flattened with distance (no shimmer at range),
 *  - roughness that rises with distance AND with the screen-space variance of the wave normal
 *    (Toksvig / Kaplanyan specular AA), plus a soft cap on the specular peak — the sun glitter is a
 *    broad shimmering path instead of single-pixel white fireflies,
 *  - body colour from water depth (terrain sampled into a small texture): murky grey-green in the
 *    deep bay, a turbid olive-grey (silt) over the shallows / near the sea walls — SF Bay, not the
 *    Caribbean.
 * Reflections of the city and its lights come from the screen-space pass (waterReflection.ts).
 */
import * as THREE from 'three';

export interface DepthSource {
  ground: (x: number, z: number) => number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export class BayWater {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  private readonly uniforms = {
    uTime: { value: 0 },
    uWaterNormals: { value: null as THREE.Texture | null },
    uDepthTex: { value: null as THREE.Texture | null },
    uDepthBox: { value: new THREE.Vector4(0, 0, 1, 1) },
    uDeep: { value: new THREE.Color() },
    uShallow: { value: new THREE.Color() },
    uNight: { value: 0 },
  };

  constructor() {
    const loader = new THREE.TextureLoader();
    const normals = loader.load('/sf/textures/waternormals.jpg');
    normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
    normals.colorSpace = THREE.NoColorSpace;
    normals.anisotropy = 8;
    this.uniforms.uWaterNormals.value = normals;
    // Placeholder: "deep everywhere" until the terrain depth arrives.
    const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    blank.needsUpdate = true;
    this.uniforms.uDepthTex.value = blank;
    // Linear albedos: deep SF Bay murky grey-green-blue; shallows turbid olive-grey (#4a5a52-ish).
    this.uniforms.uDeep.value.setRGB(0.01, 0.022, 0.028);
    this.uniforms.uShallow.value.setRGB(0.04, 0.049, 0.045);

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0.0, envMapIntensity: 1.0 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWaterWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
varying vec3 vWaterWorld;
uniform float uTime;
uniform sampler2D uWaterNormals;
uniform sampler2D uDepthTex;
uniform vec4 uDepthBox;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uNight;
float gWaterDist;
float gWaterKernel = 0.0;
`,
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
{
	gWaterDist = length( vWaterWorld - cameraPosition );
	vec2 duv = ( vWaterWorld.xz - uDepthBox.xy ) / uDepthBox.zw;
	float inside = step( 0.0, duv.x ) * step( duv.x, 1.0 ) * step( 0.0, duv.y ) * step( duv.y, 1.0 );
	float depth = mix( 25.5, texture2D( uDepthTex, duv ).r * 25.5, inside );
	float shallow = 1.0 - smoothstep( 0.5, 9.0, depth );
	// Turbidity: silt plumes drift through the shallows (large-scale, slow).
	vec2 tp = vWaterWorld.xz / 260.0 + uTime * vec2( 0.002, - 0.001 );
	float silt = texture2D( uWaterNormals, tp ).b * 0.6 + texture2D( uWaterNormals, tp * 0.37 + 0.3 ).b * 0.4;
	vec3 body = mix( uDeep, uShallow, shallow * ( 0.75 + 0.5 * silt ) );
	diffuseColor.rgb = mix( body, body * vec3( 1.05, 1.02, 0.94 ), smoothstep( 0.4, 0.75, silt ) * 0.6 );
}`,
        )
        .replace(
          '#include <roughness_fragment>',
          /* glsl */ `float roughnessFactor = mix( 0.04, 0.2, smoothstep( 80.0, 7000.0, gWaterDist ) );`,
        )
        .replace(
          '#include <lights_physical_fragment>',
          '#include <lights_physical_fragment>\nmaterial.roughness = sqrt( clamp( material.roughness * material.roughness + gWaterKernel, 0.0, 1.0 ) );',
        )
        .replace(
          '#include <opaque_fragment>',
          /* glsl */ `{
	// Soft cap on the glitter peak (scene-referred): bright enough to bloom, never a white firefly.
	float l = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
	float cap = 3.0;
	if ( l > cap ) outgoingLight *= ( cap + ( l - cap ) / ( 1.0 + ( l - cap ) * 0.5 ) ) / l;
}
#include <opaque_fragment>`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `{
	vec2 p = vWaterWorld.xz;
	float t = uTime;
	vec2 s = vec2( 0.0 );
	s += ( texture2D( uWaterNormals, p / 37.0 + t * vec2( 0.021, 0.013 ) ).rg * 2.0 - 1.0 ) * 0.55;
	s += ( texture2D( uWaterNormals, p / 13.0 + t * vec2( - 0.034, 0.027 ) ).rg * 2.0 - 1.0 ) * 0.35;
	s += ( texture2D( uWaterNormals, p / 160.0 + t * vec2( 0.006, - 0.009 ) ).rg * 2.0 - 1.0 ) * 0.8;
	s += ( texture2D( uWaterNormals, p / 520.0 + t * vec2( - 0.003, 0.004 ) ).rg * 2.0 - 1.0 ) * 0.6;
	float strength = mix( 0.42, 0.1, smoothstep( 120.0, 6000.0, gWaterDist ) );
	vec3 nW = normalize( vec3( s.x * strength, 1.0, s.y * strength ) );
	normal = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );
	// Specular AA (Kaplanyan & Hoffman): widen the lobe by the normal's variance inside the pixel.
	vec3 ndx = dFdx( nW );
	vec3 ndy = dFdy( nW );
	gWaterKernel = min( 2.0 * ( dot( ndx, ndx ) + dot( ndy, ndy ) ), 0.25 );
}`,
        );
    };
    mat.customProgramCacheKey = () => 'argus-bay-water-v2';
    this.material = mat;

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'bayWater';
    this.mesh.scale.set(160000, 1, 160000);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    // Follow the camera so the bay always reaches the horizon.
    this.mesh.onBeforeRender = (_r, _s, camera) => {
      this.mesh.position.set(Math.round(camera.position.x / 100) * 100, 0, Math.round(camera.position.z / 100) * 100);
      this.mesh.updateMatrixWorld();
    };
  }

  update(elapsed: number, nightFactor: number): void {
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uNight.value = nightFactor;
  }

  /** Bake water depth (0..25.5 m, 0.1 m steps) from the terrain into a small texture. */
  setDepthSource(src: DepthSource, res = 512): void {
    const w = res;
    const h = Math.max(2, Math.round((res * (src.maxZ - src.minZ)) / (src.maxX - src.minX)));
    const data = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      const z = src.minZ + ((j + 0.5) / h) * (src.maxZ - src.minZ);
      for (let i = 0; i < w; i++) {
        const x = src.minX + ((i + 0.5) / w) * (src.maxX - src.minX);
        const d = Math.max(0, -src.ground(x, z));
        data[j * w + i] = Math.min(255, Math.round(d * 10));
      }
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.uniforms.uDepthTex.value?.dispose();
    this.uniforms.uDepthTex.value = tex;
    this.uniforms.uDepthBox.value.set(src.minX, src.minZ, src.maxX - src.minX, src.maxZ - src.minZ);
  }
}
