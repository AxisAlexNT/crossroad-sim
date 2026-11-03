import assert from 'node:assert/strict';
import { migrateSession, serializeSession } from '../src/engine/session';
import { defaultModel } from '../src/engine/presets';
import { serializeModel } from '../src/engine/model';
import { decidePriority, type PriorityParticipant } from '../src/engine/priority';
import { armRelations } from '../src/engine/network';
import { Simulation } from '../src/engine/sim';
import { compileModel } from '../src/engine/compile';

const cfg = defaultModel('v1');
cfg.name = 'Проверка переноса'; cfg.sim.seed = 78; cfg.signals.phases[0].duration = 37;
const text = serializeSession(cfg, 'removed-preset', { theme: 'light', showTimers: true });
const loaded = migrateSession(JSON.parse(text));
assert.equal(serializeModel(loaded.cfg), serializeModel(cfg));
assert.equal(loaded.preferences.showTimers, true);
assert.equal(loaded.presetId, 'removed-preset');
assert.equal(loaded.report.warnings.length, 0, loaded.report.warnings.join('\n'));
assert.equal(serializeModel(migrateSession({ cfg }).cfg), serializeModel(cfg));
assert.throws(() => migrateSession({ ...JSON.parse(text), version: 99 }));
const changed = JSON.parse(text); changed.cfg.extraSetting = 1;
assert.ok(migrateSession(changed).report.warnings.some(x => x.includes('extraSetting')));
assert.equal(changed.cfg.extraSetting, 1);
const participant = (id: number, arm: string, left = false): PriorityParticipant => ({ id, arm, left, illegal: false, clearing: false, arrow: false });
for (const angle of [0, 31, 180]) {
  const rel = armRelations(cfg.arms.map(a => ({ ...a, angle: a.angle + angle })));
  for (const a of cfg.arms) {
    const right = rel.onRight[a.id]; if (!right) continue;
    for (const [i, j] of [[1, 2], [200, 10]]) {
      const x = participant(i, a.id), y = participant(j, right, true);
      assert.equal(decidePriority(x, y, rel.opposite, rel.onRight).yields, true);
      assert.equal(decidePriority(y, x, rel.opposite, rel.onRight).yields, false);
    }
  }
}
const sim = new Simulation(cfg, compileModel(cfg).code);
sim.runUntil(20);
for (const a of cfg.arms) sim.st.queue[a.id] = [];
const a = cfg.arms[0].id;
sim.st.queue[a].push({ nv: { destination: cfg.arms[1].id, kind: 'car', length: 4.5 }, t: 0, rs: 1 });
const before = sim.armQueue(a);
sim.st.queue[a].push({ nv: { destination: cfg.arms[1].id, kind: 'car', length: 4.5 }, t: 0, rs: 2 });
assert.equal(sim.armQueue(a), before, 'Внешняя очередь не должна менять дорожную');
sim.dispose();
console.log('Совместимость, приоритеты, разделение очередей: успешно');

const { signalRemaining, lampOf } = await import('../src/engine/signals');
const program = structuredClone(cfg.signals);
program.controller = 'fixed';
const group = program.groups[0];
program.phases = [{ id: 'a', name: 'a', duration: 10, green: [group.id] }, { id: 'b', name: 'b', duration: 20, green: [group.id] }, { id: 'c', name: 'c', duration: 10, green: [] }];
const runtime = { phaseIdx: 0, nextIdx: 1, segment: 'main' as const, segStart: 0, segDur: 10, phaseDur: 10, cycleCount: 0 };
assert.equal(signalRemaining(program, runtime, group, 3), 27);
assert.equal(lampOf(program, runtime, group, 9), 'G');
program.controller = 'code';
assert.equal(signalRemaining(program, runtime, group, 3), null);
const { runExperiment, compareExperiments, parseExperiment } = await import('../src/engine/experiment');
const exp = runExperiment({ cfg, dt: .1, warmup: 0, horizon: 20, seeds: [1, 2] });
assert.equal(compareExperiments(exp, structuredClone(exp), 'avgWait').mean, 0);
assert.equal(parseExperiment(JSON.parse(JSON.stringify(exp))).runs.length, 2);
assert.throws(() => parseExperiment({ ...exp, version: 2 }));
console.log('Таймеры и эксперименты: успешно');

