import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import type { ConflictRef } from '../src/engine/network';
const cfg = defaultModel('v1'); cfg.sim.deadlockBreak = 30;
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60); const template = sim.st.vehicles[0]; assert.ok(template);
  const a = sim.net.conns.find(c => c.conn.id === 'E0-S0' && c.variant === 0)!;
  const b = sim.net.conns.find(c => c.conn.id === 'W1-E1' && c.variant === 0)!;
  const cr = a.conflicts.find(c => c.other === b.idx)!; assert.ok(cr);
  const waiting: Vehicle = { ...structuredClone(template), id: 10001, phase: 'conn', origin: 'E', dest: 'S', conn: a.idx,
    s: cr.start - 2, v: 0, a: 0, stuckSince: 0, committed: [], len: 4.8, wid: 1.8, crashed: false, route: null };
  const bus: Vehicle = { ...structuredClone(template), id: 10002, phase: 'approach', origin: 'W', dest: 'E', conn: b.idx,
    lane: 1, targetLane: 1, lcT: -1, s: sim.net.arms.W.cfg.approachLength - 10, v: 10, a: 1,
    len: 12, wid: 2.55, committed: [], crashed: false, route: null, yellowDecision: 0 };
  const internal = sim as unknown as { index(): void; mustWait(v: Vehicle, ci: number, cr: ConflictRef, start: number, end: number): boolean };
  sim.st.vehicles = [waiting, bus]; sim.pose(waiting); sim.pose(bus); internal.index();
  sim.permit[a.idx] = 'main'; sim.permit[b.idx] = 'main';
  const blocked = () => internal.mustWait(waiting, a.idx, cr, cr.start - waiting.s, cr.end - waiting.s);
  assert.equal(blocked(), true, 'Prolonged waiting cannot ignore a moving participant before the stop line');
  bus.v = 0; bus.a = 0;
  assert.equal(blocked(), false, 'Stationary unreserved queue does not occupy the conflict indefinitely');
  bus.committed = [cr.conflict];
  assert.equal(blocked(), true, 'A reserved entry must remain visible during a temporary stop');
  bus.committed = []; bus.v = 10; bus.s -= 70; sim.pose(bus); internal.index();
  assert.equal(blocked(), false, 'A distant arrival leaves enough time to clear');
  console.log('Prolonged wait: approach arrivals and reservations checked before crossing.');
} finally { sim.dispose(); }
