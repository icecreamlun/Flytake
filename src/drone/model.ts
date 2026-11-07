/**
 * A DJI Mini 4 Pro for the chase view, modelled from primitives at its real size (folded body
 * 148 x 94 x 64 mm, 298 x 373 mm unfolded with 6-inch props):
 *  - light-grey rounded body, lower and narrower toward the nose, flat underneath;
 *  - the glossy black front visor with the two forward vision sensors, two more at the back;
 *  - front arms high and swept forward (with landing legs), rear arms low and swept back;
 *  - curved two-blade props (a blur disc while they spin);
 *  - the 3-axis gimbal under the nose: black bracket, rounded camera head, ringed lens.
 *
 * Model frame: Y up, nose toward -Z (three's convention), origin at the body centre. Each world
 * supplies its own materials (San Francisco: lit MeshStandardMaterial; Emerald Bay: pre-lit
 * shaders) and places `object` in its frame; `pose()` sets heading, airframe tilt and gimbal.
 */
import {
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  MathUtils,
  Mesh,
  Quaternion,
  Shape,
  SphereGeometry,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import type { DroneState } from './physics';
import { DRONE, MODES } from './specs';

/** body: light-grey shell; dark: black plastic; glass: sensor / lens glass; metal: lens rings; led: status lights */
export type DroneMaterialRole = 'body' | 'dark' | 'prop' | 'disc' | 'glass' | 'metal' | 'led';

/** chase camera: behind and above the drone, looking at it */
export const CHASE = {
  distance: 1.55,
  height: 0.48,
  /** the camera swings round behind the drone with this lag, s */
  headingTau: 0.35,
  /** pulled in no closer than this when something is between camera and drone */
  minDistance: 0.6,
};

/**
 * The model's origin sits this far below the drone position (the first-person camera, which
 * rests DRONE.restHeight above the ground), so that landed it stands on its legs.
 */
export const MODEL_DROP = DRONE.restHeight - 0.047;

/** airframe tilt at full speed, degrees (Sport leans hardest) */
const MAX_TILT = { cine: 10, normal: 18, sport: 26 } as const;
const TILT_TAU = 0.22;
const DEG = Math.PI / 180;

/** motors (x right, y up, z back) and spin direction: front arms high, rear arms low */
const MOTORS: Array<{ at: [number, number, number]; root: [number, number, number]; dir: number; leg: boolean }> = [
  { at: [-0.11, 0.014, -0.074], root: [-0.034, 0.01, -0.046], dir: 1, leg: true },
  { at: [0.11, 0.014, -0.074], root: [0.034, 0.01, -0.046], dir: -1, leg: true },
  // rear arms hinge low and slope down: their motors are the rear feet
  { at: [-0.098, -0.039, 0.072], root: [-0.028, -0.016, 0.05], dir: -1, leg: false },
  { at: [0.098, -0.039, 0.072], root: [0.028, -0.016, 0.05], dir: 1, leg: false },
];
const PROP_RADIUS = 0.076;

/**
 * A rounded box (superellipsoid of exponent n) with half extents hx, hy, hz, optionally reshaped
 * per vertex (unit-sphere direction in, position out) before the normals are computed.
 */
function roundedBody(hx: number, hy: number, hz: number, n: number, shape?: (p: Vector3) => void): BufferGeometry {
  const g = new SphereGeometry(1, 48, 32);
  const pos = g.attributes.position!;
  const p = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const r = Math.pow(Math.pow(Math.abs(p.x), n) + Math.pow(Math.abs(p.y), n) + Math.pow(Math.abs(p.z), n), -1 / n);
    p.multiplyScalar(r).multiply(new Vector3(hx, hy, hz));
    shape?.(p);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeVertexNormals();
  return g;
}

/** A tapered, slightly flattened strut from a to b (radius ra at a, rb at b). */
function strut(a: Vector3, b: Vector3, ra: number, rb: number): BufferGeometry {
  const d = new Vector3().subVectors(b, a);
  const g = new CylinderGeometry(rb, ra, d.length(), 12);
  g.scale(1.25, 1, 0.8);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d.clone().normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** One propeller blade: a curved planform from the hub to the rounded tip, along +X. */
function bladeGeometry(): BufferGeometry {
  const lead = [
    [0.006, 0.0035],
    [0.016, 0.0085],
    [0.03, 0.0095],
    [0.048, 0.0078],
    [0.064, 0.0055],
    [0.0745, 0.003],
  ];
  const trail = [
    [0.0755, -0.0015],
    [0.068, -0.0032],
    [0.05, -0.0045],
    [0.03, -0.0055],
    [0.015, -0.0055],
    [0.006, -0.0035],
  ];
  const shape = new Shape();
  shape.moveTo(lead[0]![0]!, lead[0]![1]!);
  shape.splineThru(lead.slice(1).map(([x, y]) => new Vector2(x, y)));
  shape.quadraticCurveTo(PROP_RADIUS + 0.001, 0.001, trail[0]![0]!, trail[0]![1]!);
  shape.splineThru(trail.slice(1).map(([x, y]) => new Vector2(x, y)));
  shape.closePath();
  const g = new ExtrudeGeometry(shape, { depth: 0.0014, bevelEnabled: false, curveSegments: 8 });
  // lay it flat (shape Y -> -Z, extrusion -> up) with a little pitch
  g.rotateX(-Math.PI / 2);
  g.rotateX(0.18);
  return g;
}

export class DroneModel {
  /** place and orient this in the world (see pose()) */
  readonly object = new Group();
  private readonly props: Array<{ blades: Group; dir: number }> = [];
  private readonly gimbal = new Group();
  private readonly discMaterial: Material & { opacity: number };
  private tiltPitch = 0;
  private tiltRoll = 0;

  constructor(material: (role: DroneMaterialRole) => Material) {
    const body = material('body');
    const dark = material('dark');
    const prop = material('prop');
    const glass = material('glass');
    const metal = material('metal');
    const led = material('led');
    this.discMaterial = material('disc') as Material & { opacity: number };
    const add = (geometry: BufferGeometry, m: Material, parent: Group = this.object) => {
      const mesh = new Mesh(geometry, m);
      parent.add(mesh);
      return mesh;
    };

    // Body: rounded shell, nose narrower and lower, rear tapering a little, flat belly.
    add(
      roundedBody(0.044, 0.027, 0.074, 3, (p) => {
        const front = MathUtils.clamp(-p.z / 0.074, 0, 1);
        const rear = MathUtils.clamp(p.z / 0.074, 0, 1);
        p.x *= 1 - 0.16 * front * front - 0.12 * rear;
        if (p.y > 0) p.y *= 1 - 0.3 * front * front - 0.12 * rear * rear;
        else p.y *= 0.78;
      }),
      body,
    );
    // Front visor: glossy black, the two forward vision sensors in it (slightly toed out).
    add(
      roundedBody(0.031, 0.0095, 0.014, 2.6, (p) => {
        p.y *= p.y < 0 ? 0.6 : 1;
      }),
      glass,
    ).position.set(0, 0.004, -0.066);
    for (const side of [-1, 1]) {
      const eye = add(new CylinderGeometry(0.0062, 0.0062, 0.004, 20), metal);
      eye.rotation.set(Math.PI / 2 - 0.12, side * 0.42, 0);
      eye.position.set(side * 0.017, 0.006, -0.0775);
      const lensGlass = add(new CylinderGeometry(0.0046, 0.0046, 0.0045, 20), glass);
      lensGlass.rotation.copy(eye.rotation);
      lensGlass.position.set(side * 0.0172, 0.006, -0.078);
      // rear sensors
      const back = add(new CylinderGeometry(0.0034, 0.0034, 0.003, 16), glass);
      back.rotation.set(Math.PI / 2 + 0.25, -side * 0.35, 0);
      back.position.set(side * 0.013, 0.006, 0.067);
    }
    // Battery seam on the back of the top shell, and the dark belly with the downward sensors.
    add(new BoxGeometry(0.054, 0.0006, 0.0008), dark).position.set(0, 0.0262, 0.036);
    add(roundedBody(0.032, 0.005, 0.055, 3), dark).position.set(0, -0.0185, 0.006);
    for (const side of [-1, 1]) add(new CylinderGeometry(0.004, 0.004, 0.002, 12), glass).position.set(side * 0.01, -0.0235, -0.02);

    // Arms, motors, legs and props.
    const blade = bladeGeometry();
    for (const { at, root, dir, leg } of MOTORS) {
      const m = new Vector3(...at);
      add(strut(new Vector3(...root), m.clone().add(new Vector3(0, -0.006, 0)), 0.0066, 0.005), body);
      add(new CylinderGeometry(0.0125, 0.0135, 0.016, 20), body).position.set(m.x, m.y, m.z);
      add(new CylinderGeometry(0.0108, 0.0108, 0.004, 20), dark).position.set(m.x, m.y + 0.009, m.z);
      if (leg) {
        // landing leg down to the same plane as the rear motors' feet
        add(strut(m.clone().add(new Vector3(0, -0.006, 0)), m.clone().add(new Vector3(0, -0.056, 0.006)), 0.0038, 0.0028), body);
        add(new SphereGeometry(0.0034, 10, 8), dark).position.set(m.x, m.y - 0.057, m.z + 0.006);
        // red status light under the front arm
        add(new SphereGeometry(0.0022, 8, 6), led).position.set(m.x - Math.sign(m.x) * 0.012, m.y - 0.008, m.z + 0.006);
      }

      const hub = new Group();
      hub.position.set(m.x, m.y + 0.0125, m.z);
      this.object.add(hub);
      const blades = new Group();
      hub.add(blades);
      add(blade, prop, blades);
      add(blade, prop, blades).rotation.y = Math.PI;
      add(new CylinderGeometry(0.0055, 0.0065, 0.006, 14), dark, blades);
      if (dir < 0) blades.scale.z = -1; // mirrored props on the counter-rotating motors
      blades.rotation.y = m.x * 31 + m.z * 17; // not all in phase
      const disc = add(new CircleGeometry(PROP_RADIUS, 40).rotateX(-Math.PI / 2), this.discMaterial, hub);
      disc.position.y = 0.0015;
      disc.renderOrder = 2;
      this.props.push({ blades, dir });
    }

    // 3-axis gimbal under the nose: bracket, rounded camera head, ringed lens.
    add(new BoxGeometry(0.02, 0.01, 0.016), dark).position.set(0, -0.017, -0.066);
    this.gimbal.position.set(0, -0.022, -0.084);
    this.object.add(this.gimbal);
    add(roundedBody(0.0165, 0.0155, 0.014, 3.2), dark, this.gimbal);
    const ring = add(new CylinderGeometry(0.0105, 0.0112, 0.005, 28), metal, this.gimbal);
    ring.rotation.x = Math.PI / 2;
    ring.position.z = -0.014;
    const lens = add(new CylinderGeometry(0.0082, 0.0082, 0.0055, 28), glass, this.gimbal);
    lens.rotation.x = Math.PI / 2;
    lens.position.z = -0.0145;

    this.object.traverse((o) => {
      o.castShadow = o !== this.object && (o as Mesh).material !== this.discMaterial;
      o.frustumCulled = false;
    });
    this.object.visible = false;
  }

  /**
   * Orient the airframe: heading (deg clockwise from north, north = -Z), tilt from the drone's
   * velocity (nose down flying forward, leaning into sideways moves) plus any extra crash roll,
   * and the stabilised gimbal at `gimbalPitch` (deg, world-level). Spins the props at `spin` (0..1).
   */
  pose(s: DroneState, dt: number, spin: number, crashRoll = 0): void {
    const h = s.heading * DEG;
    const forward = s.vNorth * Math.cos(h) + s.vEast * Math.sin(h);
    const right = s.vEast * Math.cos(h) - s.vNorth * Math.sin(h);
    const m = MODES[s.mode];
    const tilt = MAX_TILT[s.mode];
    const k = 1 - Math.exp(-dt / TILT_TAU);
    this.tiltPitch += (-MathUtils.clamp(forward / m.maxHorizontal, -1, 1) * tilt - this.tiltPitch) * k;
    this.tiltRoll += (MathUtils.clamp(right / m.maxHorizontal, -1, 1) * tilt - this.tiltRoll) * k;
    this.object.rotation.set(this.tiltPitch * DEG, -h, -(this.tiltRoll + crashRoll) * DEG, 'YXZ');
    this.gimbal.rotation.x = (s.gimbalPitch - this.tiltPitch) * DEG;

    for (const p of this.props) p.blades.rotation.y += p.dir * spin * 70 * dt;
    const opacity = 0.22 * MathUtils.smoothstep(spin, 0.2, 0.9);
    this.discMaterial.opacity = opacity;
    const u = (this.discMaterial as Material & { uniforms?: { uOpacity?: { value: number } } }).uniforms?.uOpacity;
    if (u != null) u.value = opacity;
    this.discMaterial.visible = spin > 0.05;
  }
}
