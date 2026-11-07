import { wrapEffect } from '@react-three/postprocessing';
import { Effect } from 'postprocessing';
import { Uniform, Vector3 } from 'three';

/**
 * Final colour grade, after tone mapping (input is display-referred linear, 0..1):
 *  - white balance multipliers
 *  - S-curve contrast applied in gamma space, so it pivots around the perceptual mid-grey
 *    (postprocessing's BrightnessContrast pivots at 0.5 in linear light, so "more contrast"
 *    mostly darkened the mid-tones)
 *  - golden-hour split tone: cool shadows, warm highlights
 *  - saturation around Rec.709 luminance
 * Values are driven every frame by height (see gradeForHeight).
 */
const fragmentShader = /* glsl */ `
uniform vec3 wb;
uniform float contrast;
uniform float saturation;
uniform float warmth;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb * wb, 0.0);
  vec3 s = pow(c, vec3(1.0 / 2.2));
  s = mix(s, s * s * (3.0 - 2.0 * s), contrast);
  c = pow(clamp(s, 0.0, 1.0), vec3(2.2));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= mix(vec3(1.0), mix(vec3(0.96, 1.0, 1.05), vec3(1.06, 1.0, 0.90), smoothstep(0.02, 0.35, l)), warmth);
  outputColor = vec4(clamp(mix(vec3(l), c, 1.0 + saturation), 0.0, 1.0), inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', fragmentShader, {
      uniforms: new Map<string, Uniform>([
        ['wb', new Uniform(new Vector3(1, 1, 1))],
        ['contrast', new Uniform(0)],
        ['saturation', new Uniform(0)],
        ['warmth', new Uniform(0)],
      ]),
    });
  }

  setGrade(contrast: number, saturation: number, warmth: number, wb: readonly [number, number, number]): void {
    this.uniforms.get('contrast')!.value = contrast;
    this.uniforms.get('saturation')!.value = saturation;
    this.uniforms.get('warmth')!.value = warmth;
    (this.uniforms.get('wb')!.value as Vector3).set(wb[0], wb[1], wb[2]);
  }
}

export const Grade = wrapEffect(GradeEffect);
