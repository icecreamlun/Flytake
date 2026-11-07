/** Instanced clock hands for tower clocks; they show the simulated local time (env.timeOfDay). */
import * as THREE from 'three';
import { lmMaterial } from './materials';

export interface Dial {
  /** Dial centre (in the parent's frame) and outward direction (horizontal). */
  centre: THREE.Vector3;
  normal: THREE.Vector3;
  radius: number;
}

export function clockHands(dials: Dial[]): { mesh: THREE.InstancedMesh; set(hours: number): void } {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  geo.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count), 1));
  const mat = lmMaterial({ color: '#17140f', roughness: 0.5, metalness: 0.4, vertexColors: false });
  const mesh = new THREE.InstancedMesh(geo, mat, dials.length * 2);
  mesh.castShadow = true;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  let last = -1;
  return {
    mesh,
    set(hours: number) {
      const minute = Math.floor(hours * 60);
      if (minute === last) return;
      last = minute;
      const hA = ((hours % 12) / 12) * Math.PI * 2;
      const mA = (((hours * 60) % 60) / 60) * Math.PI * 2;
      dials.forEach((d, i) => {
        const ry = Math.atan2(d.normal.x, d.normal.z);
        for (const [k, ang, len, w] of [
          [0, hA, 0.62, 0.085],
          [1, mA, 0.9, 0.055],
        ] as const) {
          e.set(0, ry, -ang, 'YXZ');
          q.setFromEuler(e);
          s.set(w * d.radius, len * d.radius, 0.02 * d.radius + 0.02);
          p.copy(d.centre).addScaledVector(d.normal, 0.04 + k * 0.03);
          m4.compose(p, q, s);
          mesh.setMatrixAt(i * 2 + k, m4);
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
