import { useFrame, useThree } from '@react-three/fiber';
import { EffectComposer, EffectComposerContext, Noise, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing';
import { AerialPerspective } from '@takram/three-atmosphere/r3f';
import { Dithering, LensFlare } from '@takram/three-geospatial-effects/r3f';
import type { AerialPerspectiveEffect } from '@takram/three-atmosphere';
import {
  BlendFunction,
  EffectMaterial,
  ToneMappingMode,
  type EffectComposer as EffectComposerImpl,
  type NormalPass,
} from 'postprocessing';
import { useCallback, useContext, useLayoutEffect, useRef, type FC } from 'react';
import { HalfFloatType, type WebGLRenderTarget } from 'three';
import { getDestination } from '../camera/destinations';
import { ecefToGeodetic } from '../geo/wgs84';
import { FLAGS } from '../config';
import { useFlytake } from '../state/store';
import { albedoForHeight, gradeForHeight } from './exposure';
import { Grade, type GradeEffect } from './GradeEffect';
import { patchCloudShadow, patchEffect, patchHaze } from './patchAtmosphere';
import { CLOUDS_ENABLED, SkyClouds } from './SkyClouds';

const TONE_MAPPING = {
  agx: ToneMappingMode.AGX,
  aces: ToneMappingMode.ACES_FILMIC,
  neutral: ToneMappingMode.NEUTRAL,
} as const;

/** The normal buffer must be half-float for the atmosphere's lighting (8-bit bands). */
const HalfFloatNormals: FC = () => {
  const { normalPass } = useContext(EffectComposerContext);
  useLayoutEffect(() => {
    if (normalPass != null) {
      (normalPass as NormalPass & { renderTarget: WebGLRenderTarget }).renderTarget.texture.type = HalfFloatType;
    }
  }, [normalPass]);
  return null;
};

const geo = { lat: 0, lon: 0, height: 0 };

/** ?albedo= is a multiplier on the scripted albedo, 1.4 being the neutral default. */
const ALBEDO_FLAG_SCALE = FLAGS.albedoScale / 1.4;

/**
 * Post stack (order matters):
 *  Clouds            - volumetric cumulus (SkyClouds.tsx), composited by AerialPerspective
 *                      (overlay), with cloud shadows and light shafts
 *  AerialPerspective - golden-hour sun relighting of the (albedo) tiles, haze / inscatter.
 *                      Sun-only relighting reads as golden hour; adding sky irradiance on flat
 *                      sphere normals turned everything blue-grey (A/B: ?light=sunsky).
 *                      The sky itself is the <Sky> quad in Experience.tsx (keeps the stars).
 *  LensFlare         - sun glare + HDR bloom of the sun disk
 *                      Albedo and exposure are scripted by height (exposure.ts); the near-ground
 *                      haze is thinned a little (patchHaze) so the Carson Range separates from the sky.
 *  ToneMapping AgX   - exposure comes from gl.toneMappingExposure (scripted by height)
 *  Grade             - white balance, gamma-space contrast, golden-hour split tone, saturation
 *                      (see gradeForHeight and GradeEffect)
 *  SMAA              - anti-aliasing (MSAA would mismatch the depth buffer the atmosphere reads)
 *  Vignette, Noise   - subtle film touches
 *  Dithering         - removes 8-bit banding in the sky gradients
 */
export const PostFX: FC = () => {
  const composerRef = useRef<EffectComposerImpl>(null);
  const aerialRef = useRef<AerialPerspectiveEffect | null>(null);
  const gradeRef = useRef<GradeEffect>(null);
  const camera = useThree((s) => s.camera);

  const setAerialPerspective = useCallback((effect: AerialPerspectiveEffect | null) => {
    aerialRef.current = effect;
    if (effect) {
      patchEffect(effect);
      if (FLAGS.haze) patchHaze(effect);
      patchCloudShadow(effect);
    }
  }, []);

  // Effects copy near/far by value; refresh them every frame after the camera has moved
  // (director at -2, GlobeControls at -1) and before the composer renders (1).
  useFrame(() => {
    composerRef.current?.passes.forEach((pass) => {
      if (pass.fullscreenMaterial instanceof EffectMaterial) pass.fullscreenMaterial.adoptCameraSettings(camera);
    });
    const surface = getDestination(useFlytake.getState().destinationId).surfaceHeight;
    const height = ecefToGeodetic(camera.position, geo).height - surface;
    if (aerialRef.current) aerialRef.current.albedoScale = albedoForHeight(height) * ALBEDO_FLAG_SCALE;
    const grade = gradeForHeight(height);
    gradeRef.current?.setGrade(grade.contrast + FLAGS.contrast, grade.saturation + FLAGS.saturation, grade.warmth, grade.wb);
  }, 0);

  return (
    <EffectComposer ref={composerRef} multisampling={0} enableNormalPass={FLAGS.normals === 'generated'}>
      {FLAGS.normals === 'generated' ? <HalfFloatNormals /> : <></>}
      {CLOUDS_ENABLED ? <SkyClouds /> : <></>}
      <AerialPerspective
        ref={setAerialPerspective}
        stbnTexture="/clouds/stbn.bin"
        sunLight={FLAGS.light !== 'none'}
        skyLight={FLAGS.light === 'sunsky'}
        correctGeometricError
        reconstructNormal={FLAGS.normals === 'reconstruct'}
      />
      <LensFlare />
      <ToneMapping mode={TONE_MAPPING[FLAGS.toneMapping]} />
      <Grade ref={gradeRef} />
      <SMAA />
      <Vignette offset={0.3} darkness={0.45} />
      <Noise premultiply blendFunction={BlendFunction.SCREEN} opacity={0.05} />
      <Dithering />
    </EffectComposer>
  );
};
