import assert from 'node:assert/strict';
import { TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import { buildNetwork, type ConflictRef } from '../src/engine/network';

const cfg = TEMPLATES.find(t => t.id === 'skew')!.make();
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  const mergeZone = (net: typeof sim.net) => net.conflicts.find(c => c.kind === 'merge'
    && net.conns[c.a].conn.id === 'SW0-NE0' && net.conns[c.b].conn.id === 'SW1-NE0')!;
  const mixedMerge = mergeZone(sim.net); assert.ok(mixedMerge);
  assert.ok(mixedMerge.aStart > 0 && mixedMerge.bStart > 0, 'Separate approach lanes must remain available before the physical merge');
  const cars = structuredClone(cfg);
  for (const spawner of Object.values(cars.spawners)) spawner.params.types = [{ kind: 'car', share: 1, lengthMin: 4, lengthMax: 4 }];
  const carMerge = mergeZone(buildNetwork(cars));
  assert.ok(carMerge.aStart >= mixedMerge.aStart && carMerge.bStart >= mixedMerge.bStart, 'Larger bodies must start reserving the merge no later than small cars');
  sim.runUntil(30);
  const template = sim.st.vehicles[0]; assert.ok(template);
  const turn = sim.net.conns.find(c => c.conn.id === 'E0-SW0')!;
  const straight = sim.net.conns.find(c => c.conn.id === 'W1-E1')!;
  const cr = straight.conflicts.find(c => c.other === turn.idx)!; assert.ok(cr);
  const stopped: Vehicle = { ...structuredClone(template), id: 10001, phase: 'conn', origin: 'E', dest: 'SW', conn: turn.idx,
    s: 29.069468183122495, v: 0, a: 0, len: 4.391941155772656, wid: 1.8, lat: .6387369874864817, lat2: .6566198500804603,
    route: null, bayT: 0, bayShift: 0, crashed: false };
  const approaching: Vehicle = { ...structuredClone(template), id: 10002, phase: 'approach', origin: 'W', dest: 'E', conn: straight.idx,
    lane: 1, s: sim.net.arms.W.cfg.approachLength - 30, v: 15, len: 4.615719929523767, wid: 1.8,
    lat: -.7981344452127814, lat2: -.35078815883025527, route: null, bayT: 0, bayShift: 0, crashed: false };
  sim.st.vehicles = [stopped, approaching]; sim.pose(stopped); sim.pose(approaching);
  const internal = sim as unknown as { index(): void; zoneHeld(v: Vehicle, cr: ConflictRef): boolean };
  internal.index();
  assert.equal(internal.zoneHeld(approaching, cr), true, 'Stopped obstruction must be detected before the stop line');
  approaching.phase = 'conn'; approaching.s = 0; sim.pose(approaching); internal.index();
  assert.equal(internal.zoneHeld(approaching, cr), true, 'The same obstruction remains detected after the stop line');
  stopped.s = turn.path.length + stopped.len + 10; sim.pose(stopped); internal.index();
  assert.equal(internal.zoneHeld(approaching, cr), false, 'Cleared obstruction must release the conflict');
  console.log('Occupied zone: consistent approach/connector coordinates and release after clearance.');
} finally { sim.dispose(); }