// Перестроение отменяет маршрут и разрешения, относившиеся к прежней полосе.
{
  const m = defaultModel('v1');
  const s = new Simulation(m, compileModel(m).code, { headless: true });
  s.runUntil(30);
  const template = s.st.vehicles.find(v => v.origin === 'E');
  assert.ok(template);
  const v = structuredClone(template);
  Object.assign(v, { phase: 'approach', lane: 1, targetLane: 0, lcT: -1, s: 5, illegal: true, conn: -1, committed: [0], dwellUntil: -1 });
  s.st.vehicles = [v];
  const internals = s as unknown as { index(): void; laneChanges(): void };
  internals.index(); internals.laneChanges();
  assert.equal(v.lane, 0);
  assert.equal(v.illegal, false);
  assert.deepEqual(v.committed, []);
  s.dispose();
}
console.log('Перестроение освобождает старое состояние манёвра: успешно');
{
  const m = defaultModel('v1');
  const s = new Simulation(m, compileModel(m).code, { headless: true });
  s.runUntil(30);
  const v = structuredClone(s.st.vehicles.find(v => v.origin === 'E')!);
  const illegal = s.net.illegalFor.E[1];
  const dest = Object.keys(illegal)[0];
  assert.ok(dest);
  Object.assign(v, { lane: 1, targetLane: 0, dest, committed: [0] });
  v.viol.turn = true; v.viol.solid = false;
  (s as unknown as { resolveMissedLane(v: typeof v, allow: boolean): void }).resolveMissedLane(v, false);
  assert.equal(v.illegal, true);
  assert.equal(v.targetLane, v.lane, 'Выбранный манёвр отменяет прежнюю цель перестроения');
  assert.deepEqual(v.committed, []);
  s.dispose();
}

// Окно измерения не включает ожидание до прогрева, в том числе у незавершённых поездок.
{
  const m = defaultModel('v1');
  const s = new Simulation(m, compileModel(m).code);
  const arm = m.arms[0].id;
  s.st.t = 100;
  s.st.counters.waitArea = 90;
  s.st.counters.waitAreaBy[arm] = 90;
  s.st.counters.pedWaitArea = 70;
  const warm = { t: s.st.t, counters: structuredClone(s.st.counters) };
  s.st.t = 110;
  s.st.queue[arm].push({ nv: { destination: m.arms[1].id, kind: 'car', length: 4.5 }, t: 0, rs: 1 });
  s.st.counters.waitArea += 15; // 10 с незавершённого ожидания и 5 с завершённого.
  s.st.counters.waitAreaBy[arm] += 15;
  s.st.counters.crossedStop++;
  s.st.counters.crossedBy[arm] = 1;
  s.st.counters.sumWait += 100; // Старый счётчик содержит ожидание до окна.
  s.st.counters.pedDone = 2;
  s.st.counters.pedWaitArea += 12;
  s.st.counters.pedWaitSum = 100;
  const result = s.summary(warm);
  assert.equal(result.avgWait, 7.5);
  assert.equal(result.worstWait, 7.5);
  assert.equal(result.unserved, 1);
  assert.equal(result.pedAvgWait, 6);
  s.dispose();
}
console.log('Окно ожидания исключает прогрев и учитывает незавершённые поездки: успешно');

// Проверка интеграла по независимому балансу индивидуальных ожиданий.
{
  const m = defaultModel('v1');
  const s = new Simulation(m, compileModel(m).code);
  s.runUntil(120);
  assert.equal(s.st.counters.collisions, 0);
  const vehicleWait = s.st.counters.sumWait
    + s.st.vehicles.filter(v => v.phase === 'approach').reduce((n, v) => n + v.stopTime, 0)
    + Object.values(s.st.queue).flat().reduce((n, q) => n + s.st.t - q.t, 0);
  assert.ok(Math.abs(s.st.counters.waitArea - vehicleWait) < 1e-6, `${s.st.counters.waitArea} != ${vehicleWait}`);
  const pedWait = s.st.counters.pedWaitSum + s.st.peds.reduce((n, p) => n + p.waitTime * p.size, 0);
  assert.ok(Math.abs(s.st.counters.pedWaitArea - pedWait) < 1e-6);
  s.dispose();
}
console.log('Интегралы ожидания совпадают с балансом участников: успешно');

