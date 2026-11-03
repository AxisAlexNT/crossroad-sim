import assert from 'node:assert/strict';
import { defaultModel, TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';

const cfg = TEMPLATES.find(t => t.id === 'skew')!.make();
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60); const base = sim.st.vehicles[0]; assert.ok(base);
  const left = sim.net.conns.find(c => c.conn.id === 'E0-SW0')!;
  const right = sim.net.conns.find(c => c.conn.id === 'E1-NE0')!;
  const cr = left.conflicts.find(r => r.other === right.idx && sim.net.conflicts[r.conflict].body)!; assert.ok(cr);
  const stopped: Vehicle = { ...structuredClone(base), id: 10001, origin: 'E', dest: 'SW', lane: 0, conn: left.idx, phase: 'conn', s: 9.8, v: 0, a: 0, len: 4.8, wid: 1.8, lat: 0, lat2: 0, committed: [cr.conflict] };
  const approaching: Vehicle = { ...structuredClone(base), id: 10002, origin: 'E', dest: 'NE', lane: 1, conn: right.idx, phase: 'approach', s: 104, v: 16, a: 0, len: 6, wid: 2, lat: 0, lat2: 0, committed: [cr.conflict] };
  sim.st.vehicles = [stopped, approaching]; sim.st.peds = [];
  const internal = sim as unknown as { index(): void; accel(v: Vehicle): number; bodyConflictApplies(a: Vehicle, ci: number, b: Vehicle, cj: number): boolean };
  for (const v of sim.st.vehicles) sim.pose(v);
  internal.index();
  assert.equal(internal.bodyConflictApplies(stopped, left.idx, approaching, right.idx), false);
  internal.accel(stopped);
  assert.notEqual(stopped.yieldingAt, cr.conflict, 'Restart must not treat a bus-only geometric corridor as occupied by nonconflicting small bodies');
  const busCfg = defaultModel('v4');
  const busSim = new Simulation(busCfg, compileModel(busCfg).code, { headless: true });
  try {
    const turn = busSim.net.conns.find(c => c.conn.id === 'W2-S0' && c.variant === 0)!;
    const through = busSim.net.conns.find(c => c.conn.id === 'S0-N0' && c.variant === 2)!;
    const ref = turn.conflicts.find(r => r.other === through.idx && busSim.net.conflicts[r.conflict].body)!; assert.ok(ref);
    const bus: Vehicle = { ...stopped, id: 10003, origin: 'W', dest: 'S', lane: 2, conn: turn.idx, s: ref.start - 2, len: 12, wid: 2.55, route: 'test', committed: [ref.conflict] };
    const van: Vehicle = { ...approaching, id: 10004, origin: 'S', dest: 'N', lane: 0, conn: through.idx, s: busSim.net.arms.S.cfg.approachLength - 20, v: 10, committed: [ref.conflict] };
    busSim.st.vehicles = [bus, van]; busSim.st.peds = [];
    const control = busSim as unknown as typeof internal;
    for (const v of busSim.st.vehicles) busSim.pose(v);
    control.index();
    assert.equal(control.bodyConflictApplies(bus, turn.idx, van, through.idx), true);
    control.accel(bus);
    assert.equal(bus.yieldingAt, ref.conflict, 'Restart must retain the reservation guard for conflicting bodies');
  } finally { busSim.dispose(); }
  console.log('Возобновление движения: учитываются конкретные кузова и резерв конфликтующего автобуса.');
} finally { sim.dispose(); }
