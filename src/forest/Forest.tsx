import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useState, type FC } from 'react';
import { Matrix4, type WebGLRenderer } from 'three';
import { setForestCollisionData } from './collide';
import { FOREST_LIGHT } from './lighting';
import { parseTrees, type ForestData } from './data';
import { ForestSystem, type ForestLodSettings } from './system';
import { loadForestTextures } from './textures';

export interface ForestProps {
  /** trees.bin URL (ignored when `data` is given) */
  url?: string;
  /** pre-parsed trees (dev page / tests) */
  data?: ForestData;
  /** ENU -> world matrix (emeraldBayFrame()); identity when the world already is ENU */
  frame?: Matrix4;
  lod?: Partial<ForestLodSettings>;
  /** called once the forest is drawn */
  onReady?: (system: ForestSystem) => void;
}

const IDENTITY = new Matrix4();

/** Handle for debugging / the parent (window.__flytake etc.). */
export const forestRuntime: { system: ForestSystem | null; data: ForestData | null; light: typeof FOREST_LIGHT; gl: WebGLRenderer | null } = {
  system: null,
  data: null,
  light: FOREST_LIGHT,
  gl: null,
};
// look-dev / screenshot scripts: window.__forestRuntime.light.uForestDebug.value = 1 etc.
if (typeof window !== 'undefined') (window as unknown as { __forestRuntime: typeof forestRuntime }).__forestRuntime = forestRuntime;

/**
 * Instanced lidar forest (see README.md). The group's matrix is `frame`; the camera can live
 * in ECEF world space, the forest computes its own camera position in the frame every frame.
 */
export const Forest: FC<ForestProps> = ({ url = '/scene/trees.bin', data, frame = IDENTITY, lod, onReady }) => {
  const gl = useThree((s) => s.gl);
  const [system, setSystem] = useState<ForestSystem | null>(null);

  useEffect(() => {
    let alive = true;
    let sys: ForestSystem | null = null;
    (async () => {
      const textures = await loadForestTextures('/textures/forest', Math.min(8, gl.capabilities.getMaxAnisotropy()));
      const trees = data ?? parseTrees(await (await fetch(url)).arrayBuffer());
      if (!alive) return;
      sys = new ForestSystem(gl, textures);
      sys.setData(trees);
      forestRuntime.system = sys;
      forestRuntime.data = trees;
      forestRuntime.gl = gl;
      setForestCollisionData(trees);
      setSystem(sys);
    })().catch((err: unknown) => console.error('[flytake] forest failed to load', err));
    return () => {
      alive = false;
      if (sys) {
        sys.dispose();
        if (forestRuntime.system === sys) {
          forestRuntime.system = null;
          forestRuntime.data = null;
          setForestCollisionData(null);
        }
      }
      setSystem(null);
    };
  }, [gl, url, data]);

  useEffect(() => {
    system?.setFrame(frame);
  }, [system, frame]);

  useEffect(() => {
    if (system && lod) system.setLod(lod);
  }, [system, lod]);

  useEffect(() => {
    if (system) onReady?.(system);
  }, [system, onReady]);

  useFrame(({ camera, clock }) => {
    system?.update(camera, clock.elapsedTime);
  });

  return system ? <primitive object={system.group} /> : null;
};
