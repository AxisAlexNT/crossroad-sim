import assert from 'node:assert/strict';
import { defaultModel, TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import type { ConflictRef } from '../src/engine/network';
import { invalidRunReasons } from '../src/engine/runValidity';

const cfg = defaultModel('v1');
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60); const base = sim.st.vehicles[0]; assert.ok(base);
  const a = sim.net.conns.find(c => c.conn.id === 'W1-E1' && c.variant === 0)!;
  const b = sim.net.conns.find(c => c.conn.id === 'E0-S0' && c.variant === 0)!;
  const cr = a.conflicts.find(c => c.other === b.idx)!;
  const cf = sim.net.conflicts[cr.conflict];
  const startB = cr.side === 'a' ? cf.bStart : cf.aStart;
  const make = (id: number, conn: number, s: number, v: number): Vehicle => ({
    ...structuredClone(base), id, conn, phase: 'conn', s, v, a: 0, len: 4.5, wid: 1.8,
    origin: sim.net.conns[conn].conn.from.arm, dest: sim.net.conns[conn].conn.to.arm,
    risky: true, crashed: false, stuckSince: -1, yieldingAt: -1, yieldTo: -1, committed: [],
  });
  const receiver = make(10001, a.idx, cr.start - 15, 2);
  const giver = make(10002, b.idx, startB - 6, .4);
  giver.committed = [cf.id]; giver.yieldingAt = cf.id; giver.yieldTo = receiver.id;
  giver.acceptedGrants = { [cf.id]: 99999 };
  sim.st.vehicles = [receiver, giver]; sim.st.peds = [];
  for (const v of sim.st.vehicles) sim.pose(v);
  const internal = sim as unknown as { index(): void; mustWait(v: Vehicle, a: number, cr: ConflictRef, start: number, end: number): boolean };
  internal.index(); sim.permit[a.idx] = 'main'; sim.permit[b.idx] = 'main';
  assert.equal(internal.mustWait(receiver, a.idx, cr, 15, cr.end - receiver.s), false);
  assert.ok(!giver.committed.includes(cf.id), 'Accepting an explicit yield must revoke the yielding participant’s old reservation');
  assert.equal(giver.acceptedGrants[cf.id], undefined, 'Revoking a reservation must also clear its former addressed grant');
  giver.committed = [cf.id]; giver.yieldTo = 99999;
  assert.equal(internal.mustWait(receiver, a.idx, cr, 15, cr.end - receiver.s), true);
  assert.ok(giver.committed.includes(cf.id), 'Yielding to a third participant must preserve the reservation');
} finally { sim.dispose(); }

for (const [label, seed] of [['skew', 2042], ['tee', 6042]] as const) {
  const cfg = TEMPLATES.find(t => t.id === label)!.make(); cfg.sim.seed = seed;
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
  try {
    sim.runUntil(7200);
    assert.deepEqual(invalidRunReasons(sim.st.counters, sim.logCounts['deadlock-manual'] ?? 0), [], label);
    assert.ok(sim.st.counters.exited > 1500, 'Safety must preserve traffic discharge');
    console.log(`Yield transfer ${label}/${seed}: ${sim.st.counters.exited} exited without invalid events.`);
  } finally { sim.dispose(); }
}

// Ползущий участник сохраняет старый резерв, пока встречный уже начинает проезд.
for (const dt of [.2, .1, .05]) {
  const cfg = TEMPLATES.find(t => t.id === 'skew')!.make(); cfg.sim.seed = 29042; cfg.sim.dt = dt;
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true, dt });
  try {
    sim.runUntil(1500);
    assert.deepEqual(invalidRunReasons(sim.st.counters, sim.logCounts['deadlock-manual'] ?? 0), [], `Creeping restart dt=${dt}`);
    assert.ok(sim.st.counters.exited > 250);
    console.log(`Creeping restart skew/29042 dt=${dt}: ${sim.st.counters.exited} exited without invalid events.`);
  } finally { sim.dispose(); }
}
