import { WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { MathUtils, type PerspectiveCamera } from 'three';

/**
 * Near/far policy identical to 3d-tiles-renderer's GlobeControls.adjustCamera(), so the
 * scripted flight and the interactive controls produce the same projection and the handoff
 * cannot pop. Keep NEAR_MARGIN / FAR_MARGIN in sync with the <GlobeControls> props.
 */
export const NEAR_MARGIN = 0.25;
/** +~128 km beyond the horizon so distant Sierra / Carson Range peaks never clip */
export const FAR_MARGIN = 0.02;
const MIN_ELEVATION = 2550;
const MAX_RADIUS = Math.max(WGS84_ELLIPSOID.radius.x, WGS84_ELLIPSOID.radius.y, WGS84_ELLIPSOID.radius.z);
const _latLon = { lat: 0, lon: 0, height: 0 };

export function adjustNearFar(camera: PerspectiveCamera, farMargin = FAR_MARGIN): void {
  const distanceToCenter = camera.position.length();
  const margin = NEAR_MARGIN * MAX_RADIUS;
  const alpha = MathUtils.clamp((distanceToCenter - MAX_RADIUS) / margin, 0, 1);
  camera.near = Math.max(MathUtils.lerp(1, 1000, alpha), distanceToCenter - MAX_RADIUS - margin);
  WGS84_ELLIPSOID.getPositionToCartographic(camera.position, _latLon);
  const elevation = Math.max(WGS84_ELLIPSOID.getPositionElevation(camera.position), MIN_ELEVATION);
  const horizonDistance = WGS84_ELLIPSOID.calculateHorizonDistance(_latLon.lat, elevation);
  camera.far = horizonDistance + 0.1 + MAX_RADIUS * farMargin;
  camera.updateProjectionMatrix();
}
