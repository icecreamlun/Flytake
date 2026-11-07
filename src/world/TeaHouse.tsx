import { useEffect, useMemo, type FC } from 'react';
import { BoxGeometry, BufferGeometry, GLSL3, Group, Matrix4, Mesh, ShaderMaterial } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SCENE_LIGHT } from './light';
import { REFLECTION_LAYER, SCENE_FRAME } from './scene';
import { SHADOW_GLSL, SHADOW_UNIFORMS } from './shadowGlsl';
import { MATERIAL_UNIFORMS } from './Terrain';
import { world } from './handles';

/**
 * The stone Tea House ruin on the summit of Fannette Island (1929): a roofless one-room
 * granite-masonry hut, ~4.8 m square, window openings on three sides and a door facing the
 * Vikingsholm shore. Hand-built from boxes; the masonry pattern is procedural in the shader.
 * Placed at the lidar summit plateau (tools/scene: ENU -2.5, 0.5, 28.3 m above the origin).
 * Lit like everything else in the custom scene (pre-lit albedo, live sun + shadow field).
 */
const SITE = { e: -2.5, n: 0.5, z: 28.25, rotation: 0.35 };
const OUTER = 4.8;
const THICK = 0.45;
const HEIGHT = 3.0;
const BURY = 1.4;

interface Opening {
  /** centre along the wall from its middle (m), width, bottom, top (above the floor) */
  at: number;
  w: number;
  z0: number;
  z1: number;
}

/** One straight wall (along local x before rotation) with openings, as boxes. */
function wallBoxes(length: number, openings: Opening[], heightJitter: number[]): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const box = (x0: number, x1: number, z0: number, z1: number) => {
    if (x1 - x0 < 0.02 || z1 - z0 < 0.02) return;
    const g = new BoxGeometry(x1 - x0, THICK, z1 - z0);
    g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
    out.push(g);
  };
  const sorted = [...openings].sort((a, b) => a.at - b.at);
  let x = -length / 2;
  let seg = 0;
  const top = () => HEIGHT + (heightJitter[seg++ % heightJitter.length] ?? 0);
  for (const o of sorted) {
    const a = o.at - o.w / 2;
    const b = o.at + o.w / 2;
    box(x, a, -BURY, top());
    box(a, b, -BURY, o.z0); // below the opening (sill)
    box(a, b, o.z1, top() - 0.05); // lintel
    x = b;
  }
  box(x, length / 2, -BURY, top());
  return out;
}

function teaHouseGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const half = OUTER / 2 - THICK / 2;
  const walls: { rot: number; openings: Opening[]; jitter: number[] }[] = [
    // south: door toward the Vikingsholm shore, plus a window
    { rot: 0, openings: [{ at: 0.85, w: 0.95, z0: 0.0, z1: 2.05 }, { at: -1.05, w: 0.8, z0: 1.05, z1: 1.95 }], jitter: [0.0, -0.06, 0.02, -0.03, 0.03] },
    { rot: Math.PI / 2, openings: [{ at: 0, w: 1.0, z0: 1.0, z1: 2.0 }], jitter: [-0.04, 0.02, -0.08] },
    { rot: Math.PI, openings: [{ at: 0, w: 1.1, z0: 1.0, z1: 2.05 }], jitter: [0.0, -0.05, 0.03] },
    { rot: -Math.PI / 2, openings: [{ at: 0.3, w: 0.9, z0: 1.05, z1: 1.95 }], jitter: [0.03, -0.02, 0.0] },
  ];
  const m = new Matrix4();
  for (const w of walls) {
    // the walls overlap at the corners (length = outer size) so the corners are solid
    for (const g of wallBoxes(OUTER, w.openings, w.jitter)) {
      m.makeRotationZ(w.rot).multiply(new Matrix4().makeTranslation(0, -half, 0));
      g.applyMatrix4(m);
      parts.push(g);
    }
  }
  // chimney stub in the north-east corner
  const ch = new BoxGeometry(0.9, 0.9, HEIGHT + BURY + 0.9);
  ch.translate(OUTER / 2 - 0.45, OUTER / 2 - 0.45, (HEIGHT + 0.9 - BURY) / 2);
  parts.push(ch);
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()), false);
  for (const p of parts) p.dispose();
  return merged;
}

