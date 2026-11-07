/**
 * Bay Bridge night lights:
 *  - The Bay Lights (Leo Villareal, 2013): white LEDs strung along every vertical suspender on the
 *    city-facing (north-west) side of the west span, animated with slow travelling waves, falling
 *    "rain" and sparkle.
 *  - Roadway lamps on the upper deck, sodium-orange lights inside the lower deck, red aviation beacons.
 * All are additive THREE.Points whose brightness follows uLmNight (night / exposure).
 */
import * as THREE from 'three';
import { lmUniforms } from '../common/materials';
import type { Suspender } from './structure';

/** Points material with a screen-size floor (never sub-pixel) and an energy-preserving fade. */
function pointsMaterial(color: THREE.ColorRepresentation, size: number, ledAnim: boolean): THREE.PointsMaterial {
  const m = new THREE.PointsMaterial({
    color,
    size,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // Additive points must not be fogged (fog would add its colour as visible dots by day).
    fog: false,
  });
  const u = { uLmNight: lmUniforms.uLmNight, uLmTime: lmUniforms.uLmTime, uGain: { value: 1 } };
  m.userData.u = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uLmNight;
uniform float uLmTime;
uniform float uGain;
attribute vec2 aLed;
varying float vBright;
float hh( float n ) { return fract( sin( n ) * 43758.5453 ); }`,
      )
      .replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>
{
  float b = 1.0;
  ${
    ledAnim
      ? `// aLed.x = position along the bridge (m), aLed.y = 0..1 up the suspender.
  float wave = 0.5 + 0.5 * sin( aLed.x * 0.012 - uLmTime * 0.55 );
  float rain = fract( aLed.y * 1.6 + uLmTime * 0.22 + hh( floor( aLed.x / 9.0 ) ) );
  rain = smoothstep( 0.75, 1.0, rain ) ;
  float sparkle = step( 0.985, hh( floor( uLmTime * 6.0 ) + aLed.x * 1.7 + aLed.y * 91.0 ) );
  b = 0.05 + 0.5 * wave * wave + 0.8 * rain + 1.2 * sparkle;`
      : ''
  }
  // Keep at least ~1.6 px; dim the colour by the area we inflated so far lights don't bloom up.
  float px = gl_PointSize;
  gl_PointSize = clamp( px, 1.6, 9.0 );
  vBright = b * uLmNight * uGain * clamp( px * px / ( gl_PointSize * gl_PointSize ), 0.03, 1.0 );
}`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBright;')
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot( pc, pc );
  if ( r2 > 1.0 ) discard;
  vec4 diffuseColor = vec4( diffuse * vBright * ( 1.0 - r2 * 0.6 ), opacity );`,
      );
  };
  return m;
}

function points(pts: THREE.Vector3[], mat: THREE.PointsMaterial, led?: number[]): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap((p) => [p.x, p.y, p.z]), 3));
  g.setAttribute('aLed', new THREE.Float32BufferAttribute(led ?? new Array(pts.length * 2).fill(0), 2));
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false;
  return p;
}

export interface BridgeLights {
  group: THREE.Group;
  update(t: number): void;
}

export function buildLights(susp: Suspender[], roadLamps: THREE.Vector3[], lowerLamps: THREE.Vector3[], beacons: THREE.Vector3[]): BridgeLights {
  const group = new THREE.Group();
  group.name = 'bay-bridge-lights';
  // The Bay Lights: north-west (city-facing) suspenders only, one LED every 0.9 m.
  const leds: THREE.Vector3[] = [];
  const led: number[] = [];
  for (const s of susp) {
    if (s.side !== -1) continue;
    const len = s.top.distanceTo(s.bottom);
    const n = Math.max(2, Math.floor(len / 0.9));
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      // Slightly outboard of the cable so they read from the city side.
      leds.push(s.bottom.clone().lerp(s.top, u));
      led.push(s.s, u);
    }
  }
  const ledMat = pointsMaterial('#f4f7ff', 0.55, true);
  ledMat.userData.u.uGain.value = 4.0;
  group.add(points(leds, ledMat, led));
  const lampMat = pointsMaterial('#ffe2b4', 1.4, false);
  lampMat.userData.u.uGain.value = 5.0;
  group.add(points(roadLamps, lampMat));
  const lowerMat = pointsMaterial('#ff9a3c', 1.2, false);
  lowerMat.userData.u.uGain.value = 4.0;
  group.add(points(lowerLamps, lowerMat));
  const beaconMat = pointsMaterial('#ff1a08', 2.4, false);
  group.add(points(beacons, beaconMat));
  return {
    group,
    update(t) {
      group.visible = lmUniforms.uLmNight.value > 1e-5;
      // ~30 flashes per minute, all towers in sync.
      beaconMat.userData.u.uGain.value = (t * 0.5) % 1 < 0.45 ? 9 : 0.3;
    },
  };
}