// Отказы во время прогрева также запрещают использовать результат для сравнения.
{
  const { invalidRunReasons } = await import('../src/engine/runValidity');
  const m = defaultModel('v1');
  const s = new Simulation(m, compileModel(m).code);
  assert.deepEqual(invalidRunReasons(s.st.counters, 0), []);
  for (const key of ['errors', 'codeErrors', 'collisions', 'pedHits', 'dropped', 'pedDropped', 'removedCrash', 'pedRouteErrors', 'deadlocks'] as const) {
    const counters = structuredClone(s.st.counters);
    counters[key] = 1;
    assert.equal(invalidRunReasons(counters, 0).length, 1, key);
  }
  assert.equal(invalidRunReasons(s.st.counters, 1).length, 1);
  assert.equal(invalidRunReasons(s.st.counters, 0, true).length, 1);
  const recovery = structuredClone(cfg); recovery.sim.diagnosticRecovery = true;
  const result = runExperiment({ cfg: recovery, dt: .1, warmup: 1, horizon: 1, seeds: [1] });
  assert.equal(result.runs[0].status, 'invalid');
  assert.ok(result.runs[0].invalidReasons?.length);
  assert.throws(() => compareExperiments(result, result, 'avgWait'));
  const forged = structuredClone(exp);
  forged.runs[0].summary.collisions = 1;
  assert.throws(() => parseExperiment(forged));
  assert.throws(() => compareExperiments(forged, forged, 'avgWait'));
  const malformed = structuredClone(exp);
  malformed.runs[0].summary.worstWait = NaN;
  assert.throws(() => parseExperiment(malformed));
  s.dispose();
}
console.log('Непригодные прогоны исключаются из сравнения: успешно');

// Одновременный въезд по вариантам одной полосы не создаёт взаимного уступания.
{
  const m = defaultModel('v1'); m.sim.seed = 7961;
  for (const durations of [[30, 30, 25, 25], [25, 22, 26, 25], [27, 16, 18, 23], [32, 14, 40, 23], [35, 20, 24, 19]]) for (const dt of [.1, .2]) {
    m.signals.phases.forEach((p, i) => { p.duration = durations[i]; });
    const s = new Simulation(m, compileModel(m).code, { headless: true, dt });
    s.runUntil(520);
    assert.equal(s.st.counters.deadlocks, 0, `Блокировка: фазы ${durations.join('/')}, dt=${dt}`);
    assert.equal(s.st.counters.collisions, 0, 'Разрешение очерёдности не должно отключать безопасность');
    assert.equal(s.logCounts['deadlock-manual'] ?? 0, 0);
    assert.ok(s.st.counters.exited > 100);
    s.dispose();
  }
}
console.log('Одновременное слияние: нет блокировки и столкновений');

// Аналитические значения потери времени и отсечение границы окна.
{
  const { timeLoss } = await import('../src/engine/metrics');
  assert.equal(timeLoss(10, 100, 10), 0);
  assert.equal(timeLoss(10, 50, 10), 5);
  assert.equal(timeLoss(10, 0, 10), 10);
  assert.equal(timeLoss(10, 120, 10), 0);
  assert.throws(() => timeLoss(10, 1, 0));
  const m = defaultModel('v1');
  const s = new Simulation(m, compileModel(m).code);
  s.st.t = 100; s.st.counters.delayArea = 80;
  const warm = { t: s.st.t, counters: structuredClone(s.st.counters) };
  s.st.t = 110; s.st.counters.delayArea += 15; s.st.counters.exited = 1;
  s.st.queue[m.arms[0].id].push({ nv: { destination: m.arms[1].id, kind: 'car', length: 4.5 }, t: 0, rs: 1 });
  assert.equal(s.summary(warm).avgDelay, 7.5, 'Задержка учитывает незавершённую поездку и исключает прогрев');
  s.dispose();
}
console.log('Задержка: аналитические значения и граница окна совпадают');

// Резервация пересекающихся вариантов видна ещё до одновременного въезда.
for (const [seed, phases] of [[115883, [35, 11, 23, 19]], [107964, [35, 12, 21, 19]]] as const) {
  const m = defaultModel('v1'); m.sim.seed = seed;
  phases.forEach((d, i) => { m.signals.phases[i].duration = d; });
  for (const dt of [.05, .1, .2]) {
    const s = new Simulation(m, compileModel(m).code, { headless: true, dt });
    s.runUntil(900);
    assert.equal(s.st.counters.collisions, 0, `Столкновение одновременного въезда, seed=${seed}, dt=${dt}`);
    assert.equal(s.st.counters.deadlocks, 0, `Блокировка одновременного въезда, seed=${seed}, dt=${dt}`);
    assert.ok(s.st.counters.exited > 200);
    s.dispose();
  }
}
console.log('Резервации до въезда: три шага расчёта без столкновений и блокировок');
