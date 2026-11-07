/**
 * Render engine — composition of renderer, sky/atmosphere, lights + fitted shadows, bay water,
 * distant backdrop, camera rig and the post-processing chain. Implements the Engine contract.
 *
 * Depth: standard 24-bit depth with a DYNAMIC near plane (0.5 m at street level → up to 60 m from
 * the air, see camera/rig.ts) and far = 80 km. That keeps sub-centimetre precision where it
 * matters (road decals use polygonOffset) and stays compatible with n8ao / postprocessing, which
 * a logarithmic or reversed depth buffer would complicate.
 */
import './fog';
import './ambient';
import './shadowFilter';
import * as THREE from 'three';
import type { CameraDriver, CameraPreset, CameraPresetId, Engine, EnvironmentState, EventBus, UpdateFn } from '../contracts';
import { CONTEXT_BBOX, project } from '../geo';
import { Lighting } from './lighting';
import { SkySystem } from './sky/skySystem';
import { BayWater } from './water';
import { CameraRig } from './camera/rig';
import { buildPresets } from './camera/presets';
import { createPostChain } from './post';
import { buildBackdrop, type Backdrop } from './backdrop';
import type { Rect } from './backdrop/farTerrain';
import { ViewRenderer } from './views';

const MAX_PIXEL_RATIO = 1.5;
const FAR = 80000;

