/**
 * The flight plan drawn into the city like a game's guide path:
 *  - a glowing ribbon along the preview's flight path, always turned to the camera, with bright
 *    rails, chevrons streaming in the direction of flight and a pulse sweeping the whole plan;
 *    never thinner than a few pixels far away, faded out right in front of the lens;
 *  - a faint x-ray copy that shows through buildings;
 *  - gates at the plan's keyframes (a bigger one at the finish) and height posts down to the ground;
 *  - a beacon on the take-off point: a light column and rings pulsing out over the paving.
 * `drawUntil` / `hideBefore` (metres along the path) let the plan draw itself in, with a bright
 * head, and keep the stretch behind the flying camera out of view.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { FLIGHT_KEYS, PREVIEW_TAKEOFF, flightPolyline } from './previewRoute';

/** Flytake's accent (--accent), pushed above 1 so it glows through the tone map and bloom */
const ROUTE_COLOR = new Color('#f3b562');
const HDR = (k: number) => ROUTE_COLOR.clone().multiplyScalar(k);
/** ribbon half width, m, and the least it may shrink to on screen, px */
const HALF_WIDTH = 0.9;
const MIN_HALF_PX = 2.5;
/** polyline sample step, s (the path is a spline in time) */
const STEP = 0.05;
const POST_SPACING = 30;
const BEACON_HEIGHT = 46;

