/**
 * Forest look-dev page: http://localhost:5173/forest.html
 *   ?pose=close|drone|backlit|high|canopy   screenshot poses (default drone)
 *   ?n=50000                                 synthetic tree count
 *   ?sun=230,18                              sun azimuth (deg from north, clockwise), elevation
 *   ?only=0..3                               a single species
 * World == ENU here (x east, y north, z up); the Forest frame is identity.
 */
import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { EffectComposer, SMAA, ToneMapping, wrapEffect } from '@react-three/postprocessing';
import { BlendFunction, Effect, EffectAttribute, ToneMappingMode } from 'postprocessing';
import { StrictMode, useEffect, useMemo, useRef, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import { Mesh, PlaneGeometry, ShaderMaterial, Uniform, Vector3, type PerspectiveCamera } from 'three';
import { encodeTrees, parseTrees, type ForestData, type TreeRecord } from './data';
import { Forest, forestRuntime } from './Forest';
import { FOREST_LIGHT, LIGHT_FUNCS, LIGHT_PARS, setForestSun } from './lighting';

const params = new URLSearchParams(location.search);
const POSE = params.get('pose') ?? 'drone';
const COUNT = Number(params.get('n') ?? 50000);
const ONLY = params.get('only');
const LOD_MODE = params.get('lod');
const LOD_OVERRIDE =
  LOD_MODE === 'imp'
    ? { lod0: 0.01, lod0Fade: 0.005, lod1: 0.02, lod1Fade: 0.01 }
    : LOD_MODE === 'mesh1'
      ? { lod0: 0.01, lod0Fade: 0.005, lod1: 100000, lod1Fade: 1 }
      : LOD_MODE === 'mesh0'
        ? { lod0: 100000, lod0Fade: 1, lod1: 100001, lod1Fade: 0.5 }
        : undefined;
const [SUN_AZ, SUN_EL] = (params.get('sun') ?? '230,18.1').split(',').map(Number) as [number, number];

function sunDir(azDeg: number, elDeg: number): Vector3 {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return new Vector3(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el));
}
setForestSun(sunDir(SUN_AZ, SUN_EL));
if (params.get('debug') != null) FOREST_LIGHT.uForestDebug.value = Number(params.get('debug'));
if (params.get('amb') != null) FOREST_LIGHT.uAmbient.value.multiplyScalar(Number(params.get('amb')));

// ---------------------------------------------------------------------------------------------
// synthetic terrain + trees

const groundHeight = (e: number, n: number): number =>
  38 * Math.sin(e / 310) * Math.cos(n / 370) + 22 * Math.sin((e + n) / 180) + 6 * Math.sin(e / 61) * Math.cos(n / 77);

