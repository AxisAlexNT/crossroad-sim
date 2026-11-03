import assert from 'node:assert/strict';
import { defaultModel, TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import type { ConflictRef } from '../src/engine/network';
import { invalidRunReasons } from '../src/engine/runValidity';
const cfg = defaultModel('v1');
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(30); const template = sim.st.vehicles[0]; assert.ok(template);
  const a = sim.net.conns.find(c => c.conn.id === 'S0-N0' && c.variant === 1)!;
  const b = sim.net.conns.find(c => c.conn.id === 'E0-S0' && c.variant === 0)!;
  const cr = a.conflicts.find(c => c.other === b.idx && !sim.net.conflicts[c.conflict].body)!; assert.ok(cr);
  const cf = sim.net.conflicts[cr.conflict];
  const bStart = cr.side === 'a' ? cf.bStart : cf.aStart, bEnd = cr.side === 'a' ? cf.bEnd : cf.aEnd;
  const waiting: Vehicle = { ...structuredClone(template), id: 10001, origin: 'S', dest: 'N', phase: 'approach', conn: a.idx,
    lane: 0, s: sim.net.arms.S.cfg.approachLength - 10, v: 0, a: 0, committed: [], crashed: false, yieldingAt: -1 };
  const clearing: Vehicle = { ...structuredClone(template), id: 10002, origin: 'E', dest: 'S', phase: 'conn', conn: b.idx,
    v: 0, a: 0, len: 4.5, wid: 1.8, lat: 0, lat2: 0, route: null, committed: [], crashed: false, yieldingAt: -1 };
  const internal = sim as unknown as {
    index(): void;
    sweepHits(v: Vehicle, ci: number, start: number, end: number, o: Vehicle): boolean;
    mustWait(v: Vehicle, ci: number, cr: ConflictRef, start: number, end: number): boolean;
  };
  sim.permit[a.idx] = 'main'; sim.permit[b.idx] = 'none';
  let found = false;
  for (let s = .1; s < bStart - 1; s += .5) {
    clearing.s = s; sim.pose(clearing);
    if (!internal.sweepHits(waiting, a.idx, cr.start, cr.end + waiting.len, clearing)) { found = true; break; }
  }
  assert.ok(found, 'Fixture needs a stationary clearing vehicle outside the instantaneous swept corridor');
  sim.st.vehicles = [waiting, clearing]; internal.index();
  assert.equal(internal.mustWait(waiting, a.idx, cr, 10 + cr.start, 10 + cr.end), true, 'New green must yield to a stationary vehicle completing the previous phase before the conflict zone');
  clearing.yieldingAt = cf.id; clearing.yieldTo = 10003;
  assert.equal(internal.mustWait(waiting, a.idx, cr, 10 + cr.start, 10 + cr.end), true,
    'Yielding to a third participant does not transfer priority to every vehicle using its movement');
  clearing.yieldTo = waiting.id;
  assert.equal(internal.mustWait(waiting, a.idx, cr, 10 + cr.start, 10 + cr.end), false,
    'A direct yield can release the intended participant');
  clearing.yieldingAt = -1; clearing.yieldTo = -1;
  clearing.s = bEnd + clearing.len + 1; sim.pose(clearing); internal.index();
  assert.equal(internal.mustWait(waiting, a.idx, cr, 10 + cr.start, 10 + cr.end), false, 'Fully cleared vehicle releases the new phase');
  console.log('Phase clearance: stationary participant retains priority until the zone is cleared.');
} finally { sim.dispose(); }

{
  const cfg = TEMPLATES.find(t => t.id === 'tee')!.make(); cfg.sim.seed = 133042; cfg.sim.dt = .2;
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
  try {
    sim.runUntil(28.6);
    const entering = sim.st.vehicles.find(v => v.origin === 'S' && v.dest === 'W')!;
    const clearing = sim.st.vehicles.find(v => v.origin === 'E' && v.dest === 'S' && v.phase === 'conn')!;
    assert.ok(entering && clearing);
    const cr = sim.net.conns[entering.conn].conflicts.find(ref => ref.other === clearing.conn)!; assert.ok(cr);
    const internal = sim as unknown as { index(): void; sweepHits(v: Vehicle, ci: number, start: number, end: number, o: Vehicle): boolean; mustWait(v: Vehicle, ci: number, cr: ConflictRef, start: number, end: number): boolean };
    internal.index();
    const offset = sim.net.arms[entering.origin].cfg.approachLength - entering.s;
    assert.equal(internal.sweepHits(entering, entering.conn, cr.start, cr.end + entering.len, clearing), false,
      'The clearing vehicle must be outside the instantaneous body corridor in this regression');
    assert.equal(internal.mustWait(entering, entering.conn, cr, offset + cr.start, offset + cr.end), true,
      'A clearing vehicle can restart while inside the conservative zone; instantaneous free space must not cancel phase priority');
  } finally { sim.dispose(); }
}
for (const dt of [.2, .1, .05]) {
  const cfg = TEMPLATES.find(t => t.id === 'tee')!.make(); cfg.sim.seed = 133042; cfg.sim.dt = dt;
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
  try {
    sim.runUntil(1500);
    assert.deepEqual(invalidRunReasons(sim.st.counters, sim.logCounts['deadlock-manual'] ?? 0), []);
    assert.ok(sim.st.counters.exited > 250);
    console.log(`Phase clearance tee/133042 dt=${dt}: ${sim.st.counters.exited} exited without invalid events.`);
  } finally { sim.dispose(); }
}