const RIBBON_VERT = /* glsl */ `
attribute float aSide;
attribute float aDist;
attribute vec3 aTangent;
uniform float uHalfWidth;
uniform float uMinHalfPx;
uniform float uViewportH;
varying float vSide;
varying float vDist;
varying float vCamDist;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 t = normalize(mat3(modelMatrix) * aTangent);
  vec3 toCam = cameraPosition - wp.xyz;
  float d = length(toCam);
  vec3 side = cross(t, toCam / max(d, 1e-3));
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
  // world size of one pixel at this distance
  float px = 2.0 * d / (projectionMatrix[1][1] * uViewportH);
  wp.xyz += side * aSide * max(uHalfWidth, uMinHalfPx * px);
  vSide = aSide;
  vDist = aDist;
  vCamDist = d;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const RIBBON_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uLength;
uniform float uHideBefore;
uniform float uDrawUntil;
uniform float uOpacity;
uniform float uChevrons;
varying float vSide;
varying float vDist;
varying float vCamDist;
void main() {
  if (vDist < uHideBefore || vDist > uDrawUntil) discard;
  float a = abs(vSide);
  float aa = fwidth(vSide) * 1.5;
  // soft core, two bright rails along the edges
  float core = 1.0 - smoothstep(0.35, 1.0, a);
  float rails = smoothstep(0.6 - aa, 0.68, a) * (1.0 - smoothstep(0.86, 0.94 + aa, a));
  // chevrons streaming forward ('>' with the point toward the end of the plan)
  float period = 7.0;
  float c = fract((vDist - uTime * 9.0) / period) + 0.3 * a;
  float fw = fwidth(vDist) / period * 1.5 + 0.004;
  float chev = smoothstep(0.32 - fw, 0.32, c) * (1.0 - smoothstep(0.45, 0.45 + fw, c)) * (1.0 - smoothstep(0.62, 0.72, a)) * uChevrons;
  // a pulse sweeping the plan every few seconds
  float sweepAt = mod(uTime * 70.0, uLength + 300.0) - 100.0;
  float sweep = exp(-pow((vDist - sweepAt) / 12.0, 2.0));
  // bright head while the plan draws itself in
  float head = uDrawUntil < uLength - 0.5 ? exp(-pow((uDrawUntil - vDist) / 6.0, 2.0)) : 0.0;
  // never in the lens; a little thinner far away
  float near = smoothstep(3.0, 16.0, vCamDist);
  float alpha = (0.16 * core + 0.85 * rails + 0.95 * chev + 0.55 * sweep * core + head) * near * uOpacity;
  vec3 col = uColor * (0.7 + 1.5 * chev + 0.8 * rails + 1.6 * sweep + 2.4 * head);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

/**
 * Height posts and the beacon: a vertical fade, hidden outside the drawn range and, for the posts,
 * close to the camera (they map the plan from afar but would stripe a shot flown along it).
 */
const FADE_VERT = /* glsl */ `
attribute float aDist;
attribute float aFade;
varying float vDist;
varying float vFade;
varying float vCamDist;
void main() {
  vDist = aDist;
  vFade = aFade;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vCamDist = distance(wp.xyz, cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const FADE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uHideBefore;
uniform float uDrawUntil;
uniform vec2 uNearFade;
varying float vDist;
varying float vFade;
varying float vCamDist;
void main() {
  if (vDist < uHideBefore || vDist > uDrawUntil) discard;
  float near = uNearFade.y > 0.0 ? smoothstep(uNearFade.x, uNearFade.y, vCamDist) : 1.0;
  gl_FragColor = vec4(uColor, vFade * vFade * uOpacity * near);
}
`;

export class RouteLine {
  readonly object = new Group();
  /** total path length, m */
  readonly length: number;
  /** distance flown at each 0.1 s of the flight (for hideBefore) */
  readonly distance: number[];
  private readonly clip = { hideBefore: { value: 0 }, drawUntil: { value: Number.POSITIVE_INFINITY } };
  private readonly time = { value: 0 };
  private readonly viewportH = { value: 900 };
  private readonly gates: Array<{ mesh: Group; dist: number; phase: number }> = [];
  private readonly pulse: Mesh[] = [];
  private seconds = 0;

  constructor() {
    const { points, distance } = flightPolyline(STEP);
    // distance at every 0.1 s, as before (preview.ts maps flight time to it)
    const every = Math.round(0.1 / STEP);
    this.distance = distance.filter((_, i) => i % every === 0);
    this.length = distance[distance.length - 1]!;

    const ribbon = this.ribbonGeometry(points, distance);
    const front = new Mesh(ribbon, this.ribbonMaterial(1, true));
    const xray = new Mesh(ribbon, this.ribbonMaterial(0.22, false));
    xray.renderOrder = 10;
    front.renderOrder = 12;
    front.frustumCulled = xray.frustumCulled = false;

    this.object.name = 'sfRoute';
    this.object.add(xray, front, this.posts(points, distance), this.beacon());
    this.addGates(points, distance);
    this.object.visible = false;
  }

  private ribbonGeometry(points: Vector3[], distance: number[]): BufferGeometry {
    const n = points.length;
    const pos = new Float32Array(n * 6);
    const tan = new Float32Array(n * 6);
    const side = new Float32Array(n * 2);
    const dist = new Float32Array(n * 2);
    const t = new Vector3();
    for (let i = 0; i < n; i++) {
      const p = points[i]!;
      t.subVectors(points[Math.min(n - 1, i + 1)]!, points[Math.max(0, i - 1)]!).normalize();
      for (let k = 0; k < 2; k++) {
        const j = i * 2 + k;
        pos.set([p.x, p.y, p.z], j * 3);
        tan.set([t.x, t.y, t.z], j * 3);
        side[j] = k === 0 ? -1 : 1;
        dist[j] = distance[i]!;
      }
    }
    const index: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aTangent', new BufferAttribute(tan, 3));
    g.setAttribute('aSide', new BufferAttribute(side, 1));
    g.setAttribute('aDist', new BufferAttribute(dist, 1));
    g.setIndex(index);
    return g;
  }

  private ribbonMaterial(opacity: number, depthTest: boolean): ShaderMaterial {
    return new ShaderMaterial({
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      uniforms: {
        uColor: { value: HDR(1.5) },
        uTime: this.time,
        uLength: { value: this.length },
        uHideBefore: this.clip.hideBefore,
        uDrawUntil: this.clip.drawUntil,
        uOpacity: { value: opacity },
        uChevrons: { value: depthTest ? 1 : 0.5 },
        uHalfWidth: { value: HALF_WIDTH },
        uMinHalfPx: { value: MIN_HALF_PX },
        uViewportH: this.viewportH,
      },
      transparent: true,
      depthTest,
      depthWrite: false,
      side: DoubleSide,
    });
  }

  private fadeMaterial(color: Color, opacity: number, blending = false, nearFade: [number, number] = [0, 0]): ShaderMaterial {
    return new ShaderMaterial({
      vertexShader: FADE_VERT,
      fragmentShader: FADE_FRAG,
      uniforms: {
        uColor: { value: color },
        uOpacity: { value: opacity },
        uHideBefore: this.clip.hideBefore,
        uDrawUntil: this.clip.drawUntil,
        uNearFade: { value: new Vector2(...nearFade) },
      },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      ...(blending ? { blending: AdditiveBlending } : {}),
    });
  }

  /** Thin posts from the path down to the water / ground every POST_SPACING metres. */
  private posts(points: Vector3[], distance: number[]): LineSegments {
    const pos: number[] = [];
    const dist: number[] = [];
    const fade: number[] = [];
    let next = POST_SPACING;
    for (let i = 0; i < points.length; i++) {
      if (distance[i]! < next) continue;
      next += POST_SPACING;
      const p = points[i]!;
      if (p.y < 8) continue;
      pos.push(p.x, p.y, p.z, p.x, -1, p.z);
      dist.push(distance[i]!, distance[i]!);
      fade.push(1, 0);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('aDist', new BufferAttribute(new Float32Array(dist), 1));
    g.setAttribute('aFade', new BufferAttribute(new Float32Array(fade), 1));
    const lines = new LineSegments(g, this.fadeMaterial(HDR(1.2), 0.45, false, [150, 350]));
    lines.renderOrder = 11;
    lines.frustumCulled = false;
    return lines;
  }

  /** Gates across the path at the plan's keyframes; the finish one is bigger. */
  private addGates(points: Vector3[], distance: number[]): void {
    const z = new Vector3(0, 0, 1);
    const t = new Vector3();
    const keys = FLIGHT_KEYS.slice(2);
    keys.forEach((key, k) => {
      const i = Math.min(points.length - 1, Math.round(key.t / STEP));
      const p = points[i]!;
      t.subVectors(points[Math.min(points.length - 1, i + 1)]!, points[Math.max(0, i - 1)]!).normalize();
      const finish = k === keys.length - 1;
      const r = finish ? 3.2 : 2.3;
      const gate = new Group();
      gate.position.copy(p);
      gate.quaternion.copy(new Quaternion().setFromUnitVectors(z, t));
      const ring = new Mesh(new TorusGeometry(r, finish ? 0.13 : 0.09, 8, 64), this.glow(HDR(finish ? 2.2 : 1.8), 0.95));
      const halo = new Mesh(new TorusGeometry(r * 1.18, 0.05, 6, 64), this.glow(HDR(1.4), 0.35));
      ring.renderOrder = halo.renderOrder = 12;
      gate.add(ring, halo);
      if (finish) {
        const inner = new Mesh(new TorusGeometry(r * 0.72, 0.06, 6, 64), this.glow(HDR(1.8), 0.6));
        inner.renderOrder = 12;
        gate.add(inner);
      }
      gate.traverse((o) => (o.frustumCulled = false));
      this.object.add(gate);
      this.gates.push({ mesh: gate, dist: distance[i]!, phase: k * 0.9 });
    });
  }

  /** The take-off point: a light column and rings pulsing out across the paving. */
  private beacon(): Group {
    const g = new Group();
    g.position.copy(PREVIEW_TAKEOFF);
    const column = (radius: number) => {
      const c = new CylinderGeometry(radius, radius, BEACON_HEIGHT, 32, 1, true).translate(0, BEACON_HEIGHT / 2, 0);
      const fade = new Float32Array(c.attributes.position!.count);
      for (let i = 0; i < fade.length; i++) fade[i] = 1 - c.attributes.position!.getY(i) / BEACON_HEIGHT;
      c.setAttribute('aFade', new BufferAttribute(fade, 1));
      c.setAttribute('aDist', new BufferAttribute(new Float32Array(fade.length), 1));
      return c;
    };
    // a bright core and a wide soft glow round it
    const beam = new Mesh(column(0.7), this.fadeMaterial(HDR(1.8), 0.7, true));
    const glowBeam = new Mesh(column(2.2), this.fadeMaterial(HDR(1.4), 0.16, true));
    beam.renderOrder = glowBeam.renderOrder = 11;
    const pad = new Mesh(new RingGeometry(3.0, 3.6, 64).rotateX(-Math.PI / 2), this.glow(HDR(1.8), 0.9));
    const dot = new Mesh(new RingGeometry(0, 0.9, 32).rotateX(-Math.PI / 2), this.glow(HDR(1.8), 0.7));
    pad.position.y = dot.position.y = 0.06;
    pad.renderOrder = dot.renderOrder = 12;
    g.add(beam, glowBeam, pad, dot);
    for (let k = 0; k < 2; k++) {
      const ring = new Mesh(new RingGeometry(0.92, 1, 64).rotateX(-Math.PI / 2), this.glow(HDR(1.8), 0));
      ring.position.y = 0.05;
      ring.renderOrder = 12;
      ring.userData.phase = k * 0.5;
      this.pulse.push(ring);
      g.add(ring);
    }
    g.traverse((o) => (o.frustumCulled = false));
    return g;
  }

  private glow(color: Color, opacity: number): MeshBasicMaterial {
    return new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: DoubleSide, fog: false });
  }

  /** Show only the part of the plan between these distances along it (m). */
  setRange(hideBefore: number, drawUntil = Number.POSITIVE_INFINITY): void {
    this.clip.hideBefore.value = hideBefore;
    this.clip.drawUntil.value = drawUntil;
  }

  /** Distance flown `t` seconds into the flight. */
  distanceAt(t: number): number {
    const i = Math.max(0, Math.min(this.distance.length - 1, t / 0.1));
    const lo = Math.floor(i);
    const hi = Math.min(this.distance.length - 1, lo + 1);
    return this.distance[lo]! + (this.distance[hi]! - this.distance[lo]!) * (i - lo);
  }

  /** Per frame: the viewport height for the minimum width, and the animation. */
  update(dt: number, _width: number, height: number): void {
    this.seconds += dt;
    this.time.value = this.seconds;
    this.viewportH.value = Math.max(1, height);
    const { hideBefore, drawUntil } = this.clip;
    for (const g of this.gates) {
      g.mesh.visible = g.dist >= hideBefore.value - 2 && g.dist <= drawUntil.value;
      const s = 1 + 0.05 * Math.sin(this.seconds * 2.6 + g.phase);
      g.mesh.scale.setScalar(s);
    }
    for (const ring of this.pulse) {
      const k = (this.seconds * 0.55 + (ring.userData.phase as number)) % 1;
      ring.scale.setScalar(1 + k * 9);
      (ring.material as MeshBasicMaterial).opacity = 0.75 * (1 - k) * (1 - k);
    }
  }
}
