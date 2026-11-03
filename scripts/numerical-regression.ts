import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation } from '../src/engine/sim';
import { invalidRunReasons } from '../src/engine/runValidity';

// Случаи, обнаруженные сравнением трёх шагов: перестроение перед переходом,
// частичная резервация перекрывающихся зон и очередь автобусов перед остановкой.
for (const seed of [21042, 24042, 25042, 27042, 29042]) for (const dt of [.2, .1, .05]) {
  const cfg = defaultModel('v1'); cfg.sim.seed = seed; cfg.sim.dt = dt;
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
  const served = new Set<string>();
  try {
    const zones = sim.net.conflicts;
    for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) {
      const a = zones[i], b = zones[j];
      if (a.a !== b.a || a.b !== b.b || a.kind !== b.kind || !!a.same !== !!b.same) continue;
      assert.ok(a.aStart > b.aEnd || b.aStart > a.aEnd || a.bStart > b.bEnd || b.bStart > a.bEnd,
        'Перекрывающийся коридор не должен иметь два независимых резерва');
    }
    while (sim.st.t < 1500) {
      sim.step();
      for (const v of sim.st.vehicles) {
        assert.ok(v.phase !== 'conn' || v.lcT < 0, `Незавершённое перестроение на перекрёстке: seed=${seed}, dt=${dt}, t=${sim.st.t}, id=${v.id}`);
        if (v.dwellUntil < 0) continue;
        const key = `${v.id}:${v.stopsLeft[0]}`;
        if (served.has(key)) continue;
        served.add(key);
        const stop = cfg.transit.stops.find(s => s.id === v.stopsLeft[0])!;
        assert.ok(stop, 'Обслуживание должно соответствовать остановке маршрута');
        const nominal = stop.side === 'exit' ? stop.dist + v.len : sim.net.arms[stop.arm].cfg.approachLength - stop.dist;
        assert.ok(Math.abs(v.s - nominal) < 1.5, `Обслуживание началось в очереди: seed=${seed}, dt=${dt}, id=${v.id}`);
      }
    }
    const invalid = invalidRunReasons(sim.st.counters, sim.logCounts['deadlock-manual'] ?? 0, cfg.sim.diagnosticRecovery);
    assert.deepEqual(invalid, [], `seed=${seed}, dt=${dt}`);
    assert.ok(sim.st.counters.exited > 250, 'Безопасность не достигается остановкой выпуска');
    assert.ok(sim.st.counters.busServed > 0, 'Автобусы должны продолжать обслуживать остановки');
    console.log(`Численная регрессия seed=${seed}, dt=${dt}: проехало ${sim.st.counters.exited}, обслуживаний ${sim.st.counters.busServed}`);
  } finally { sim.dispose(); }
}

// Предшествующая остановка на красный не заменяет устойчивость цикла ожидания.
{
  const cfg = defaultModel('v1'); cfg.sim.deadlockSeconds = 5;
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
  try {
    sim.runUntil(60);
    const [a, b] = sim.st.vehicles;
    assert.ok(a && b);
    sim.st.vehicles = [a, b];
    for (const v of [a, b]) Object.assign(v, { v: 0, stopSince: 0, dwellUntil: -1, crashed: false, why: 'leader' });
    a.whyId = b.id; b.whyId = a.id;
    sim.st.diag.cycleSince = {}; sim.st.status.deadlock = null; sim.st.counters.deadlocks = 0;
    const diagnose = (t: number) => { sim.st.t = t; (sim as unknown as { diagnose(): void }).diagnose(); };
    diagnose(100); diagnose(103);
    assert.equal(sim.st.counters.deadlocks, 0, 'Краткий цикл после долгой остановки не является устойчивой блокировкой');
    b.why = 'free'; diagnose(104);
    b.why = 'leader'; diagnose(110); diagnose(114);
    assert.equal(sim.st.counters.deadlocks, 0, 'Разрыв цикла сбрасывает время подтверждения');
    diagnose(115);
    assert.equal(sim.st.counters.deadlocks, 1, 'Устойчивая неподвижная блокировка должна обнаруживаться');
    assert.equal(sim.st.status.deadlock?.since, 110);
    diagnose(116);
    assert.equal(sim.st.counters.deadlocks, 1, 'Продолжение одного события не увеличивает счётчик');
    a.v = 1; diagnose(117); diagnose(127);
    assert.equal(sim.st.status.deadlock, null);
  } finally { sim.dispose(); }
}
console.log('Диагностика: краткий цикл не считается блокировкой, устойчивый обнаруживается');
