import {
  ClampToEdgeWrapping,
  CubeTexture,
  DataArrayTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGFormat,
  Texture,
  UnsignedByteType,
  Vector4,
} from 'three';
import { SCENE_EXTENT } from './scene';

/**
 * Data the lake shader samples (generated offline by tools/water/):
 *  waves.bin  looping FFT wind-wave slopes (64 frames x 256^2, RG8), tileable, see make_waves.py
 *  lake.png   2 m grid over the scene: R sqrt(depth / 80 m), G sqrt(shore distance / 64 m),
 *             B bottom brightness near the shore, A lake coverage (make_lake.py)
 * plus the sky probe (waterSky.ts) and the AerialPerspective albedo scale.
 */
export const WATER_ASSET_UNIFORMS = {
  uWaves: { value: null as DataArrayTexture | null },
  /** (patch size m, frames, loop period s, slope scale of the encoding) */
  uWaveMeta: { value: new Vector4(24, 64, 8, 3.2) },
  uLakeTex: { value: null as Texture | null },
  uLakeBox: {
    value: new Vector4(
      SCENE_EXTENT.east[0],
      SCENE_EXTENT.north[0],
      1 / (SCENE_EXTENT.east[1] - SCENE_EXTENT.east[0]),
      1 / (SCENE_EXTENT.north[1] - SCENE_EXTENT.north[0]),
    ),
  },
  /** 1 once waves.bin and lake.png are loaded */
  uWaterOn: { value: 0 },
  /** sky radiance / sun normal illuminance * pi (pre-lit sky reflection, see waterSky.ts) */
  uSkyProbe: { value: null as CubeTexture | Texture | null },
  uSkyOn: { value: 0 },
  /** 1 / AerialPerspective albedoScale (radiance-true terms must undo the ground boost) */
  uAlbedoInv: { value: 1 / 2.4 },
};

interface WaveMeta {
  size: number;
  patch: number;
  frames: number;
  period: number;
  scale: number;
}

let loading = false;
export function loadWaterAssets(anisotropy: number): void {
  if (loading) return;
  loading = true;
  const waves = (async () => {
    const meta = (await (await fetch('/textures/water/waves.json')).json()) as WaveMeta;
    const buf = await (await fetch('/textures/water/waves.bin')).arrayBuffer();
    const tex = new DataArrayTexture(new Uint8Array(buf), meta.size, meta.size, meta.frames);
    tex.format = RGFormat;
    tex.type = UnsignedByteType;
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = anisotropy;
    tex.colorSpace = NoColorSpace;
    tex.unpackAlignment = 2;
    tex.needsUpdate = true;
    WATER_ASSET_UNIFORMS.uWaves.value = tex;
    WATER_ASSET_UNIFORMS.uWaveMeta.value.set(meta.patch, meta.frames, meta.period, meta.scale);
  })();
  const lake = (async () => {
    // RGBA data, not a picture: no premultiplication, no colour conversion
    const blob = await (await fetch('/textures/water/lake.png')).blob();
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const tex = new Texture(bitmap);
    tex.flipY = false;
    tex.premultiplyAlpha = false;
    tex.colorSpace = NoColorSpace;
    tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = anisotropy;
    tex.needsUpdate = true;
    WATER_ASSET_UNIFORMS.uLakeTex.value = tex;
  })();
  Promise.all([waves, lake])
    .then(() => {
      WATER_ASSET_UNIFORMS.uWaterOn.value = 1;
    })
    .catch((err: unknown) => console.warn('[flytake] water textures failed', err));
}

// look-dev / perf A/B from the devtools console: __flytakeWater.uWaterOn.value = 0
if (typeof window !== 'undefined') (window as unknown as { __flytakeWater?: typeof WATER_ASSET_UNIFORMS }).__flytakeWater = WATER_ASSET_UNIFORMS;
