/**
 * Camera rig: OrbitControls (orbit / ground-parallel pan / zoom-to-cursor, damped) with
 *  - terrain awareness: camera never below ground, the orbit pivot follows the ground height,
 *  - cinematic flyTo (ease-in-out on position and target, arcs up for long hops),
 *  - noise-based camera shake applied after controls.update() and removed before the next one,
 *  - a dynamic near plane (depth precision from 1 m at street level to tens of km from the air).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

type Pose = { position: THREE.Vector3; target: THREE.Vector3 };

const MIN_DIST = 15;
const MAX_DIST = 7000;
const MIN_CLEARANCE = 2.5;
/** Interactive tilt limit (just above the horizon). Presets that look UP (e.g. at the
 *  Transamerica Pyramid) temporarily raise it; it ratchets back down as the user tilts down. */
const BASE_MAX_POLAR = THREE.MathUtils.degToRad(87);

export class CameraRig {
  readonly controls: OrbitControls;
  ground: (x: number, z: number) => number = () => 0;
  private flight: { from: Pose; to: Pose; t: number; duration: number; arc: number } | null = null;
  private shakeAmp = 0;
  private shakeTime = 0;
  private readonly shakeOffset = new THREE.Vector3();
  private readonly shakeQuat = new THREE.Quaternion();
  private shakeApplied = false;
  private readonly savedQuat = new THREE.Quaternion();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly lastTarget = new THREE.Vector3();
  /** Set once the user pans; presets keep their exact framing until then. */
  private panning = false;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
  ) {
    const c = new OrbitControls(camera, dom);
    c.enableDamping = true;
    c.dampingFactor = 0.075;
    c.zoomToCursor = true;
    c.screenSpacePanning = false;
    c.minDistance = MIN_DIST;
    c.maxDistance = MAX_DIST;
    c.maxPolarAngle = BASE_MAX_POLAR;
    c.rotateSpeed = 0.55;
    c.zoomSpeed = 1.1;
    c.panSpeed = 1.0;
    c.keyPanSpeed = 25;
    c.listenToKeyEvents(window);
    // A user gesture cancels an in-flight camera move.
    c.addEventListener('start', () => (this.flight = null));
    this.controls = c;
  }

  setShake(amplitude: number): void {
    this.shakeAmp = Math.max(this.shakeAmp, Math.max(0, amplitude));
  }

  flyTo(position: THREE.Vector3, target: THREE.Vector3, duration: number): void {
    this.removeShake();
    this.panning = false;
    this.lastTarget.copy(target);
    if (duration <= 0) {
      this.flight = null;
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.allowPolarFor(position, target);
      this.controls.update();
      this.camera.updateMatrixWorld();
      return;
    }
    const from = { position: this.camera.position.clone(), target: this.controls.target.clone() };
    const hop = from.target.distanceTo(target);
    this.flight = { from, to: { position: position.clone(), target: target.clone() }, t: 0, duration, arc: Math.min(hop * 0.35, 1500) };
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  /** Per frame, before rendering. */
  update(dt: number): void {
    this.removeShake();
    const cam = this.camera;
    const c = this.controls;
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.duration);
      const k = easeInOutCubic(f.t);
      c.target.lerpVectors(f.from.target, f.to.target, k);
      cam.position.lerpVectors(f.from.position, f.to.position, k);
      cam.position.y += Math.sin(Math.PI * k) * f.arc;
      cam.lookAt(c.target);
      if (f.t >= 1) {
        this.flight = null;
        this.allowPolarFor(cam.position, c.target);
        c.update();
      }
    } else {
      c.update(dt);
      this.ratchetPolar();
      this.followGround();
    }
    // Never below ground or under the bay surface (+ clearance).
    const g = Math.max(this.ground(cam.position.x, cam.position.z), 0);
    if (cam.position.y < g + MIN_CLEARANCE) cam.position.y = g + MIN_CLEARANCE;
    this.updateNear();
    this.applyShake(dt);
    cam.updateMatrixWorld();
  }

  /** Raise the tilt limit just enough for a pose that looks up at its target. */
  private allowPolarFor(position: THREE.Vector3, target: THREE.Vector3): void {
    const d = this.tmp.copy(position).sub(target);
    const phi = Math.acos(THREE.MathUtils.clamp(d.y / Math.max(d.length(), 1e-6), -1, 1));
    this.controls.maxPolarAngle = Math.max(BASE_MAX_POLAR, phi + 0.005);
  }

  /** Lower a raised tilt limit as the user tilts down, never letting it rise again. */
  private ratchetPolar(): void {
    const c = this.controls;
    if (c.maxPolarAngle <= BASE_MAX_POLAR) return;
    c.maxPolarAngle = Math.max(BASE_MAX_POLAR, Math.min(c.maxPolarAngle, c.getPolarAngle() + 0.005));
  }

  /** While the user pans, keep the orbit pivot on the terrain (camera moves by the same dy: view unchanged). */
  private followGround(): void {
    const c = this.controls;
    const moved = Math.abs(c.target.x - this.lastTarget.x) + Math.abs(c.target.z - this.lastTarget.z) > 0.01;
    this.lastTarget.copy(c.target);
    if (moved) this.panning = true;
    if (!this.panning) return;
    const g = this.ground(c.target.x, c.target.z);
    const dy = g - c.target.y;
    if (Math.abs(dy) > 0.05) {
      const step = dy * 0.12;
      c.target.y += step;
      this.camera.position.y += step;
    }
  }

  private updateNear(): void {
    const cam = this.camera;
    const agl = cam.position.y - Math.max(this.ground(cam.position.x, cam.position.z), 0);
    // Tallest structures are ~330 m: from above them we can push the near plane out a lot.
    const clearance = Math.max(agl - 340, agl * 0.08);
    const near = THREE.MathUtils.clamp(clearance * 0.5, 0.5, 60);
    if (Math.abs(near - cam.near) / cam.near > 0.08) {
      cam.near = near;
      cam.updateProjectionMatrix();
    }
  }

  private applyShake(dt: number): void {
    if (this.shakeAmp < 1e-3) {
      this.shakeAmp = 0;
      return;
    }
    this.shakeTime += dt;
    const t = this.shakeTime;
    const a = this.shakeAmp;
    // Sum of incommensurate sines ≈ band-limited noise (6–15 Hz body + a slow sway).
    const n = (p: number) => Math.sin(t * 13.1 + p) * 0.5 + Math.sin(t * 7.3 + p * 1.7) * 0.35 + Math.sin(t * 2.1 + p * 2.9) * 0.25;
    this.shakeOffset.set(n(0.3), n(1.9) * 0.6, n(4.1)).multiplyScalar(a);
    const cam = this.camera;
    cam.position.add(this.shakeOffset);
    this.savedQuat.copy(cam.quaternion);
    const dist = Math.max(cam.position.distanceTo(this.controls.target), 1);
    const ang = (a / dist) * 0.6;
    this.shakeQuat.setFromEuler(new THREE.Euler(n(2.2) * ang, n(5.3) * ang, n(7.7) * ang * 0.5));
    cam.quaternion.multiply(this.shakeQuat);
    this.shakeApplied = true;
    // Decays unless re-set every frame.
    this.shakeAmp *= Math.exp(-dt * 3.5);
  }

  private removeShake(): void {
    if (!this.shakeApplied) return;
    this.camera.position.sub(this.shakeOffset);
    this.camera.quaternion.copy(this.savedQuat);
    this.shakeApplied = false;
  }

  /** Distance from camera to orbit target (used for shadow / AO fitting). */
  get distance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  get target(): THREE.Vector3 {
    return this.controls.target;
  }

  /** Ground point the camera looks at (target projected to terrain). */
  focus(out = this.tmp2): THREE.Vector3 {
    const t = this.controls.target;
    return out.set(t.x, this.ground(t.x, t.z), t.z);
  }

  dispose(): void {
    this.controls.dispose();
    void this.tmp;
  }
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
