import { useFrame } from '@react-three/fiber';
import { useEffect, type FC } from 'react';
import { forestRaycast } from '../forest/collide';
import { Forest } from '../forest/Forest';
import { FOREST_LIGHT, setForestSun } from '../forest/lighting';
import { WATER_UNIFORMS } from '../scene/water';
import { world } from './handles';
import { SCENE_LIGHT } from './light';
import { onSunChange } from './sun';
import { SCENE_FRAME } from './scene';
import { Terrain, updateTerrainCamera } from './Terrain';
import { WaterReflection } from './WaterReflection';
import { ShadowFieldDriver } from './ShadowFieldDriver';
import { TeaHouse } from './TeaHouse';
import { forestRuntime } from '../forest/Forest';
import { Ground } from '../ground/Ground';

const forestGroup = () => forestRuntime.system?.group ?? null;

/** The custom lidar-built Emerald Bay scene: terrain tiles and the lidar forest. */
export const World: FC = () => {
  useEffect(() => {
    // one sun for everything: the atmosphere's (takram), expressed in the scene frame
    const unbind = onSunChange(() => setForestSun(SCENE_LIGHT.uSunDir.value));
    world.forestRaycast = forestRaycast;
    return () => {
      unbind();
      world.forestRaycast = null;
    };
  }, []);

  useFrame(({ camera }) => {
    updateTerrainCamera(camera);
    SCENE_LIGHT.uTime.value = WATER_UNIFORMS.uFlyTime.value;
    FOREST_LIGHT.uTime.value = WATER_UNIFORMS.uFlyTime.value;
  }, -1);

  return (
    <>
      <ShadowFieldDriver />
      <Terrain />
      <TeaHouse />
      <Forest url="/scene/trees.bin" frame={SCENE_FRAME} />
      <Ground frame={SCENE_FRAME} />
      <WaterReflection forest={forestGroup} />
    </>
  );
};
