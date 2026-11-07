/**
 * The flight plan drawn into the city: a dashed amber line along the preview's flight path, a
 * faint copy that shows through buildings, and a ring on the take-off point. Lines are
 * screen-space wide (Line2) with dashes in metres; `drawUntil` / `hideBefore` (metres along the
 * path) let the plan draw itself in and keep the stretch behind the flying camera out of view.
 */
import { Color, DoubleSide, Group, Mesh, MeshBasicMaterial, RingGeometry, type WebGLProgramParametersWithUniforms } from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { PREVIEW_TAKEOFF, flightPolyline } from './previewRoute';

/** Flytake's accent (--accent), pushed above 1 so the line keeps its colour through the tone map */
const ROUTE_COLOR = new Color('#f3b562').multiplyScalar(1.6);
const DASH = 7;
const GAP = 5;
/** dashes drift along the direction of flight, m/s */
const DASH_FLOW = 6;

export class RouteLine {
  readonly object = new Group();
  /** total path length, m */
  readonly length: number;
  /** distance flown at each 0.1 s of the flight (for hideBefore) */
  readonly distance: number[];
  private readonly materials: LineMaterial[] = [];
  private readonly clip = { hideBefore: { value: 0 }, drawUntil: { value: Number.POSITIVE_INFINITY } };

  constructor() {
    const { points, distance } = flightPolyline();
    this.distance = distance;
    this.length = distance[distance.length - 1]!;
    const geometry = new LineGeometry();
    geometry.setPositions(points.flatMap((p) => [p.x, p.y, p.z]));

    // In front: depth-tested, so buildings hide it. Behind: a faint x-ray copy.
    const front = this.line(geometry, { opacity: 1, depthTest: true, linewidth: 3 });
    const xray = this.line(geometry, { opacity: 0.28, depthTest: false, linewidth: 2 });
    xray.renderOrder = 10;
    front.renderOrder = 11;

    const pad = new Mesh(
      new RingGeometry(3.2, 4.2, 48).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: ROUTE_COLOR, side: DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    pad.position.copy(PREVIEW_TAKEOFF).setY(PREVIEW_TAKEOFF.y + 0.08);
    pad.renderOrder = 11;

    this.object.name = 'sfRoute';
    this.object.add(xray, front, pad);
    this.object.visible = false;
  }

  private line(geometry: LineGeometry, o: { opacity: number; depthTest: boolean; linewidth: number }): Line2 {
    const material = new LineMaterial({
      color: ROUTE_COLOR,
      linewidth: o.linewidth,
      dashed: true,
      dashSize: DASH,
      gapSize: GAP,
      transparent: true,
      opacity: o.opacity,
      depthTest: o.depthTest,
      depthWrite: false,
    });
    material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      shader.uniforms.uHideBefore = this.clip.hideBefore;
      shader.uniforms.uDrawUntil = this.clip.drawUntil;
      shader.fragmentShader = shader.fragmentShader
        .replace('uniform float dashOffset;', 'uniform float dashOffset;\nuniform float uHideBefore;\nuniform float uDrawUntil;')
        .replace(
          'if ( vUv.y < - 1.0 || vUv.y > 1.0 ) discard; // discard endcaps',
          'if ( vUv.y < - 1.0 || vUv.y > 1.0 ) discard; // discard endcaps\n\t\t\t\tif ( vLineDistance < uHideBefore || vLineDistance > uDrawUntil ) discard;',
        );
    };
    this.materials.push(material);
    const line = new Line2(geometry, material);
    line.computeLineDistances();
    line.frustumCulled = false;
    return line;
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

  /** Per frame: viewport size for the screen-space width, and the dash drift. */
  update(dt: number, width: number, height: number): void {
    for (const m of this.materials) {
      m.resolution.set(width, height);
      m.dashOffset -= DASH_FLOW * dt;
    }
  }
}
