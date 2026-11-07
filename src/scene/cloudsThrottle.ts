import type { CloudsEffect } from '@takram/three-clouds';
import { Matrix4, Vector3, type Camera, type WebGLRenderer } from 'three';
import { SUN } from '../world/sun';

/**
 * Keeps time-of-day scrubbing smooth with clouds on.
 *
 * A sun change does not make the clouds themselves more expensive (they re-march every frame
 * anyway, ~2.3 ms beam shadow map + ~4 ms clouds at 1600x900 on an M4 Max), but scrubbing makes
 * the terrain shadow field re-march every frame (src/world/shadowField.ts, ~5 ms), which pushed
 * the clouded frame past the 60 Hz budget. While the sun is moving, the two cloud passes take
 * turns instead: the beam shadow map on one frame, the clouds on the next (the clouds only when
 * the camera is still; a moving camera keeps them every frame so they never lag the view). Each
 * pass gets its own frame counter, so the temporal-upscaling Bayer cycle still visits every
 * texel. 300 ms after the last change everything runs every frame again.
 */
type PassLike = { update(renderer: WebGLRenderer, frame: number, deltaTime: number): void };

const SETTLE_MS = 300;

export class CloudsThrottle {
  private readonly lastSun = new Vector3();
  private readonly lastCamera = new Matrix4();
  private movingUntil = 0;
  private tickCount = 0;
  private shadowFrame = 0;
  private cloudsFrame = 0;
  private sunMoving = false;
  private cameraStill = true;
  private readonly restore: Array<() => void> = [];
  /** pass runs / skips (look-dev) */
  readonly stats = { shadow: 0, clouds: 0, skipped: 0 };

  constructor(effect: CloudsEffect) {
    const internals = effect as unknown as { shadowPass: PassLike; cloudsPass: PassLike };
    this.wrap(internals.shadowPass, () => !(this.sunMoving && (this.tickCount & 1) === 1), () => (this.stats.shadow++, ++this.shadowFrame));
    this.wrap(internals.cloudsPass, () => !(this.sunMoving && this.cameraStill && (this.tickCount & 1) === 0), () => (this.stats.clouds++, ++this.cloudsFrame));
  }

  private wrap(pass: PassLike, shouldRun: () => boolean, nextFrame: () => number): void {
    const original = pass.update;
    const stats = this.stats;
    pass.update = function update(renderer, _frame, deltaTime) {
      if (!shouldRun()) {
        stats.skipped++;
        return;
      }
      original.call(pass, renderer, nextFrame(), deltaTime);
    };
    this.restore.push(() => {
      pass.update = original;
    });
  }

  /** Once per frame, before the composer renders. */
  tick(camera: Camera, now = performance.now()): void {
    if (!this.lastSun.equals(SUN.dirEcef)) {
      this.lastSun.copy(SUN.dirEcef);
      this.movingUntil = now + SETTLE_MS;
    }
    this.sunMoving = now < this.movingUntil;
    this.cameraStill = this.lastCamera.equals(camera.matrixWorld);
    this.lastCamera.copy(camera.matrixWorld);
    this.tickCount++;
  }

  dispose(): void {
    for (const fn of this.restore) fn();
    this.restore.length = 0;
  }
}
