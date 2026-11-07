import { useMemo, type FC } from 'react';
import { Color, SphereGeometry, SRGBColorSpace } from 'three';
import { WGS84_A, WGS84_B } from '../geo/wgs84';

/**
 * Stand-in Earth used when no tiles credentials are configured: a dark ellipsoid that the
 * atmosphere still lights and hazes, so the start screen keeps its sky, limb and stars.
 */
export const ProxyGlobe: FC = () => {
  // SphereGeometry's poles are on Y; rotate them onto ECEF Z.
  const geometry = useMemo(() => new SphereGeometry(1, 360, 180).rotateX(Math.PI / 2), []);
  const color = useMemo(() => new Color().setRGB(0.05, 0.08, 0.11, SRGBColorSpace), []);
  return (
    <mesh geometry={geometry} scale={[WGS84_A, WGS84_A, WGS84_B]}>
      <meshBasicMaterial color={color} />
    </mesh>
  );
};
