import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import type { SfWorld } from './session';

const mocks = vi.hoisted(() => ({
  line: { object: { visible: false }, length: 100, setRange: vi.fn(), distanceAt: () => 50, update: vi.fn() },
  fly: vi.fn(),
}));
vi.mock('./routeLine', () => ({ RouteLine: class { constructor() { return mocks.line; } } }));
vi.mock('./session', () => ({ flySf: mocks.fly }));
vi.mock('../scene/runtime', () => ({ runtime: { drone: null } }));
vi.mock('../state/store', () => ({ CUT_FADE_MS: 400, useFlytake: { getState: () => ({ blackout: false, cut: (fn: () => void) => fn() }), setState: vi.fn() } }));
vi.mock('../world/sun', () => ({ useSun: { getState: () => ({ hours: 15, setHours: vi.fn() }) } }));
vi.mock('./previewRoute', () => ({ FLIGHT_SECONDS: 60, PREVIEW_HOURS: 16, OVERVIEW: { seconds: 1, drawSeconds: 1, from: new Vector3(), to: new Vector3(), look: new Vector3(0, 0, -1) }, sampleFlight: (_t: number, position: Vector3, look: Vector3) => { position.set(0, 20, 0); look.set(0, 20, -1); } }));
import { approvePreview, cyclePreviewSpeed, previewClock, startPreview, stopPreview, usePreview } from './preview';

describe('preview approval lifecycle', () => {
  let driver: ((camera: PerspectiveCamera, dt: number) => void) | undefined;
  let world: SfWorld;
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks();
    vi.stubGlobal('window', { setTimeout });
    usePreview.setState({ active: false, stage: 'overview', approved: false, completed: false, reviewPending: false, speed: 1 });
    mocks.line.object.visible = false;
    world = { city: { cityRoot: { add: vi.fn() }, onFrame: vi.fn(), engine: { renderer: { domElement: {} }, setCameraDriver: (fn: typeof driver) => { driver = fn; } } } } as unknown as SfWorld;
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  function finish() {
    const camera = new PerspectiveCamera();
    driver!(camera, 1); // overview ends
    driver!(camera, 62); // flight completes and cuts back to the drone
    vi.runAllTimers();
  }
  it('does not approve or leave a route visible when the user exits early', () => {
    startPreview(world); stopPreview(world); vi.runAllTimers(); approvePreview(world);
    expect(usePreview.getState()).toMatchObject({ active: false, completed: false, approved: false });
    expect(mocks.line.object.visible).toBe(false);
  });
  it('finishes without auto-approval and reveals the route only on approval', () => {
    startPreview(world); finish();
    expect(usePreview.getState()).toMatchObject({ active: false, completed: true, approved: false, reviewPending: true });
    expect(mocks.line.object.visible).toBe(false);
    approvePreview(world);
    expect(usePreview.getState()).toMatchObject({ approved: true, reviewPending: false });
    expect(mocks.line.object.visible).toBe(true);
  });
  it('allows deferring approval without unlocking the route', () => {
    startPreview(world); finish();
    usePreview.setState({ reviewPending: false });
    expect(usePreview.getState()).toMatchObject({ completed: true, approved: false, reviewPending: false });
    expect(mocks.line.object.visible).toBe(false);
    approvePreview(world);
    expect(usePreview.getState().approved).toBe(true);
  });
  it('cycles 1x, 2x, 3x, 5x and 10x and changes the running clock immediately', () => {
    startPreview(world);
    const camera = new PerspectiveCamera();
    driver!(camera, 1);
    cyclePreviewSpeed(); expect(usePreview.getState().speed).toBe(2);
    cyclePreviewSpeed(); expect(usePreview.getState().speed).toBe(3);
    driver!(camera, 2); expect(previewClock.seconds).toBe(6);
    cyclePreviewSpeed(); expect(usePreview.getState().speed).toBe(5);
    driver!(camera, 1); expect(previewClock.seconds).toBe(11);
    cyclePreviewSpeed(); expect(usePreview.getState().speed).toBe(10);
    driver!(camera, 1); expect(previewClock.seconds).toBe(21);
    cyclePreviewSpeed(); expect(usePreview.getState().speed).toBe(1);
    driver!(camera, 2); expect(previewClock.seconds).toBe(23);
  });
  it('completes at accelerated speed and resets speed for the next preview', () => {
    startPreview(world);
    const camera = new PerspectiveCamera(); driver!(camera, 1);
    cyclePreviewSpeed(); cyclePreviewSpeed(); driver!(camera, 21); vi.runAllTimers();
    expect(usePreview.getState()).toMatchObject({ active: false, completed: true, reviewPending: true });
    startPreview(world);
    expect(usePreview.getState()).toMatchObject({ speed: 1, reviewPending: false });
  });
  it('keeps approval and the route after replay', () => {
    startPreview(world); finish(); approvePreview(world);
    startPreview(world); stopPreview(world); vi.runAllTimers();
    expect(usePreview.getState()).toMatchObject({ active: false, approved: true });
    expect(mocks.line.object.visible).toBe(true);
  });
});
