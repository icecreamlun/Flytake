import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, type FC } from 'react';
import type { PerspectiveCamera } from 'three';
import { getDestination } from '../camera/destinations';
import { createSample, ecefToGeodetic, FlyInPath, poseToSample, type CameraSample } from '../camera/flyIn';
import { cinematicIdlePose, IDLE_BASE } from '../camera/idle';
import { CUES, cuesAt, type Cues } from '../camera/timeline';
import { FLAGS } from '../config';
import { launchCameraSample, launchSite } from '../drone/DroneSim';
import { FLIGHT_OPTIONS, useFlytake } from '../state/store';
import { adjustNearFar } from './clipping';
import { exposureForHeight } from './exposure';
import { runtime } from './runtime';
import { WATER_UNIFORMS } from './water';

const sample: CameraSample = createSample();
const geo = { lat: 0, lon: 0, height: 0 };
const HOLD_CUES: Cues = { hud: false, bars: false, title: true, controls: true };
let loadingPath: FlyInPath | null = null;

/**
 * Drives the R3F default camera every frame, before GlobeControls (-1), the tiles update (0)
 * and the effect composer (1). World space is ECEF, so poses are applied directly.
 */
export const CameraDirector: FC = () => {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    runtime.camera = camera;
    runtime.scene = scene;
  }, [camera, scene]);

  useFrame((_, delta) => {
    // Clamp the step so a long hitch (tile parsing, tab switch) slows the shot instead of
    // jumping through it.
    const dt = Math.min(Math.max(delta, 0), 1 / 20);
    if (delta > 0) runtime.fps = runtime.fps === 0 ? 1 / delta : runtime.fps + (1 / delta - runtime.fps) * 0.05;

    WATER_UNIFORMS.uFlyTime.value = (WATER_UNIFORMS.uFlyTime.value + dt) % 3600;
    const store = useFlytake.getState();
    const destination = getDestination(store.destinationId);
    let drive = true;

    switch (store.phase) {
      case 'loading': {
        // Point the camera where the first visible frame will be so the right tiles load.
        if (FLAGS.drone) {
          launchCameraSample(launchSite(), sample);
        } else if (FLAGS.heroPose) {
          poseToSample(destination.hero, sample);
        } else if (FLAGS.frozenT != null) {
          loadingPath ??= new FlyInPath(IDLE_BASE, destination.hero, FLIGHT_OPTIONS);
          loadingPath.sample(FLAGS.frozenT, sample);
        } else {
          poseToSample(cinematicIdlePose(0), sample);
        }
        break;
      }
      case 'start': {
        runtime.idleSeconds += dt;
        poseToSample(cinematicIdlePose(runtime.idleSeconds), sample);
        break;
      }
      case 'flying':
      case 'arrived': {
        const path = runtime.path;
        if (path == null) {
          drive = false;
          break;
        }
        const frozen = store.frozenT != null;
        if (!frozen) runtime.flightSeconds += dt;
        const seconds = frozen ? store.frozenT! * path.duration : runtime.flightSeconds;
        if (store.hold) path.sample(1, sample);
        else path.at(seconds, sample);
        store.setCues(store.hold ? HOLD_CUES : cuesAt(seconds));
        if (store.phase === 'flying' && !frozen && seconds >= path.duration) store.arrive();
        if (store.phase === 'arrived' && !frozen && !store.hold && seconds >= CUES.autoHandoff) store.handoff();
        break;
      }
      case 'drone': {
        const drone = runtime.drone;
        if (drone == null) {
          drive = false;
          break;
        }
        drone.step(dt, sample);
        break;
      }
      case 'free':
        // GlobeControls own the camera; keep the overlay clock running so the title card
        // still fades out on schedule if the user grabbed the view early.
        drive = false;
        runtime.flightSeconds += dt;
        store.setCues({ ...cuesAt(runtime.flightSeconds), controls: true });
        break;
    }

    if (drive) {
      camera.position.copy(sample.position);
      camera.quaternion.copy(sample.quaternion);
      camera.fov = sample.fov;
      adjustNearFar(camera); // also updates the projection matrix
      const drone = store.phase === 'drone' ? runtime.drone : null;
      if (drone != null) {
        // Sitting on the ground / skimming trees: the default 1 m near plane would cut into them.
        const near = Math.min(camera.near, Math.max(0.08, drone.cameraAgl * 0.4));
        if (near !== camera.near) {
          camera.near = near;
          camera.updateProjectionMatrix();
        }
      }
      camera.updateMatrixWorld();
    }

    ecefToGeodetic(camera.position, geo);
    gl.toneMappingExposure = exposureForHeight(geo.height - destination.surfaceHeight) * FLAGS.exposureScale;
  }, -2);

  return null;
};
