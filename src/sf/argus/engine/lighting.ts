/**
 * Key light (sun by day, moon by night — one shadow-casting DirectionalLight), hemisphere fill, and
 * a single 4096² shadow map whose orthographic frustum is fitted every frame around what the camera
 * is looking at: tight at street level, wide from the air. Texel-snapped and size-quantised so
 * shadows don't shimmer while the camera moves.
 */
import * as THREE from 'three';

const SHADOW_MAP = 4096;
/** How far the shadow camera sits toward the light (m) — must exceed the tallest caster's shadow reach. */
const LIGHT_BACKOFF = 4000;

export class Lighting {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** Unit vector toward the current key light (sun or moon). */
  readonly keyDir = new THREE.Vector3(0, 1, 0);
  private readonly basisX = new THREE.Vector3();
  private readonly basisY = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private lastRadius = 0;
  /** Extra multiplier for shadow-region radius (exposed for tuning). */
  regionScale = 1;
  /** Force per-frame shadow updates (set while an earthquake animates the city). */
  dynamicShadows = false;
  private readonly lastCenter = new THREE.Vector3(Infinity, 0, 0);
  private lastHalfY = 0;
  private frame = 0;

  constructor(scene: THREE.Scene) {
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.name = 'keyLight';
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = LIGHT_BACKOFF * 2;
    sun.shadow.radius = 2.2;
    sun.shadow.bias = -0.00002;
    sun.shadow.normalBias = 0.4;
    // Updated explicitly by fitShadow(): every frame while the view / light / scene changes,
    // every other frame when everything is still (moving props still get 30 Hz shadows).
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = true;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x4a4036, 0.2);
    this.hemi.name = 'skyFill';
    scene.add(this.hemi);
  }

  setKeyDirection(dir: THREE.Vector3): void {
    this.keyDir.copy(dir).normalize();
    // Light-space basis: X horizontal (perpendicular to the light azimuth), Y completes the frame.
    const L = this.keyDir;
    this.basisX.set(-L.z, 0, L.x);
    if (this.basisX.lengthSq() < 1e-8) this.basisX.set(1, 0, 0);
    this.basisX.normalize();
    this.basisY.crossVectors(L, this.basisX).normalize();
    if (this.basisY.y < 0) this.basisY.negate();
    this.lastRadius = -1; // force refit (and a shadow-map update)
  }

  /**
   * Fit the shadow frustum around the camera's focus. `focus` is the orbit target (on the ground),
   * `distance` the camera-to-target distance.
   */
  fitShadow(camera: THREE.PerspectiveCamera, focus: THREE.Vector3, distance: number): void {
    const cam = this.sun.shadow.camera as THREE.OrthographicCamera;
    // Region radius on the ground: generous in front of the camera, quantised in 12% steps.
    const want = THREE.MathUtils.clamp(distance * 1.15, 220, 4200) * this.regionScale;
    const q = Math.pow(1.12, Math.ceil(Math.log(want) / Math.log(1.12)));
    const R = q;
    // Shift the centre forward (more of the visible ground lies beyond the target).
    const fwd = this.tmp.set(0, 0, -1).applyQuaternion(camera.quaternion);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const cx = focus.x + fwd.x * R * 0.35;
    const cz = focus.z + fwd.z * R * 0.35;
    const cy = focus.y;

    const L = this.keyDir;
    const sinE = Math.max(Math.abs(L.y), 0.05);
    const cosE = Math.sqrt(1 - Math.min(1, L.y * L.y));
    // Half extents in light space: X = R; Y = ground disc foreshortened + tallest towers (~330 m).
    const halfX = R;
    const halfY = R * sinE + 340 * cosE + 20;
    // Texel snapping of the centre in light space.
    const texX = (2 * halfX) / SHADOW_MAP;
    const texY = (2 * halfY) / SHADOW_MAP;
    const px = cx * this.basisX.x + cz * this.basisX.z;
    const py = cx * this.basisY.x + cy * this.basisY.y + cz * this.basisY.z;
    const sx = Math.round(px / texX) * texX;
    const sy = Math.round(py / texY) * texY;
    // Move the snapped centre back to world space (stay on the same light ray through (cx,cy,cz)).
    const center = new THREE.Vector3(cx, cy, cz)
      .addScaledVector(this.basisX, sx - px)
      .addScaledVector(this.basisY, sy - py);

    const moved = center.distanceToSquared(this.lastCenter) > 1e-6 || R !== this.lastRadius || halfY !== this.lastHalfY;
    this.lastCenter.copy(center);
    this.frame++;
    // Quake motion needs per-frame shadows only up close. Beyond ~350 m a screen pixel spans ≥ 0.25 m, more than
    // a building moves in one frame (sway ≤ ~0.15 m, collapse ≤ ~0.25 m), so updating every other frame is
    // invisible and saves the ~3 ms 4096² pass on alternate frames. (Integration perf fix.)
    const dynamic = this.dynamicShadows && distance < 350;
    this.sun.shadow.needsUpdate = moved || dynamic || (this.frame & 1) === 0;
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(L, LIGHT_BACKOFF);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();

    if (R !== this.lastRadius || halfY !== this.lastHalfY) {
      this.lastHalfY = halfY;
      cam.left = -halfX;
      cam.right = halfX;
      cam.top = halfY;
      cam.bottom = -halfY;
      cam.near = 1;
      cam.far = LIGHT_BACKOFF + 1500;
      cam.updateProjectionMatrix();
      this.lastRadius = R;
      // Normal-offset bias scales with texel size (world metres).
      const texel = Math.max(texX, texY);
      this.sun.shadow.normalBias = THREE.MathUtils.clamp(texel * 1.2, 0.05, 2.5);
      this.sun.shadow.radius = THREE.MathUtils.clamp(1.3 + R / 2500, 1.3, 2.4);
    }
  }
}
