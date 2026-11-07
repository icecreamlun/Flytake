/**
 * Cinematic camera presets. Heights marked `agl` are metres above the local terrain and are resolved
 * with the ground sampler when one is set (so street-level shots never end up inside a hill).
 */
import type { CameraPreset, CameraPresetId } from '../../contracts';

interface PresetDef {
  id: CameraPresetId;
  label: string;
  /** [x, y, z]; y is absolute unless posAgl. */
  position: [number, number, number];
  target: [number, number, number];
  posAgl?: boolean;
  targetAgl?: boolean;
  fov?: number;
}

const DEFS: PresetDef[] = [
  // High oblique from over the bay (south-east) looking north-west across FiDi → Chinatown → Telegraph Hill.
  { id: 'overview', label: 'Overview', position: [1500, 720, 1250], target: [-420, 40, -380] },
  // Ferry Building from the Embarcadero plaza side: west façade + clock tower, bay and Yerba Buena behind.
  { id: 'ferry', label: 'Ferry Building', position: [236, 16, -284], target: [401, 36, -222], posAgl: true },
  // Oblique over Grant Ave / Portsmouth Square.
  { id: 'chinatown', label: 'Chinatown', position: [-735, 250, 330], target: [-700, 10, -150], targetAgl: true },
  // Pedestrian-ish view ~25 m up Grant Ave from near Bush St, looking north.
  { id: 'street', label: 'Grant Ave', position: [-674, 25, 285], target: [-750, 14, -155], posAgl: true, targetAgl: true },
  // Looking up at the pyramid from Columbus / Washington.
  { id: 'transamerica', label: 'Transamerica', position: [-575, 7, -370], target: [-432, 118, -196], posAgl: true },
  // Along the waterfront promenade toward the Ferry Building.
  { id: 'embarcadero', label: 'Embarcadero', position: [690, 16, 150], target: [400, 18, -222], posAgl: true, targetAgl: true },
  // From the Bay Bridge side at altitude.
  { id: 'aerial_east', label: 'From the Bay', position: [2300, 620, 760], target: [-250, 0, -150] },
];

export function buildPresets(ground?: (x: number, z: number) => number): CameraPreset[] {
  return DEFS.map((d) => {
    const p: [number, number, number] = [...d.position];
    const t: [number, number, number] = [...d.target];
    if (ground) {
      if (d.posAgl) p[1] += Math.max(ground(p[0], p[2]), 0);
      if (d.targetAgl) t[1] += Math.max(ground(t[0], t[2]), 0);
      else if (d.target[1] === 0) t[1] = Math.max(ground(t[0], t[2]), 0);
    }
    return { id: d.id, label: d.label, position: p, target: t, ...(d.fov ? { fov: d.fov } : {}) };
  });
}
