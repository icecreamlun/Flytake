/**
 * Streets & ground module: terrain, curbs, landcover, markings, piers, rail, trees, street furniture, vehicles
 * and night lighting. Everything at ground level except buildings and landmarks.
 *
 * Build order: exact ground surface → road network analysis → detail-zone ground tiles (curbs, block tops,
 * seawalls) + outer terrain → baked landcover → props / trees / rail (which also emit ground decals) →
 * one merged decal mesh (paint, gutters, tree wells, track beds).
 */
import * as THREE from 'three';
import type { AppContext, StreetsHandle } from '../../contracts';
import { GroundSurface } from './core/surface';
import { RoadNet } from './core/roadnet';
import { SegIndex } from './core/segindex';
import { buildDetailGround } from './ground/tiles';
import { buildOuterGround } from './ground/outer';
import { bakeLandcover } from './ground/landcover';
import { GroundMaterial } from './ground/material';
import { createMarkingMaterial } from './markings/material';
import { StripBuilder } from './markings/strips';
import { buildRoadMarkings } from './markings/roads';
import { TreeSystem } from './trees';
import { StreetProps } from './props';
import { RailSystem } from './rail';
import { Vehicles } from './vehicles';
import { Piers } from './piers';
import { buildParkingLots } from './vehicles/parking';
import { PortsmouthSquare, portsmouthDeck } from './plaza/portsmouth';
import { scatterWildVegetation } from './trees/scatter';

/** Debug: ?streetsOff=markings,ground,trees,props,rail,... hides sub-systems (A/B performance checks). */
const OFF = new Set((new URLSearchParams(location.search).get('streetsOff') ?? '').split(',').filter(Boolean));

