import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useState, type FC } from 'react';
import { Matrix4, NoColorSpace, SRGBColorSpace, TextureLoader, Vector4, type BufferGeometry, type Texture } from 'three';
import { BOULDERS, GRASS, LOGS, LOGS_SPEC, PEBBLES, PROP_HEIGHT, ROCKS, SHRUBS, STONES } from './catalog';
import { buildGrassTuft, buildShrub, loadProp, makeLeafTexture } from './geometry';
import { createGrassMaterial, createPropMaterial, createShrubMaterial, type PropLook } from './materials';
import { GroundSystem, type CategoryDef, type LodDef } from './system';
import { GroundTiles } from './tiles';

/** Handle for debugging (window.__flytake) and the parent. */
export const groundRuntime: { system: GroundSystem | null } = { system: null };
if (typeof window !== 'undefined') (window as unknown as { __flytakeGround?: typeof groundRuntime }).__flytakeGround = groundRuntime;

const ROCK_LOOK: PropLook = { desaturate: 0.95, gain: 1.0, normal: 1.3, aoHeight: 0.25, tint: [1.0, 0.97, 0.93] };
const LOG_LOOK: PropLook = { desaturate: 0.3, gain: 0.8, normal: 1.2, aoHeight: 0.12, tint: [1.0, 0.96, 0.92] };
/** per-scan albedo trims (the smooth grey moon rock reads as plaster at full brightness) */
const GAIN: Record<string, number> = { rock_a: 0.85, rock_b: 1.0, rock_c: 0.9, rock_d: 1.0, rock_e: 0.55, log_a: 0.85, log_b: 1.1, stump: 1.0 };

interface Prop {
  name: string;
  lods: BufferGeometry[];
  map: Texture;
  normal: Texture;
}

async function loadPropSet(name: string, lodCount: number, anisotropy: number): Promise<Prop> {
  const loader = new TextureLoader();
  const tex = async (file: string, srgb: boolean) => {
    const t = await loader.loadAsync(`/textures/ground2/${file}`);
    t.flipY = false; // glTF convention (uv origin top-left)
    t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
    t.anisotropy = anisotropy;
    t.needsUpdate = true;
    return t;
  };
  const [map, normal, ...lods] = await Promise.all([
    tex(`${name}_diff.jpg`, true),
    tex(`${name}_nor.jpg`, false),
    ...Array.from({ length: lodCount }, (_, k) => loadProp(`/scene/ground/props/${name}_${k}.bin`)),
  ]);
  // normalise: unit maximum dimension, origin at the bottom centre
  const first = lods[0]!;
  const ext = Math.max(first.max[0] - first.min[0], first.max[1] - first.min[1], first.max[2] - first.min[2]);
  PROP_HEIGHT[name] = (first.max[2] - first.min[2]) / ext;
  const geoms = lods.map((l) => {
    l.geometry.scale(1 / ext, 1 / ext, 1 / ext);
    return l.geometry;
  });
  return { name, lods: geoms, map: map as Texture, normal: normal as Texture };
}

const fade = (): Vector4 => new Vector4();

async function buildSystem(anisotropy: number): Promise<GroundSystem> {
  const tiles = new GroundTiles('/scene/ground');
  const [rocks, logs] = await Promise.all([
    Promise.all(ROCKS.map((n) => loadPropSet(n, 3, anisotropy))),
    Promise.all(LOGS.map((n) => loadPropSet(n, 2, anisotropy))),
    tiles.init(),
  ]);

  const propLods = (set: Prop[], lodIdx: number[], tos: number[], look: PropLook): LodDef[] =>
    tos.map((to, k) => {
      const f = fade();
      return {
        to,
        fade: f,
        draws: set.map((p) => ({
          geometry: p.lods[lodIdx[k]!]!,
          material: createPropMaterial(p.map, p.normal, { ...look, gain: look.gain * (GAIN[p.name] ?? 1) }, f, 1),
        })),
      };
    });

  const grassFar = 75;
  const grassLods: LodDef[] = [
    { to: 16, fade: fade(), draws: [{ geometry: buildGrassTuft(16, 4, 1), material: null! }] },
    { to: grassFar, fade: fade(), draws: [{ geometry: buildGrassTuft(6, 2, 2), material: null! }] },
  ];
  for (const l of grassLods) l.draws[0]!.material = createGrassMaterial(l.fade, grassFar);

  const leaves = makeLeafTexture(anisotropy);
  const shrubLods: LodDef[] = [
    { to: 45, fade: fade(), draws: [{ geometry: buildShrub(70, 0.5, 3), material: null! }] },
    { to: 280, fade: fade(), draws: [{ geometry: buildShrub(16, 0.95, 4), material: null! }] },
  ];
  for (const l of shrubLods) l.draws[0]!.material = createShrubMaterial(leaves, l.fade);

  const defs: CategoryDef[] = [
    { name: 'boulders', spec: BOULDERS, radius: 340, sizeRef: 1.2, fadeWidth: 8, lods: propLods(rocks, [0, 1, 2], [16, 50, 270], ROCK_LOOK) },
    { name: 'stones', spec: STONES, radius: 95, sizeRef: 0, fadeWidth: 6, lods: propLods(rocks, [1, 2], [16, 90], ROCK_LOOK) },
    { name: 'pebbles', spec: PEBBLES, radius: 48, sizeRef: 0, fadeWidth: 6, lods: propLods(rocks, [2], [45], ROCK_LOOK) },
    { name: 'grass', spec: GRASS, radius: grassFar + 5, sizeRef: 0, fadeWidth: 5, lods: grassLods },
    { name: 'shrubs', spec: SHRUBS, radius: 300, sizeRef: 1.2, fadeWidth: 8, lods: shrubLods },
    { name: 'logs', spec: LOGS_SPEC, radius: 220, sizeRef: 4, fadeWidth: 8, lods: propLods(logs, [0, 1], [28, 160], LOG_LOOK) },
  ];
  return new GroundSystem(tiles, defs);
}

export interface GroundProps {
  /** ENU -> world matrix (the scene frame) */
  frame: Matrix4;
}

/** ?ground=0 disables the ground cover (A/B, perf) */
const ENABLED = typeof location === 'undefined' || new URLSearchParams(location.search).get('ground') !== '0';

/** Streamed 3D ground cover of the lidar scene: rocks, pebbles, grass, shrubs, logs. */
export const Ground: FC<GroundProps> = (props) => (ENABLED ? <GroundCover {...props} /> : null);

const GroundCover: FC<GroundProps> = ({ frame }) => {
  const gl = useThree((s) => s.gl);
  const [system, setSystem] = useState<GroundSystem | null>(null);

  useEffect(() => {
    let alive = true;
    let sys: GroundSystem | null = null;
    buildSystem(Math.min(8, gl.capabilities.getMaxAnisotropy()))
      .then((s) => {
        if (!alive) {
          s.dispose();
          return;
        }
        sys = s;
        groundRuntime.system = s;
        setSystem(s);
      })
      .catch((err: unknown) => console.error('[flytake] ground cover failed to load', err));
    return () => {
      alive = false;
      sys?.dispose();
      if (groundRuntime.system === sys) groundRuntime.system = null;
      setSystem(null);
    };
  }, [gl]);

  useEffect(() => {
    system?.setFrame(frame);
  }, [system, frame]);

  useFrame(({ camera }) => {
    system?.update(camera);
  });

  return system ? <primitive object={system.group} /> : null;
};
