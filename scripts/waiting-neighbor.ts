import assert from 'node:assert/strict';
import { TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import type { ConflictRef } from '../src/engine/network';
import { invalidRunReasons } from '../src/engine/runValidity';

const cfg = TEMPLATES.find(t => t.id === 'cross4')!.make();
cfg.sim.seed = 42; cfg.sim.mode = 'strict'; cfg.sim.diagnosticRecovery = false;
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60); const base = sim.st.vehicles[0]; assert.ok(base);
  const right = sim.net.conns.find(c => c.conn.id === 'S1-E1' && c.variant === 0)!;
  const left = sim.net.conns.find(c => c.conn.id === 'S0-W0' && c.variant === 0)!;
  const through = sim.net.conns.find(c => c.conn.id === 'N0-S0' && c.variant === 0)!;
  const ref = right.conflicts.find(r => r.other === left.idx && sim.net.conflicts[r.conflict].body)!; assert.ok(ref);
  const reverse = left.conflicts.find(r => r.conflict === ref.conflict)!;
  const make = (id: number, ci: number, len: number, wid: number, lat: number, lat2: number): Vehicle => ({
    ...structuredClone(base), id, conn: ci, origin: 'S', dest: sim.net.conns[ci].conn.to.arm,
    lane: sim.net.conns[ci].conn.from.lane, targetLane: sim.net.conns[ci].conn.from.lane, lcT: -1,
    phase: 'approach', s: sim.net.arms.S.cfg.approachLength - 2.3, v: 0, a: 0,
    len, wid, lat, lat2, amax: 1.35, bcomf: 2, route: null, stopsLeft: [],
    committed: [], acceptedGrants: undefined, why: 'free', whyId: -1, yieldTo: -1, yieldingAt: -1,
    crashed: false, overStop: false, s0: 1.5,
  });
  const truck = make(10001, right.idx, 11.82883053, 2.5, .606907258, -.75812082);
  const bus = make(10002, left.idx, 12.1296486, 2.55, -.888062183, -.622049182);
  const oncoming = { ...structuredClone(base), id: 10003, conn: through.idx, origin: 'N', dest: 'S',
    phase: 'conn' as const, s: 1.4, v: 5.5, a: 1, route: null, crashed: false };
  truck.tWanted = 20; bus.tWanted = 10;
  bus.why = 'yield'; bus.yieldTo = oncoming.id;
  sim.st.vehicles = [truck, bus, oncoming]; sim.st.peds = []; sim.permit.fill('main');
  for (const v of sim.st.vehicles) sim.pose(v);
  const internal = sim as unknown as {
    index(): void; accel(v: Vehicle): number;
    bodyConflictApplies(v: Vehicle, ci: number, other: Vehicle, oi: number): boolean;
    wouldStopInside(v: Vehicle, ci: number, ref: ConflictRef, offset: number): boolean;
    mustWait(v: Vehicle, ci: number, ref: ConflictRef, start: number, end: number): boolean;
    firstHit(v: Vehicle, ci: number, from: number, until: number, other: Vehicle): number;
  };
  internal.index();
  const offset = sim.net.arms.S.cfg.approachLength - truck.s;
  const waits = () => internal.mustWait(truck, right.idx, ref, offset + ref.start, offset + ref.end);
  assert.equal(internal.firstHit(truck, right.idx, 0, right.path.length + truck.len, bus), Infinity,
    'Соседний неподвижный кузов не занимает проверяемый путь');
  assert.equal(waits(), true, 'Ранее прибывший сосед сохраняет обычную очерёдность');
  assert.equal(internal.wouldStopInside(bus, left.idx, reverse, offset), false,
    'Общий кузовной коридор полос одного подхода не должен запрещать выдвижение к отдельному встречному пересечению');
  assert.ok(internal.accel(bus) >= 0, 'Поворот не должен тормозить перед свободным общим коридором');
  sim.st.t += bus.reaction + cfg.sim.dt;
  assert.ok(internal.accel(bus) > 0, 'После своего времени реакции водитель должен начать выдвижение');
  assert.ok(bus.committed.includes(ref.conflict), 'Выдвигающийся автомобиль получает обычный резерв общей кузовной зоны');
  assert.equal(waits(), true, 'Сосед не может тронуться навстречу уже выданному резерву');
  truck.committed = []; bus.committed = [ref.conflict];
  assert.equal(waits(), true, 'Ранее выданный резерв соседа сохраняется');
  bus.committed = []; bus.v = 1; bus.a = 1; bus.why = 'free';
  assert.equal(waits(), true, 'Движущийся сосед сохраняет обычную очерёдность');
  const throughSame = sim.net.conns.find(c => c.conn.id === 'S1-N1' && c.variant === 0)!;
  const laterBody = left.conflicts.find(r => r.other === throughSame.idx && sim.net.conflicts[r.conflict].body)!;
  assert.ok(laterBody);
  const maxBus = cfg.spawners.S.params.types.find(t => t.kind === 'bus')!.lengthMax;
  const adjacent = { ...make(10004, throughSame.idx, maxBus, 2.55, 1, -1), kind: 'bus' as const };
  const wideTurn = { ...bus, id: 10005, kind: 'bus' as const, len: maxBus, wid: 2.55, lat: -1, lat2: -1, v: 0, a: 0, committed: [] };
  sim.st.vehicles = [wideTurn, adjacent, oncoming];
  for (const v of sim.st.vehicles) sim.pose(v);
  internal.index();
  assert.equal(internal.bodyConflictApplies(wideTurn, left.idx, adjacent, throughSame.idx), true,
    'Габариты контрольных автобусов должны действительно пересекаться дальше от входа');
  assert.equal(internal.wouldStopInside(wideTurn, left.idx, laterBody, offset), true,
    'Кузовное пересечение дальше от входа сохраняет проверку места перед встречным потоком');

} finally { sim.dispose(); }

const live = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  const targets = new Map([250, 292].map(serial => [serial, {
    seen: false, clearedAt: Infinity, maxNoProgress: 0,
    moved: undefined as { phase: string; s: number; t: number } | undefined,
  }]));
  for (let t = 10; t <= 4200; t += 10) {
    live.runUntil(t);
    for (const [serial, row] of targets) {
      const target = live.st.vehicles.find(v => v.demand?.source === 'car:S' && v.demand.serial === serial);
      if (target) {
        row.seen = true;
        if (!row.moved || row.moved.phase !== target.phase || Math.abs(target.s - row.moved.s) > 1) {
          row.moved = { phase: target.phase, s: target.s, t };
        }
        row.maxNoProgress = Math.max(row.maxNoProgress, t - row.moved.t);
      }
      if (row.seen && (!target || target.phase === 'exit')) row.clearedAt = Math.min(row.clearedAt, t);
    }
  }
  for (const [serial, row] of targets) {
    assert.ok(row.seen, `Контрольное событие ${serial} должно появиться в модели`);
    assert.ok(Number.isFinite(row.clearedAt), `Контрольное событие ${serial} должно завершиться в пределах прогона`);
    assert.ok(row.maxNoProgress < 300,
      `Контрольное событие ${serial} не должно стоять без продвижения 300 с, получено ${row.maxNoProgress}`);
  }
  assert.deepEqual(invalidRunReasons(live.st.counters, live.logCounts['deadlock-manual'] ?? 0, false), []);
  console.log('Выдвижение в общем кузовном коридоре сохраняет очередь и ограничение длительной остановки.');
} finally { live.dispose(); }
