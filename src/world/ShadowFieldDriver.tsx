import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, type FC } from 'react';
import { Vector3 } from 'three';
import { world } from './handles';
import { SCENE_FRAME_INV } from './scene';
import { ShadowField, cameraEnu } from './shadowField';
import { onSunChange } from './sun';

const pos = new Vector3();
const dir = new Vector3();

/** Owns the GPU shadow field: loads its data, recomputes it on sun / camera changes. */
export const ShadowFieldDriver: FC = () => {
  const gl = useThree((s) => s.gl);
  const field = useRef<ShadowField | null>(null);

  useEffect(() => {
    const f = new ShadowField(gl);
    field.current = f;
    world.shadow = f;
    f.load('/scene/dtm.bin', '/scene/trees.bin').catch((err: unknown) => console.warn('[flytake] shadow field failed to load', err));
    const unbind = onSunChange(() => f.invalidateSun());
    return () => {
      unbind();
      f.dispose();
      if (world.shadow === f) world.shadow = null;
      field.current = null;
    };
  }, [gl]);

  useFrame(({ camera }) => {
    const f = field.current;
    if (!f) return;
    cameraEnu(camera, SCENE_FRAME_INV, pos, dir);
    f.update(pos, dir);
  }, -1.5);

  return null;
};
