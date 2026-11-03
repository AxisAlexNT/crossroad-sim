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
    const base = sim.st.vehicles[0]; assert.ok(base);
    const enteringConn = sim.net.conns.find(c => c.conn.id === 'S0-W0' && c.variant === 0)!;
    const clearingConn = sim.net.conns.find(c => c.conn.id === 'E0-S0' && c.variant === 0)!;
    assert.ok(enteringConn && clearingConn);
    // Геометрия регрессии задана явно: ранние изменения очереди не должны
    // менять смысл проверки освобождения предыдущей фазы.
    const entering: Vehicle = { ...structuredClone(base), id: 10011, origin: 'S', dest: 'W',
      phase: 'approach', conn: enteringConn.idx, lane: 0, targetLane: 0, lcT: -1,
      s: 143.46371794318597, v: 5.167299936855759, len: 4.820733039919287, wid: 1.8,
      lat: -0.9588839360512793, lat2: 0.1841764273121953, committed: [], acceptedGrants: undefined,
      route: null, inBay: false, bayT: 0, bayShift: 0, crashed: false, risky: false,
      yieldingAt: -1, yieldTo: -1, entryPermit: 'none', tStop: -1 };
    const clearing: Vehicle = { ...structuredClone(base), id: 10012, origin: 'E', dest: 'S',
      phase: 'conn', conn: clearingConn.idx, lane: 0, targetLane: 0, lcT: -1,
      s: 21.487008508985703, v: 0.25698820024289853, a: -0.25070859868678597,
      len: 4.322891010949388, wid: 1.8, lat: 0.8024461846798658, lat2: 0.12037246255204082,
      committed: [], acceptedGrants: undefined, route: null, inBay: false, bayT: 0, bayShift: 0,
      crashed: false, risky: false, yieldingAt: -1, yieldTo: -1, entryPermit: 'main', tStop: 21.8 };
    sim.st.vehicles = [entering, clearing]; sim.st.peds = [];
    sim.permit[entering.conn] = 'main'; sim.permit[clearing.conn] = 'none';
    sim.pose(entering); sim.pose(clearing);
    const cr = sim.net.conns[entering.conn].conflicts.find(ref => ref.other === clearing.conn)!; assert.ok(cr);
    const internal = sim as unknown as { index(): void; sweepHits(v: Vehicle, ci: number, start: number, end: number, o: Vehicle): boolean; mustWait(v: Vehicle, ci: number, cr: ConflictRef, start: number, end: number): boolean };
    internal.index();
    const offset = sim.net.arms[entering.origin].cfg.approachLength - entering.s;
    assert.equal(internal.sweepHits(entering, entering.conn, cr.start, cr.end + entering.len, clearing), false,
      'The clearing vehicle must be outside the instantaneous body corridor in this regression');
    assert.equal(internal.mustWait(entering, entering.conn, cr, offset + cr.start, offset + cr.end), true,
      'A clearing vehicle can restart while inside the conservative zone; instantaneous free space must not cancel phase priority');
    sim.permit[clearing.conn] = 'main';
    clearing.committed = clearing.committed.filter(id => id !== cr.conflict);
    clearing.acceptedGrants = undefined; clearing.yieldingAt = -1; clearing.yieldTo = -1;
    const blocked = () => internal.mustWait(entering, entering.conn, cr, offset + cr.start, offset + cr.end);
    assert.equal(blocked(), false, 'This stationary body leaves a usable gap in the absence of an accepted grant');
    clearing.committed.push(cr.conflict); clearing.acceptedGrants = { [cr.conflict]: entering.id };
    assert.equal(blocked(), true, 'The giver must honor accepted passage even when the stationary recipient leaves its instantaneous corridor clear');
    clearing.acceptedGrants[cr.conflict] = 99999;
    assert.equal(blocked(), false, 'A grant from someone else cannot bind this giver');
    clearing.acceptedGrants[cr.conflict] = entering.id;
    const zone = sim.net.conflicts[cr.conflict];
    const otherEnd = cr.side === 'a' ? zone.bEnd : zone.aEnd;
    clearing.s = otherEnd + clearing.len + 1;
    sim.pose(clearing); internal.index();
    assert.equal(blocked(), false, 'Rear clearance releases the accepted grant');
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
