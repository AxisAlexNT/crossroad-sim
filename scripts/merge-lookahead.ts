import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import type { ConflictRef } from '../src/engine/network';

const cfg = defaultModel('v1');
cfg.sim.mode = 'strict'; cfg.sim.diagnosticRecovery = false; cfg.sim.seed = 42;
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60);
  const base = sim.st.vehicles[0]; assert.ok(base);
  const turn = sim.net.conns.find(c => c.conn.id === 'E0-S0' && c.variant === 0)!;
  const through = sim.net.conns.find(c => c.conn.id === 'W1-E1' && c.variant === 0)!;
  const merge = turn.conflicts.find(r => sim.net.conflicts[r.conflict].kind === 'merge'
    && sim.net.conns[r.other].conn.from.arm === turn.conn.from.arm
    && sim.net.conns[r.other].conn.from.lane !== turn.conn.from.lane)!;
  const crossing = turn.conflicts.find(r => r.other === through.idx)!;
  assert.ok(merge && crossing && merge.start < crossing.start);
  const waiting: Vehicle = { ...structuredClone(base), id: 10001, conn: turn.idx,
    origin: 'E', dest: 'S', lane: 0, phase: 'approach', s: sim.net.arms.E.cfg.approachLength - 2.5,
    v: 0, a: 0, len: 4.5, wid: 1.8, route: null, committed: [], acceptedGrants: undefined,
    yieldingAt: -1, yieldTo: -1, crashed: false, stuckSince: -1 };
  const oncoming: Vehicle = { ...structuredClone(waiting), id: 10002, conn: through.idx,
    origin: 'W', dest: 'E', lane: 1, phase: 'conn', s: 1, v: 8, a: 1 };
  sim.st.vehicles = [waiting, oncoming]; sim.st.peds = [];
  sim.permit.fill('main');
  for (const v of sim.st.vehicles) sim.pose(v);
  const internal = sim as unknown as {
    index(): void;
    wouldStopInside(v: Vehicle, ci: number, ref: ConflictRef, offset: number): boolean;
    mustWait(v: Vehicle, ci: number, ref: ConflictRef, start: number, end: number): boolean;
  };
  internal.index();
  const offset = sim.net.arms.E.cfg.approachLength - waiting.s;
  assert.equal(internal.wouldStopInside(waiting, turn.idx, merge, offset), false,
    'Слияние полос одного подхода должно позволять выдвинуться до отдельного пересечения встречного потока');
  assert.equal(internal.mustWait(waiting, turn.idx, crossing, offset + crossing.start, offset + crossing.end), true,
    'Выдвижение не отменяет уступку встречному автомобилю перед реальным пересечением');
  const merging: Vehicle = { ...structuredClone(waiting), id: 10003, conn: merge.other,
    lane: sim.net.conns[merge.other].conn.from.lane, phase: 'conn', s: 4, committed: [merge.conflict] };
  sim.st.vehicles.push(merging); sim.pose(merging); internal.index();
  assert.equal(internal.mustWait(waiting, turn.idx, merge, offset + merge.start, offset + merge.end), true,
    'Уже въехавшая машина в общей полосе сохраняет очередь слияния');
} finally { sim.dispose(); }

const live = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  let entered = false;
  while (live.st.t < 300) {
    live.step();
    if (live.st.vehicles.some(v => v.id === 45 && v.phase === 'conn')) entered = true;
  }
  assert.ok(entered, 'Левый поворот должен выдвинуться на зелёный перед ожиданием встречного потока');
  assert.ok(!live.st.vehicles.some(v => v.id === 45 && v.phase !== 'exit'),
    'Контрольный поворот должен завершиться до следующего цикла');
  assert.equal(live.st.counters.collisions, 0);
  assert.equal(live.st.counters.deadlocks, 0);
  assert.equal(live.st.counters.interventions, 0);
  console.log('Выдвижение после слияния сохраняет встречный приоритет и очередь общей полосы.');
} finally { live.dispose(); }
