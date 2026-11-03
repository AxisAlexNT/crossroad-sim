import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import { invalidRunReasons } from '../src/engine/runValidity';
import type { ConflictRef } from '../src/engine/network';

const cfg = defaultModel('v1');
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(30);
  const template = sim.st.vehicles[0];
  assert.ok(template);
  const zone = sim.net.conflicts.find(z => z.same && sim.net.conns[z.a].conn.id === 'S0-N0' && sim.net.conns[z.b].conn.id === 'S0-E1')!;
  assert.ok(zone);
  const a = sim.net.conns[zone.a], b = sim.net.conns[zone.b];
  const ar = a.conflicts.find(c => c.conflict === zone.id)!, br = b.conflicts.find(c => c.conflict === zone.id)!;
  const L = sim.net.arms.S.cfg.approachLength;
  const vehicle = (id: number, ci: number, s: number): Vehicle => ({ ...structuredClone(template), id, origin: 'S', dest: sim.net.conns[ci].conn.to.arm,
    conn: ci, lane: 0, targetLane: 0, lcT: -1, phase: 'approach', s, v: 8, a: 0, committed: [], crashed: false, tStop: -1 });
  const front = vehicle(10001, zone.b, L - 2), back = vehicle(10002, zone.a, L - 6);
  sim.st.vehicles = [front, back];
  const internal = sim as unknown as { index(): void; mustWait(v: Vehicle, ci: number, cr: ConflictRef, start: number, end: number): boolean };
  const wait = (v: Vehicle, cr: ConflictRef) => {
    internal.index();
    const offset = v.phase === 'approach' ? L - v.s : -v.s;
    return internal.mustWait(v, v.conn, cr, offset + cr.start, offset + cr.end);
  };
  assert.equal(wait(back, ar), true, 'Follower cannot reserve a shared zone ahead of its leader');
  // Уже выданный резерв сохраняется, даже если соседний ряд раньше пересёк стоп-линию.
  back.committed = [zone.id]; front.phase = 'conn'; front.s = .1; front.tStop = 100;
  assert.equal(wait(front, br), true, 'Reservation on approach remains visible to a vehicle on the connector');
  back.phase = 'conn'; back.s = .2; back.tStop = 101;
  assert.equal(wait(front, br), true, 'Stop-line order cannot revoke an existing reservation');
  assert.equal(wait(back, ar), false, 'Reservation owner may proceed past a vehicle waiting before its zone');
  // A reservation held by the physical follower must not stop the leader that it follows.
  front.s = 6; back.s = .3;
  assert.equal(wait(front, br), false, 'Physical leader on a shared prefix is not blocked by a follower reservation');
  console.log('Reservation order: leader before follower; issued reservation survives stop-line transition.');
} finally { sim.dispose(); }

for (const dt of [.2, .1, .05]) {
  const model = defaultModel('v4'); model.sim.seed = 20042;
  const sim = new Simulation(model, compileModel(model).code, { headless: true, dt });
  try {
    sim.runUntil(1500);
    assert.deepEqual(invalidRunReasons(sim.st.counters, sim.logCounts['deadlock-manual'] ?? 0), [], `Shared-prefix reservation v4/20042, dt=${dt}`);
    assert.ok(sim.st.counters.exited > 250);
    console.log(`Shared-prefix replay v4/20042 dt=${dt}: ${sim.st.counters.exited} exited without invalid events.`);
  } finally { sim.dispose(); }
}