function hash(i: number): number {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
function valueNoise(e: number, n: number, scale: number): number {
  const x = e / scale;
  const y = n / scale;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const h = (a: number, b: number): number => hash(a * 73856093 + b * 19349663);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  return (h(xi, yi) * (1 - sx) + h(xi + 1, yi) * sx) * (1 - sy) + (h(xi, yi + 1) * (1 - sx) + h(xi + 1, yi + 1) * sx) * sy;
}

/** Look-dev clearing with one specimen of each kind, in a row along x (east). */
export const CLEARING = { e: 300, n: -200, r: 110 };
const SPECIMENS: [number, number, number][] = [
  // species, height, crown radius
  [0, 26, 3.6],
  [1, 28, 5.2],
  [2, 18, 2.3],
  [3, 20, 1.6],
  [0, 9, 2.4],
  [1, 9, 2.6],
];
export const specimenAt = (k: number): [number, number] => [CLEARING.e - 30 + k * 12, CLEARING.n];

function synthTrees(count: number): ArrayBuffer {
  const trees: TreeRecord[] = [];
  SPECIMENS.forEach(([species, height, crownRadius], k) => {
    const [e, n] = specimenAt(k);
    trees.push({ e, n, u: groundHeight(e, n), height, crownRadius, species, seed: 0, sunTop: 255, sunBase: 255 });
  });
  const cell = 5;
  const half = Math.sqrt(count / 0.24) * cell * 0.5;
  let k = 0;
  for (let n = -half; n < half; n += cell) {
    for (let e = -half; e < half; e += cell) {
      k++;
      const dens = Math.min(0.95, Math.max(0, valueNoise(e, n, 220) * 1.25 - 0.3 + valueNoise(e, n, 60) * 0.35));
      if (hash(k * 7 + 1) > dens) continue;
      const te = e + (hash(k * 7 + 2) - 0.5) * cell * 0.9;
      const tn = n + (hash(k * 7 + 3) - 0.5) * cell * 0.9;
      if (Math.hypot(te - CLEARING.e, tn - CLEARING.n) < CLEARING.r) continue;
      const r = hash(k * 7 + 4);
      const pineZone = valueNoise(te + 900, tn - 400, 300);
      let species = r < 0.08 ? 3 : r < 0.08 + 0.55 * pineZone ? 1 : r < 0.92 - 0.2 * pineZone ? 0 : 2;
      if (ONLY != null) species = Number(ONLY);
      const g = hash(k * 7 + 5);
      const base = [22, 25, 14, 18][species]!;
      const height = Math.min(48, Math.max(5, base * Math.exp((g - 0.5) * 0.9)));
      const cr = height * [0.12, 0.16, 0.1, 0.07][species]! * (0.85 + 0.3 * hash(k * 7 + 6)) + 0.4;
      const shade = valueNoise(te - 300, tn + 200, 90);
      trees.push({
        e: te,
        n: tn,
        u: groundHeight(te, tn),
        height,
        crownRadius: cr,
        species,
        seed: Math.floor(hash(k * 7 + 7) * 256) & 255,
        sunTop: shade < 0.25 ? 150 : 255,
        sunBase: Math.round(255 * Math.min(1, 0.45 + 0.8 * (1 - dens) + (shade < 0.25 ? -0.2 : 0))),
      });
      if (trees.length >= count) break;
    }
    if (trees.length >= count) break;
  }
  return encodeTrees(trees);
}

const GROUND_VERT = /* glsl */ `
varying vec3 vPos;
varying vec3 vN;
void main() {
  vPos = position;
  vN = normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const GROUND_FRAG = /* glsl */ `
${LIGHT_PARS}
${LIGHT_FUNCS}
varying vec3 vPos;
varying vec3 vN;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float n1 = vn(vPos.xy / 23.0), n2 = vn(vPos.xy / 3.1), n3 = vn(vPos.xy / 0.7);
  vec3 litter = vec3(0.13, 0.085, 0.05);
  vec3 granite = vec3(0.32, 0.30, 0.27);
  vec3 grass = vec3(0.10, 0.12, 0.05);
  vec3 a = mix(litter, granite, smoothstep(0.62, 0.8, n1));
  a = mix(a, grass, smoothstep(0.55, 0.8, n2) * 0.5);
  a *= 0.75 + 0.5 * n3;
  vec3 N = normalize(vN);
  float ndl = max(dot(N, uSunDir), 0.0);
  gl_FragColor = vec4(a * (ndl * 0.75 + uAmbient * (0.6 + 0.4 * N.z)) * uFlatSunInv, 1.0);
}`;

const Ground: FC = () => {
  const mesh = useMemo(() => {
    const g = new PlaneGeometry(4000, 4000, 400, 400);
    const p = g.attributes.position!;
    for (let i = 0; i < p.count; i++) p.setZ(i, groundHeight(p.getX(i), p.getY(i)));
    g.computeVertexNormals();
    const m = new Mesh(g, new ShaderMaterial({ uniforms: { ...FOREST_LIGHT }, vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG }));
    m.raycast = () => {};
    return m;
  }, []);
  return <primitive object={mesh} />;
};

// ---------------------------------------------------------------------------------------------
// approximation of the main app's post stack: sun irradiance relighting + haze + AgX

const DEV_FRAG = /* glsl */ `
uniform vec3 uSunColor;
uniform vec3 uSky;
uniform vec3 uHorizon;
uniform float uFlatSun;
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  if (depth >= 0.99999) {
    outputColor = vec4(mix(uHorizon, uSky, smoothstep(0.2, 1.0, uv.y)), 1.0);
    return;
  }
  float dist = -getViewZ(depth);
  vec3 c = inputColor.rgb * uSunColor * uFlatSun;
  float haze = 1.0 - exp(-dist / 9000.0);
  outputColor = vec4(mix(c, uHorizon, haze), 1.0);
}`;
class DevLightEffect extends Effect {
  constructor() {
    super('DevLight', DEV_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['uSunColor', new Uniform(new Vector3(2.2, 1.9, 1.55))],
        ['uSky', new Uniform(new Vector3(0.28, 0.45, 0.85))],
        ['uHorizon', new Uniform(new Vector3(0.75, 0.78, 0.82))],
        ['uFlatSun', new Uniform(Math.max(FOREST_LIGHT.uSunDir.value.z, 0.05))],
      ]),
    });
  }
}
const DevLight = wrapEffect(DevLightEffect);

// ---------------------------------------------------------------------------------------------

interface Pose {
  pos: [number, number, number];
  target: [number, number, number];
}

/** Tree of a species / height range nearest to the origin (pose anchor). */
function heroTree(data: ForestData, species: number, hMin: number, hMax: number): [number, number, number, number] {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < data.count; i++) {
    if (data.species[i] !== species || data.height[i]! < hMin || data.height[i]! > hMax) continue;
    const d = data.e[i]! ** 2 + data.n[i]! ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best < 0 ? [0, 0, groundHeight(0, 0), 20] : [data.e[best]!, data.n[best]!, data.u[best]!, data.height[best]!];
}

function pose(name: string, data: ForestData): Pose {
  const g = groundHeight;
  // camera on the sunny side (sun from the south-west), looking north-east-ish
  const at = (t: [number, number, number, number], dist: number, camH: number, lookH: number, az = 225): Pose => {
    const a = (az * Math.PI) / 180;
    const x = t[0] + Math.sin(a) * dist;
    const y = t[1] + Math.cos(a) * dist;
    return { pos: [x, y, g(x, y) + camH], target: [t[0], t[1], t[2] + lookH] };
  };
  const spec = (k: number, dist: number, camH: number, lookH: number, az = 170): Pose => {
    const [e, n] = specimenAt(k);
    return at([e, n, g(e, n), 0], dist, camH, lookH, az);
  };
  switch (name) {
    case 'specimens':
      return { pos: [CLEARING.e, CLEARING.n - 62, g(CLEARING.e, CLEARING.n - 62) + 9], target: [CLEARING.e, CLEARING.n, g(CLEARING.e, CLEARING.n) + 11] };
    case 'specimensback':
      return { pos: [CLEARING.e, CLEARING.n + 62, g(CLEARING.e, CLEARING.n + 62) + 9], target: [CLEARING.e, CLEARING.n, g(CLEARING.e, CLEARING.n) + 11] };
    case 'fir':
      return spec(0, 20, 5, 12);
    case 'firback':
      return spec(0, 20, 5, 12, 20);
    case 'jeffreyback':
      return spec(1, 22, 6, 15, 20);
    case 'jeffrey':
      return spec(1, 22, 6, 15);
    case 'lodgepole':
      return spec(2, 15, 4, 9);
    case 'snag':
      return spec(3, 15, 4, 10);
    case 'youngs':
      return { pos: [specimenAt(4)[0] + 6, CLEARING.n - 16, g(specimenAt(4)[0] + 6, CLEARING.n - 16) + 3], target: [specimenAt(4)[0] + 6, CLEARING.n, g(specimenAt(4)[0], CLEARING.n) + 3.5] };
    case 'close':
      return at(heroTree(data, 0, 20, 28), 13, 6, 0.5 * heroTree(data, 0, 20, 28)[3], 160);
    case 'pine':
      return at(heroTree(data, 1, 22, 32), 15, 8, 0.65 * heroTree(data, 1, 22, 32)[3], 160);
    case 'trunk':
      return at(heroTree(data, 1, 22, 32), 7, 1.6, 4, 150);
    case 'young':
      return at(heroTree(data, 0, 6, 11), 8, 3, 3, 170);
    case 'closeback': {
      const t = heroTree(data, 0, 20, 28);
      return at(t, 13, 6, 0.55 * t[3], 45);
    }
    case 'canopy':
      return { pos: [-30, -60, g(-30, -60) + 45], target: [40, 30, g(40, 30) + 10] };
    case 'backlit':
      return { pos: [180, 160, g(180, 160) + 40], target: [60, 50, g(60, 50)] };
    case 'low':
      return { pos: [-120, -110, g(-120, -110) + 12], target: [-40, -30, g(-40, -30) + 14] };
    case 'high':
      return { pos: [-450, -450, g(-450, -450) + 500], target: [100, 100, g(100, 100)] };
    case 'drone':
    default:
      return { pos: [-160, -150, g(-160, -150) + 40], target: [-40, -30, g(-40, -30)] };
  }
}

const Rig: FC<{ data: ForestData }> = ({ data }) => {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const controls = useRef<{ target: Vector3; update(): void } | null>(null);
  useEffect(() => {
    const p = pose(POSE, data);
    camera.position.set(...p.pos);
    camera.near = 0.1;
    camera.far = 30000;
    camera.updateProjectionMatrix();
    controls.current?.target.set(...p.target);
    controls.current?.update();
    (window as unknown as { __forestPose: (name: string) => void }).__forestPose = (name: string) => {
      const q = pose(name, data);
      camera.position.set(...q.pos);
      controls.current?.target.set(...q.target);
      controls.current?.update();
    };
  }, [camera, data]);
  return <OrbitControls ref={controls as never} makeDefault enableDamping={false} />;
};

const Stats: FC = () => {
  const gl = useThree((s) => s.gl);
  const st = useRef({ frames: 0, t: performance.now(), fps: 0, tris: 0, calls: 0 });
  useEffect(() => {
    gl.info.autoReset = false;
  }, [gl]);
  useFrame(() => {
    const s = st.current;
    s.tris = gl.info.render.triangles;
    s.calls = gl.info.render.calls;
    gl.info.reset();
    s.frames++;
    const now = performance.now();
    if (now - s.t > 500) {
      s.fps = (s.frames * 1000) / (now - s.t);
      s.frames = 0;
      s.t = now;
      const el = document.getElementById('stats');
      const sys = forestRuntime.system;
      if (el)
        el.textContent = `${s.fps.toFixed(0)} fps · ${(s.tris / 1e6).toFixed(2)} M tris · ${s.calls} calls · lod0 ${sys?.stats.lod0 ?? 0} · lod1 ${sys?.stats.lod1 ?? 0} · select ${(sys?.stats.selectMs ?? 0).toFixed(2)} ms`;
    }
  });
  useEffect(() => {
    (window as unknown as { __forest: unknown }).__forest = {
      ready: () => forestRuntime.system != null,
      stats: () => ({
        fps: st.current.fps,
        triangles: st.current.tris,
        calls: st.current.calls,
        ...forestRuntime.system?.stats,
      }),
    };
  }, [gl]);
  return null;
};

const App: FC = () => {
  const data = useMemo(() => parseTrees(synthTrees(COUNT)), []);
  return (
    <>
      <Canvas
        gl={{ depth: false, stencil: false, antialias: false, alpha: false, powerPreference: 'high-performance' }}
        dpr={[1, 1.5]}
        flat
        camera={{ fov: 48, near: 0.1, far: 30000, up: [0, 0, 1], position: [0, -100, 60] }}
        onCreated={({ camera }) => camera.up.set(0, 0, 1)}
      >
        <Ground />
        <Forest data={data} lod={LOD_OVERRIDE} />
        <Rig data={data} />
        <Stats />
        <EffectComposer multisampling={0}>
          <DevLight />
          <ToneMapping mode={ToneMappingMode.AGX} />
          <SMAA />
        </EffectComposer>
      </Canvas>
      <div id="stats" style={{ position: 'fixed', left: 8, top: 8, font: '12px monospace', color: '#fff', textShadow: '0 1px 2px #000' }} />
    </>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
