import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import { invalidRunReasons } from '../src/engine/runValidity';
const cfg = defaultModel('v2');
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60); const base = sim.st.vehicles[0]; assert.ok(base);
  const turn = sim.net.conns.find(c => c.conn.id === 'S0-W0' && c.variant === 0)!;
  const straight = sim.net.conns.find(c => c.conn.id === 'N0-S0' && c.variant === 0)!;
  const cr = turn.conflicts.find(c => c.other === straight.idx)!;
  const bus: Vehicle = { ...structuredClone(base), id: 10001, phase: 'conn', origin: 'S', dest: 'W', conn: turn.idx,
    s: cr.start - 1.8, v: 3, a: 0, len: 12.3, wid: 2.55, s0: 1.5, amax: 1.35, bcomf: 2, route: null, stopsLeft: [],
    committed: turn.conflicts.map(c => c.conflict), crashed: false, entryPermit: 'main',
    ghostUntil: 0, stuckSince: -1, dwellUntil: -1, bayT: 0, bayShift: 0, lcT: -1 };
  const car: Vehicle = { ...structuredClone(base), id: 10002, phase: 'approach', origin: 'N', dest: 'S', conn: straight.idx,
    lane: 0, targetLane: 0, s: sim.net.arms.N.cfg.approachLength - 14, v: 5.5, a: 0,
    len: 4.3, wid: 1.8, route: null, committed: [], crashed: false, lcT: -1, yieldingAt: -1, yieldTo: -1 };
  sim.st.vehicles = [bus, car]; sim.st.peds = [];
  sim.pose(bus); sim.pose(car);
  const internal = sim as unknown as { index(): void; accel(v: Vehicle): number; clearYieldGap(v: Vehicle, conflict: number, gap: number): number };
  internal.index(); sim.permit[turn.idx] = 'main'; sim.permit[straight.idx] = 'main';
  const available = internal.clearYieldGap(bus, cr.conflict, cr.start - bus.s - 1) - bus.s0;
  assert.ok(available < bus.v * bus.v / 14, 'Fixture is beyond the last unobstructing stopping point');
  const acceleration = internal.accel(bus);
  assert.ok(!(bus.why === 'yield' && bus.whyId === cr.conflict),
    `An issued reservation cannot be revoked into an obstructing stop: a=${acceleration}`);
  bus.s -= 5; bus.why = 'free'; bus.whyId = -1;
  sim.pose(bus); internal.index();
  assert.ok(internal.clearYieldGap(bus, cr.conflict, cr.start - bus.s - 1) - bus.s0 > bus.v * bus.v / 14 + .3);
  internal.accel(bus);
  assert.equal(String(bus.why), 'yield', 'The reservation is rechecked while an unobstructing stop remains possible');
  assert.equal(bus.whyId, cr.conflict);
  const target = bus.s + internal.clearYieldGap(bus, cr.conflict, cr.start - bus.s - 1) - bus.s0;
  bus.s = target - .05; bus.v = .1;
  sim.pose(bus); internal.index();
  internal.accel(bus);
  assert.equal(bus.whyId, cr.conflict,
    'A reserved vehicle already braking to a clear waiting position must keep yielding within the last 0.3 m');
  // Начав проезд через временный разрыв в очереди, машина сохраняет
  // очередность до того, как уже не сможет остановиться у точки ожидания.
  bus.s = cr.start - 2.4; bus.v = .1;
  bus.committed = turn.conflicts.filter(ref => ref.conflict !== cr.conflict).map(ref => ref.conflict);
  car.v = 0; car.a = 0; car.why = 'leader'; car.whyId = 10003;
  const queuedLeader: Vehicle = { ...structuredClone(car), id: 10003, phase: 'exit', s: 40, why: 'exit', whyId: -1 };
  sim.st.vehicles = [bus, car, queuedLeader];
  for (const v of sim.st.vehicles) sim.pose(v);
  internal.index();
  internal.accel(bus);
  assert.ok(bus.committed.includes(cr.conflict),
    'Reservation must account for both the one-metre zone margin and the standstill gap');
  console.log('Reservation clearance: no late revocation into the opposing swept corridor.');
} finally { sim.dispose(); }

const replayCfg = defaultModel('v2'); replayCfg.sim.seed = 8042;
const replay = new Simulation(replayCfg, compileModel(replayCfg).code, { headless: true });
try {
  replay.runUntil(7200);
  assert.deepEqual(invalidRunReasons(replay.st.counters, replay.logCounts['deadlock-manual'] ?? 0), []);
  assert.ok(replay.st.counters.exited > 2500, 'Reservation correction must preserve sustained throughput');
  console.log(`Reservation clearance replay v2/8042: ${replay.st.counters.exited} exited without invalid events.`);
} finally { replay.dispose(); }
