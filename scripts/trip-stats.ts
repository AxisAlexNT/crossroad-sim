import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Counters, type TripTotals, type Vehicle } from '../src/engine/sim';
import { invalidRunReasons } from '../src/engine/runValidity';

const cfg = defaultModel('v1');
cfg.sim.seed = 42; cfg.sim.mode = 'strict'; cfg.sim.diagnosticRecovery = false;
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  assert.deepEqual(sim.st.counters.trips, {}, 'Новый прогон начинается без завершённых поездок');
  const start = { t: sim.st.t, counters: structuredClone(sim.st.counters) };
  let middle = start;
  const spawnedRoutes = new Set<string>();
  const measured = new Map<string, TripTotals>();
  const tracks = new Map<number, { first: number; distance: number; dwell: number }>();
  const originalStep = sim.step.bind(sim);
  sim.step = () => {
    const before = sim.st.vehicles.map(v => ({ ref: v, phase: v.phase, s: v.s, conn: v.conn, dwellUntil: v.dwellUntil }));
    const previous = new Map(before.map(v => [v.ref.id, v]));
    const oldExited = sim.st.counters.exited;
    originalStep();
    const present = new Set(sim.st.vehicles.map(v => v.id));
    const progress = (old: typeof before[number], v: Vehicle) => {
      if (old.phase === v.phase) return v.s - old.s;
      if (old.phase === 'approach' && v.phase === 'conn') return sim.net.arms[v.origin].cfg.approachLength - old.s + v.s;
      assert.equal(old.phase, 'conn'); assert.equal(v.phase, 'exit');
      return sim.net.conns[old.conn].path.length - old.s + v.s;
    };
    for (const v of sim.st.vehicles) {
      const old = previous.get(v.id);
      let track = tracks.get(v.id);
      if (!track) {
        assert.equal(v.phase, 'approach');
        assert.ok(sim.st.t - v.tEnter >= 0 && sim.st.t - v.tEnter <= sim.dt + 1e-6,
          'Время входа соответствует первому наблюдению машины с точностью шага');
        track = { first: sim.st.t, distance: v.s, dwell: 0 };
        tracks.set(v.id, track);
      } else track.distance += progress(old!, v);
      if (v.dwellUntil >= 0 && v.dwellUntil !== (old?.dwellUntil ?? -1)) track.dwell += v.dwellUntil - sim.st.t;
    }
    let removed = 0;
    for (const old of before) {
      const v = old.ref;
      if (present.has(v.id)) continue;
      assert.equal(v.phase, 'exit');
      const end = sim.net.arms[v.dest].cfg.exitLength;
      assert.ok(v.s >= end, 'Завершение фиксируется на границе модели');
      const track = tracks.get(v.id)!;
      const duration = sim.st.t - v.tEnter, observedDuration = sim.st.t - track.first;
      assert.ok(duration >= observedDuration - 1e-6 && duration <= observedDuration + sim.dt + 1e-6,
        'Время завершённой поездки совпадает с наблюдением входа и выхода');
      track.distance += progress(old, v);
      if (v.dwellUntil >= 0 && v.dwellUntil !== old.dwellUntil) track.dwell += v.dwellUntil - sim.st.t;
      const keys = [`od:${v.origin}>${v.dest}`];
      if (v.route) keys.push('route:' + v.route);
      for (const key of keys) {
        const trip = measured.get(key) ?? { n: 0, time: 0, dist: 0, wait: 0, dwell: 0 };
        trip.n++;
        trip.time += sim.st.t - v.tEnter;
        trip.dist += track.distance - (v.s - end);
        trip.wait += v.stopTime;
        trip.dwell += track.dwell;
        measured.set(key, trip);
      }
      tracks.delete(v.id); removed++;
    }
    assert.equal(sim.st.counters.exited - oldExited, removed, 'Каждому завершению соответствует наблюдаемый выезд');
  };
  for (let t = 1; t <= 1800; t++) {
    sim.runUntil(t);
    for (const v of sim.st.vehicles) if (v.route) spawnedRoutes.add(v.route);
    for (const queue of Object.values(sim.st.queue)) for (const item of queue) {
      if (item.nv.route) spawnedRoutes.add(item.nv.route);
    }
    if (t === 900) middle = { t: sim.st.t, counters: structuredClone(sim.st.counters) };
  }
  sim.step = originalStep;
  const entries = Object.entries(sim.st.counters.trips);
  const od = entries.filter(([key]) => key.startsWith('od:'));
  const routes = entries.filter(([key]) => key.startsWith('route:'));
  assert.equal(od.reduce((n, [, trip]) => n + trip.n, 0), sim.st.counters.exited,
    'Все завершённые поездки должны попасть ровно в одно направление');
  assert.ok(sim.st.counters.exited > 0 && sim.st.counters.busSpawned > 0 && spawnedRoutes.size > 0);
  const speedRangeFailures: Array<{ key: string; speed: number }> = [];
  for (const [key, trip] of entries) {
    assert.ok(Object.values(trip).every(Number.isFinite), 'Суммы поездок должны быть конечными числами');
    if (trip.n === 0) {
      assert.ok(key.startsWith('route:'), 'Пустая строка допустима только для появившегося маршрута');
      assert.ok(spawnedRoutes.has(key.slice(6)));
      assert.equal(measured.has(key), false, 'Пустая строка не скрывает наблюдаемое завершение');
      assert.deepEqual(trip, { n: 0, time: 0, dist: 0, wait: 0, dwell: 0 });
      continue;
    }
    const observed = measured.get(key); assert.ok(observed, key);
    assert.equal(trip.n, observed.n, key);
    assert.equal(trip.time, observed.time, key);
    assert.equal(trip.wait, observed.wait, key);
    assert.ok(Math.abs(trip.dist - observed.dist) <= 1e-6, `${key}: путь совпадает с наблюдаемым перемещением`);
    assert.ok(Math.abs(trip.dwell - observed.dwell) <= 1e-6, `${key}: стоянка совпадает с наблюдаемыми интервалами`);
    assert.ok(Number.isInteger(trip.n) && trip.n > 0 && trip.time > 0 && trip.dist > 0, key);
    assert.ok(trip.wait >= 0 && trip.dwell >= 0 && trip.dwell < trip.time, key);
    const speed = trip.dist / trip.time * 3.6;
    // Ожидание в модели может снизить среднюю скорость ниже 3 км/ч. Обоснование в docs/validation.md.
    if (!(Number.isFinite(speed) && speed > 0 && speed <= 70)) speedRangeFailures.push({ key, speed });
    if (key.startsWith('route:')) {
      const movingSpeed = trip.dist / (trip.time - trip.dwell) * 3.6;
      assert.ok(movingSpeed >= speed && movingSpeed <= 70, `${key}: скорость без стоянки ${movingSpeed}`);
    }
  }
  assert.equal(measured.size, entries.filter(([, trip]) => trip.n > 0).length);
  for (const id of spawnedRoutes) assert.ok(sim.st.counters.trips['route:' + id],
    'Появившийся автобусный маршрут должен иметь строку статистики');
  const busDistance = routes.reduce((n, [, trip]) => n + trip.dist, 0);
  const busTime = routes.reduce((n, [, trip]) => n + trip.time, 0);
  assert.equal(sim.summary(start).busAvgSpeed, busTime > 0 ? busDistance / busTime * 3.6 : 0);
  const distanceAfter = routes.reduce((n, [key, trip]) => n + (trip.dist - (middle.counters.trips[key]?.dist ?? 0)), 0);
  const timeAfter = routes.reduce((n, [key, trip]) => n + (trip.time - (middle.counters.trips[key]?.time ?? 0)), 0);
  assert.equal(sim.summary(middle).busAvgSpeed, timeAfter > 0 ? distanceAfter / timeAfter * 3.6 : 0,
    'Скорость в сводке учитывает только завершения после прогрева');
  assert.equal(sim.summary({ t: sim.st.t, counters: structuredClone(sim.st.counters) }).busAvgSpeed, 0,
    'Пустое окно не создаёт неопределённую скорость');
  assert.deepEqual(invalidRunReasons(sim.st.counters, sim.logCounts['deadlock-manual'] ?? 0, false), []);
  const saved = structuredClone(sim.st);
  sim.runUntil(1810);
  const continuedTrips = structuredClone(sim.st.counters.trips);
  const continuedDwell = sim.st.vehicles.map(v => [v.id, v.dwellSum]);
  sim.restore(saved); sim.runUntil(1810);
  assert.deepEqual(sim.st.counters.trips, continuedTrips, 'Восстановление снимка не дублирует завершённые поездки');
  assert.deepEqual(sim.st.vehicles.map(v => [v.id, v.dwellSum]), continuedDwell);
  const legacy = structuredClone(saved);
  delete (legacy.counters as Partial<Counters>).trips;
  for (const v of legacy.vehicles) delete (v as Partial<Vehicle>).dwellSum;
  sim.restore(legacy);
  assert.deepEqual(sim.st.counters.trips, {}, 'Старый снимок не получает вымышленные прошлые поездки');
  assert.ok(sim.st.vehicles.every(v => v.dwellSum === 0));
  assert.deepEqual(speedRangeFailures, [], 'Средние скорости должны быть конечными, положительными и не превышать 70 км/ч');
  console.log(`Поездки: ${saved.counters.exited} завершений, ${od.length} направлений и ${routes.length} автобусных маршрутов.`);
} finally { sim.dispose(); }