export function createEngine(container: HTMLElement): Engine {
  const renderer = new THREE.WebGLRenderer({
    antialias: false, // SMAA in post
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
    alpha: false,
  });
  let pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  renderer.setPixelRatio(pixelRatio);
  const size = () => ({ w: container.clientWidth || window.innerWidth, h: container.clientHeight || window.innerHeight });
  renderer.setSize(size().w, size().h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping; // tone mapping happens in post
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.touchAction = 'none';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.name = 'argus';
  const fog = new THREE.FogExp2(0xb8c6d4, 0.0001);
  scene.fog = fog;
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(40, size().w / size().h, 1, FAR);
  camera.position.set(1450, 980, 1150);

  const env: EnvironmentState = { timeOfDay: 16.5, sunDirection: new THREE.Vector3(0, 1, 0), nightFactor: 0, haze: 0 };
  const lighting = new Lighting(scene);
  const sky = new SkySystem(renderer, scene, lighting, env, fog);
  const water = new BayWater();
  scene.add(water.mesh);
  const rig = new CameraRig(camera, renderer.domElement);
  const post = createPostChain(renderer, scene, camera);
  const views = new ViewRenderer(renderer, scene);

  const cameraPresets: CameraPreset[] = buildPresets();
  let ground: ((x: number, z: number) => number) | null = null;
  let backdrop: Backdrop | null = null;
  let terrainRect: Rect | null = null;
  let bus: EventBus | null = null;

  // ── Backdrop needs the terrain extent + sampler; fetch the (tiny) terrain meta ourselves. ──
  fetch('/sf/data/terrain.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((meta) => {
      if (!meta) return;
      terrainRect = {
        minX: meta.minX,
        minZ: meta.minZ,
        maxX: meta.minX + (meta.cols - 1) * meta.cellSize,
        maxZ: meta.minZ + (meta.rows - 1) * meta.cellSize,
      };
      tryBuildBackdrop();
    })
    .catch(() => {});

  function tryBuildBackdrop() {
    if (backdrop || !ground || !terrainRect) return;
    const [x0, z0] = project(CONTEXT_BBOX.north, CONTEXT_BBOX.west);
    const [x1, z1] = project(CONTEXT_BBOX.south, CONTEXT_BBOX.east);
    const t0 = performance.now();
    backdrop = buildBackdrop({ rect: terrainRect, ground, dataRect: { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } });
    scene.add(backdrop.group);
    water.setDepthSource({ ground, ...terrainRect });
    backdrop.setNight(env.nightFactor, sky.state.exposure);
    debug.backdropMs = Math.round(performance.now() - t0);
  }

  // ── Time of day / haze ──
  let hazeDirty = false;
  let lastHazeApply = 0;
  const applyEnvironment = (force = false) => {
    sky.apply(force);
    renderer.toneMappingExposure = sky.state.exposure;
    post.bloom.luminanceMaterial.threshold = 2.2 / sky.state.exposure;
    gradeForTime();
    backdrop?.setNight(env.nightFactor, sky.state.exposure);
    bus?.emit({ type: 'environment-changed', env });
  };

  /**
   * Colour grade follows the light: slightly warm daylight with neutral (not blue) shadows and a
   * filmic toe/shoulder after AgX; warmer golden hour; cool-blue night.
   */
  function gradeForTime() {
    const e = sky.state.sunElevation;
    const golden = THREE.MathUtils.smoothstep(e, -4, 2) * (1 - THREE.MathUtils.smoothstep(e, 10, 22));
    const night = env.nightFactor;
    const day = (1 - night) * (1 - golden);
    post.grade.set({
      saturation: 1.1 + golden * 0.1 - night * 0.12,
      toe: 1.26 + golden * 0.04 - night * 0.1,
      shoulder: 1.12,
      pivot: 0.46,
      shadow: new THREE.Vector3(1.0 + golden * 0.01 - night * 0.03, 1.0, 0.99 + golden * 0.02 + night * 0.06),
      highlight: new THREE.Vector3(1.025 + golden * 0.05, 1.0 + golden * 0.01, 0.965 - golden * 0.05 - night * 0.02),
      lift: night * 0.004,
    });
    // Eye/camera adaptation to the light colour: strong by day, none at night (blue nights are the look),
    // plus a slightly warm daylight balance.
    const illum = sky.state.sunColor.clone().multiplyScalar(Math.max(env.sunDirection.y, 0) * 5).add(sky.state.skyIrradiance);
    const warm = new THREE.Vector3(1 + 0.03 * day, 1, 1 - 0.05 * day);
    post.whiteBalance.setIlluminant(illum, 0.45 * (1 - 0.75 * golden) * (1 - night), warm);
    // Bay reflections: soft by day, long light streaks at night.
    post.waterReflection.set(1, THREE.MathUtils.lerp(0.002, 0.0055, night));
  }

  // ── Resize & adaptive resolution ──
  const onResize = () => {
    const { w, h } = size();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    post.setSize(w, h);
  };
  window.addEventListener('resize', onResize);
  const resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(onResize) : null;
  resizeObserver?.observe(container);

  let fpsAcc = 0;
  let fpsFrames = 0;
  let lowFor = 0;
  let highFor = 0;
  const adaptResolution = (dt: number) => {
    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc < 1) return;
    const fps = fpsFrames / fpsAcc;
    fpsAcc = 0;
    fpsFrames = 0;
    const maxPr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    lowFor = fps < 38 ? lowFor + 1 : 0;
    highFor = fps > 57 ? highFor + 1 : 0;
    let next = pixelRatio;
    if (lowFor >= 3 && pixelRatio > 1) next = Math.max(1, pixelRatio - 0.25);
    if (highFor >= 5 && pixelRatio < maxPr) next = Math.min(maxPr, pixelRatio + 0.25);
    if (next !== pixelRatio) {
      pixelRatio = next;
      lowFor = highFor = 0;
      renderer.setPixelRatio(pixelRatio);
      onResize();
    }
  };

  // ── Per-frame ──
  let aoRadius = 0;
  const timer = new THREE.Timer();
  timer.connect(document);
  const perf = { calls: 0, triangles: 0, points: 0, lines: 0, geometries: 0, textures: 0, programs: 0, frameMs: 0, pixelRatio };
  const debug: Record<string, unknown> = { backdropMs: 0 };

  // ── Flytake: external camera driver (drone). See Engine.setCameraDriver. ──
  let driver: CameraDriver | null = null;
  const driverFocus = new THREE.Vector3();
  const driverFwd = new THREE.Vector3();
  let driverDistance = 100;

  function runDriver(dt: number) {
    if (!driver) return;
    driver(camera, dt);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    // Stand-in for the orbit target (shadow fit + AO radius): where the view meets the ground,
    // or a point ahead scaled by the height above ground when looking at / above the horizon.
    const p = camera.position;
    const g = Math.max(ground ? ground(p.x, p.z) : 0, 0);
    const agl = Math.max(p.y - g, 0);
    camera.getWorldDirection(driverFwd);
    const reach = driverFwd.y < -0.05 ? agl / -driverFwd.y : 120 + agl * 2;
    driverDistance = THREE.MathUtils.clamp(reach, 30, 1500);
    driverFocus.copy(p).addScaledVector(driverFwd, driverDistance);
    driverFocus.y = Math.max(ground ? ground(driverFocus.x, driverFocus.z) : 0, 0);
  }

  function frameInternals(dt: number, elapsed: number) {
    if (hazeDirty && elapsed - lastHazeApply > 0.15) {
      hazeDirty = false;
      lastHazeApply = elapsed;
      applyEnvironment();
    }
    if (!driver) rig.update(dt);
    const dist = driver ? driverDistance : rig.distance;
    lighting.fitShadow(camera, driver ? driverFocus : rig.focus(), dist);
    // AO follows the viewing scale: ~4 m contact AO at street level (kerbs, doorways, building feet),
    // block-scale from the air. Driven by the camera's height above the ground, not the orbit distance
    // (a street-level camera aimed down a long avenue still wants tight contact AO).
    const agl = camera.position.y - Math.max(ground ? ground(camera.position.x, camera.position.z) : 0, 0);
    const want = THREE.MathUtils.clamp(3.8 + Math.max(agl, 0) * 0.028 + dist * 0.002, 3.8, 22);
    if (Math.abs(want - aoRadius) / Math.max(aoRadius, 1e-3) > 0.12) {
      aoRadius = want;
      const c = post.ao.configuration;
      c.aoRadius = want;
      c.distanceFalloff = 1.0;
      c.intensity = THREE.MathUtils.lerp(2.9, 2.3, THREE.MathUtils.smoothstep(want, 4, 20));
    }
    water.update(elapsed, env.nightFactor);
    sky.update(elapsed);
    backdrop?.update(elapsed);
  }

  function renderFrame(dt: number) {
    const t0 = performance.now();
    renderer.info.reset();
    post.render(dt);
    const i = renderer.info;
    perf.calls = i.render.calls;
    perf.triangles = i.render.triangles;
    perf.points = i.render.points;
    perf.lines = i.render.lines;
    perf.geometries = i.memory.geometries;
    perf.textures = i.memory.textures;
    perf.programs = i.programs?.length ?? 0;
    perf.frameMs = performance.now() - t0;
    perf.pixelRatio = pixelRatio;
  }

  const w = window as unknown as { __argus?: Record<string, unknown> };
  if (w.__argus) {
    w.__argus.perf = perf;
    w.__argus.engineDebug = { sky, lighting, rig, post, water, debug, getBackdrop: () => backdrop, raycasterCtor: THREE.Raycaster, THREE };
  }

  applyEnvironment(true);
  rig.flyTo(new THREE.Vector3(...cameraPresets[0].position), new THREE.Vector3(...cameraPresets[0].target), 0);

  const engine: Engine = {
    scene,
    camera,
    renderer,
    env,
    sun: lighting.sun,
    cameraPresets,
    setTimeOfDay(hours: number) {
      env.timeOfDay = ((hours % 24) + 24) % 24;
      applyEnvironment();
    },
    setHaze(amount: number) {
      const a = THREE.MathUtils.clamp(amount, 0, 1);
      if (Math.abs(a - env.haze) < 1e-3) return;
      env.haze = a;
      sky.setHaze(a);
      hazeDirty = true;
    },
    setCameraShake(amplitude: number) {
      rig.setShake(amplitude);
    },
    flyTo(pose, duration = 0) {
      let p: { position: [number, number, number]; target: [number, number, number] } | undefined;
      if (typeof pose === 'string') p = cameraPresets.find((c) => c.id === (pose as CameraPresetId));
      else p = pose;
      if (!p) return;
      rig.flyTo(new THREE.Vector3(...p.position), new THREE.Vector3(...p.target), duration);
    },
    start(b: EventBus, onFrame: UpdateFn) {
      bus = b;
      // While a quake animates buildings, refresh the shadow map every frame.
      b.on('quake-started', () => (lighting.dynamicShadows = true));
      b.on('quake-finished', () => (lighting.dynamicShadows = false));
      b.on('quake-reset', () => (lighting.dynamicShadows = false));
      renderer.setAnimationLoop((time) => {
        timer.update(time);
        const dt = Math.min(timer.getDelta(), 0.1);
        const elapsed = timer.getElapsed();
        runDriver(dt);
        onFrame(dt, elapsed);
        frameInternals(dt, elapsed);
        renderFrame(dt);
        adaptResolution(dt);
      });
    },
    renderOnce() {
      runDriver(0);
      frameInternals(0, timer.getElapsed());
      renderFrame(0);
    },
    setCameraDriver(next) {
      if (next === driver) return;
      const controls = rig.controls;
      if (next) {
        // Freeze the orbit rig: no pointer / wheel / arrow-key handling, no flight in progress.
        if (!driver) {
          controls.enabled = false;
          controls.stopListenToKeyEvents();
        }
        driver = next;
        return;
      }
      driver = null;
      // Hand back as a free orbit camera from the current pose, pivoting on what it looks at.
      camera.up.set(0, 1, 0);
      const target = camera.position.clone().addScaledVector(camera.getWorldDirection(driverFwd), Math.max(driverDistance, 40));
      controls.enabled = true;
      controls.listenToKeyEvents(window);
      rig.flyTo(camera.position.clone(), target, 0);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      driver = null;
      window.removeEventListener('resize', onResize);
      resizeObserver?.disconnect();
      timer.dispose();
      rig.dispose();
      views.dispose();
      post.composer.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const mat of mats) mat.dispose();
      });
      scene.environment?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
    renderView(cam, target) {
      views.render(cam, target);
    },
    setGroundHeightSampler(fn) {
      ground = fn;
      rig.ground = fn;
      // Re-resolve presets in place (the UI keeps a reference to this array).
      const fresh = buildPresets(fn);
      cameraPresets.splice(0, cameraPresets.length, ...fresh);
      tryBuildBackdrop();
    },
  };
  return engine;
}