export function createStreets(ctx: AppContext): StreetsHandle {
  const T: [string, number][] = [];
  let t = performance.now();
  const lap = (name: string) => {
    const n = performance.now();
    T.push([name, Math.round(n - t)]);
    t = n;
  };

  const object = new THREE.Group();
  object.name = 'streets';

  // ── Ground.
  const surface = new GroundSurface(ctx.terrain);
  const net = new RoadNet(ctx.city.roads);
  const portsDeck = portsmouthDeck(ctx.city, surface, net);
  lap('surface+roadnet');
  const piers = new Piers(ctx.city, surface);
  const detail = buildDetailGround(surface, net, piers.rings);
  lap('detail ground');
  const outer = buildOuterGround(surface);
  lap('outer ground');
  const lc = bakeLandcover(ctx.city, net);
  lap('landcover');
  const groundMat = new GroundMaterial(lc);
  const ground = new THREE.Group();
  ground.name = 'ground';
  let tris = 0;
  const mat = OFF.has('groundShader') ? new THREE.MeshStandardMaterial({ color: 0x777777 }) : groundMat.material;
  const mkMesh = (g: THREE.BufferGeometry, name: string) => {
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.receiveShadow = true;
    m.castShadow = false;
    m.matrixAutoUpdate = false;
    ground.add(m);
    return m;
  };
  // Detail-zone tiles: full detail near the camera, 8 m far LOD beyond ~600 m (hysteresis), faces always.
  const lodTiles = detail.tiles.map((t) => {
    const d = mkMesh(t.detail, 'groundTile');
    const c = mkMesh(t.coarse, 'groundTileFar');
    c.visible = false;
    if (t.faces) mkMesh(t.faces, 'shoreFaces');
    tris += (t.detail.index?.count ?? 0) / 3;
    return { t, d, c, near: true };
  });
  for (const g of outer) {
    mkMesh(g, 'outerGround');
    tris += (g.index?.count ?? 0) / 3;
  }
  if (surface.blockMask) groundMat.setBlockMask(surface.blockMask, surface.maskW, surface.maskH);
  if (!OFF.has('ground')) object.add(ground);

  // ── Ground decals (paint, gutters, tree wells, tracks) share one strip builder.
  const sb = new StripBuilder();
  buildRoadMarkings(net, surface, detail.loops, sb);
  lap('markings');
  const segs = new SegIndex(net, (r) => r.curbed);

  // ── Portsmouth Square (deck built with the ground tiles; furniture + trees here).
  const ports = portsDeck?.loop ? new PortsmouthSquare(ctx.city, surface, portsDeck) : null;

  // ── Trees.
  const wild = OFF.has('wild') ? [] : scatterWildVegetation(ctx.city, surface, lc);
  const trees = new TreeSystem(ctx.city, surface, [...(ports?.trees ?? []), ...wild]);
  trees.addTreeWells(sb, surface, segs);
  if (!OFF.has('trees')) object.add(trees.object);
  lap(`trees (+${wild.length} wild)`);

  // ── Street furniture + light pools.
  const props = new StreetProps(ctx.city, net, surface);
  if (!OFF.has('props')) object.add(props.object);
  if (props.lightMap) groundMat.setLightMap(props.lightMap);
  if (ports && !OFF.has('props')) object.add(ports.build(props.uniforms));
  lap('props');

  // ── Piers over open water (decks, lips, pilings, fenders).
  piers.build(groundMat.material, props.uniforms);
  if (!OFF.has('piers')) object.add(piers.object);
  lap('piers');

  // ── Rail.
  const rail = new RailSystem(net, surface, props.uniforms);
  rail.addTracks(sb);
  if (!OFF.has('rail')) object.add(rail.object);
  lap('rail');

  // ── Vehicles.
  const vehicles = new Vehicles(net, surface, props.uniforms);
  buildParkingLots(ctx.city, surface, sb, vehicles);
  if (!OFF.has('vehicles')) object.add(vehicles.object);
  lap('vehicles');

  const mk = createMarkingMaterial();
  const decals = new THREE.Group();
  decals.name = 'groundDecals';
  for (const g of sb.build()) {
    const m = new THREE.Mesh(g, mk.material);
    m.receiveShadow = true;
    m.renderOrder = 1;
    m.matrixAutoUpdate = false;
    decals.add(m);
    tris += g.index!.count / 3;
  }
  if (!OFF.has('markings')) object.add(decals);

  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const drawSize = new THREE.Vector2();
  let powerOut = 0;
  const camP = ctx.camera.position;
  const updateLods = () => {
    for (const L of lodTiles) {
      const cx = (L.t.x0 + L.t.x1) / 2;
      const cz = (L.t.z0 + L.t.z1) / 2;
      const half = (L.t.x1 - L.t.x0) / 2;
      const d = Math.hypot(Math.max(0, Math.abs(camP.x - cx) - half), Math.max(0, Math.abs(camP.z - cz) - half), Math.max(0, camP.y - 40));
      if (L.near && d > 650) L.near = false;
      else if (!L.near && d < 550) L.near = true;
      L.d.visible = L.near;
      L.c.visible = !L.near;
    }
    for (const m of decals.children as THREE.Mesh[]) {
      const bs = m.geometry.boundingSphere!;
      m.visible = camP.distanceTo(bs.center) - bs.radius < 750;
    }
  };

  ctx.onUpdate((dt, elapsed) => {
    const night = ctx.env.nightFactor;
    ctx.camera.updateMatrixWorld();
    updateLods();
    projView.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);
    trees.update(ctx.camera, elapsed, ctx.env.sunDirection, ctx.scene);
    props.update(ctx.camera, frustum.planes, elapsed);
    rail.update(dt);
    piers.update(frustum.planes, ctx.camera.position);
    vehicles.update(dt, frustum.planes, ctx.camera.position);
    // Mains power (lamps & signals) with flicker while failing; vehicle lights stay on.
    const power = 1 - powerOut;
    const flick = power > 0.02 && power < 0.98 ? (Math.random() < power ? 1 : 0) : power >= 0.98 ? 1 : 0;
    props.uniforms.uLamp.value = night;
    props.uniforms.uSig.value = power;
    props.uniforms.uNight.value = night;
    props.uniforms.uVeh.value = night;
    ctx.renderer.getDrawingBufferSize(drawSize);
    mk.uniforms.uPxAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov) / 2)) / Math.max(1, drawSize.y);
    groundMat.update(night, night * flick);
  });

  console.info(`[streets] built: ${T.map(([n, ms]) => `${n} ${ms}ms`).join(', ')}; ground+decals ${Math.round(tris / 1000)}k tris`);
  /** Debug: per-subsystem draw calls / triangles as currently packed (instance counts after culling). */
  const stats = () => {
    const out: Record<string, { calls: number; tris: number; shadowTris: number }> = {};
    for (const child of object.children) {
      const st = { calls: 0, tris: 0, shadowTris: 0 };
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.visible) return;
        const g = m.geometry;
        const per = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
        const n = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
        if (n === 0) return;
        st.calls++;
        st.tris += per * n;
        if (m.castShadow) st.shadowTris += per * n;
      });
      out[child.name] = st;
    }
    return out;
  };
  (window as unknown as { __streets: unknown }).__streets = { surface, net, detail, trees, segs, props, rail, vehicles, ports, stats };

  return {
    object,
    setPowerOut(amount: number) {
      powerOut = THREE.MathUtils.clamp(amount, 0, 1);
    },
  };
}