const VERT = /* glsl */ `
uniform mat4 uLocalToEnu;
out vec3 vEnu;
out vec3 vLocal;
out vec3 vN;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vLocal = position;
  vEnu = (uLocalToEnu * vec4(position, 1.0)).xyz;
  vN = normalize(mat3(uLocalToEnu) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform float uFlatSunInv;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform sampler2DArray uMatC;
uniform float uMatOn;
uniform mat4 uLocalToEnu;
${SHADOW_GLSL}
in vec3 vEnu;
in vec3 vLocal;
in vec3 vN;
out vec4 fragColor;
#include <logdepthbuf_pars_fragment>

float thHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  #include <logdepthbuf_fragment>
  // wall-plane coordinates in the hut's own frame: (along the wall, up)
  vec3 nl = normalize(mat3(transpose(mat3(uLocalToEnu))) * vN);
  vec2 wc = abs(nl.x) > abs(nl.y) ? vec2(vLocal.y, vLocal.z) : vec2(vLocal.x, vLocal.z);
  if (abs(nl.z) > 0.7) wc = vLocal.xy * vec2(1.0, 1.0) + 13.0;
  // rubble masonry: uneven courses of fieldstone, joints wobbling so no two stones align
  float ch = 0.36;
  vec2 q = wc + vec2(0.0, 0.025 * sin(wc.x * 2.3 + floor(wc.y / 0.36) * 1.7));
  float row = floor(q.y / ch);
  float rowOff = thHash(vec2(row, 3.0)) * 0.9;
  float qx = q.x;
  float sw = mix(0.42, 0.95, thHash(vec2(row, 7.0)));
  float u = (qx + rowOff) / sw;
  float col = floor(u);
  vec2 cell = vec2(fract(u), fract(q.y / ch));
  vec2 id = vec2(col, row);
  float h1 = thHash(id);
  float h2 = thHash(id + 17.3);
  // distance to the joint, with a bulging, rounded stone face
  vec2 d = min(cell, 1.0 - cell) * vec2(sw, ch);
  float edge = min(d.x, d.y);
  float joint = 1.0 - smoothstep(0.01, 0.03, edge);
  // granite texture (terrain ground-material layer 3) for the stone grain
  vec3 grain = vec3(1.0);
  if (uMatOn > 0.5) grain = texture(uMatC, vec3(wc * 0.45 + id * 0.37, 3.0)).rgb / vec3(0.4011, 0.3401, 0.2733);
  vec3 stone = vec3(0.095, 0.093, 0.088) * mix(0.55, 1.35, h1) * mix(vec3(1.0), vec3(1.12, 1.0, 0.86), h2) * mix(vec3(1.0), grain, 0.8);
  vec3 mortar = vec3(0.05, 0.048, 0.044);
  vec3 albedo = mix(stone, mortar, joint);
  // weathering: darker toward the ground, lichen spots
  albedo *= mix(0.7, 1.0, smoothstep(-0.3, 1.2, vLocal.z));
  // stone faces bulge: tilt the normal away from the joints
  vec3 N = normalize(vN);
  vec3 T = normalize(cross(vec3(0.0, 0.0, 1.0), N) + vec3(1e-4));
  float bx = (cell.x - 0.5) * 2.0;
  float by = (cell.y - 0.5) * 2.0;
  N = normalize(N + (T * bx + vec3(0.0, 0.0, 1.0) * by) * 0.35 * (1.0 - joint) * (1.0 - smoothstep(0.03, 0.12, edge)));
  // sampled 0.6 m out from the wall: the hut's own footprint is in the shadow field
  float sunVis = flySunVis(vEnu + normalize(vN) * 0.6, 0.4);
  float ndl = max(dot(N, uSunDir), 0.0);
  float ao = mix(0.55, 1.0, smoothstep(-0.5, 1.5, vLocal.z)) * mix(0.6, 1.0, 1.0 - joint);
  vec3 lit = albedo * (sunVis * ndl * uSunColor + uAmbient * ao * (0.7 + 0.3 * N.z));
  fragColor = vec4(lit * uFlatSunInv, 1.0);
}
`;

export const TeaHouse: FC = () => {
  const group = useMemo(() => {
    const g = new Group();
    g.matrixAutoUpdate = false;
    g.matrix.copy(SCENE_FRAME);
    g.matrixWorldNeedsUpdate = true;
    const local = new Matrix4().makeRotationZ(SITE.rotation).setPosition(SITE.e, SITE.n, SITE.z);
    const material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...SCENE_LIGHT,
        ...SHADOW_UNIFORMS,
        uMatC: MATERIAL_UNIFORMS.uMatC,
        uMatOn: MATERIAL_UNIFORMS.uMatOn,
        uLocalToEnu: { value: local },
      },
    });
    const mesh = new Mesh(teaHouseGeometry(), material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(local);
    mesh.layers.enable(REFLECTION_LAYER);
    mesh.name = 'tea-house';
    g.add(mesh);
    return g;
  }, []);
  useEffect(() => {
    world.props.push(group);
    // its footprint casts a shadow (wall tops, as a solid block: close enough for a small hut)
    const c = Math.cos(SITE.rotation);
    const sn = Math.sin(SITE.rotation);
    const h = OUTER / 2;
    const corners = ([[-h, -h], [h, -h], [h, h], [-h, h]] as const).map(([x, y]) => [SITE.e + c * x - sn * y, SITE.n + sn * x + c * y] as [number, number]);
    const id = window.setInterval(() => {
      if (!world.shadow?.ready) return;
      world.shadow.addProp(corners, SITE.z + HEIGHT);
      window.clearInterval(id);
    }, 500);
    return () => {
      window.clearInterval(id);
      world.props = world.props.filter((p) => p !== group);
      group.traverse((o) => {
        const m = o as Mesh;
        m.geometry?.dispose();
        (m.material as ShaderMaterial | undefined)?.dispose?.();
      });
    };
  }, [group]);
  return <primitive object={group} />;
};
