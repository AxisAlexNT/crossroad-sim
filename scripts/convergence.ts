import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { defaultModel, PRESETS, TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Summary } from '../src/engine/sim';
import { invalidRunReasons } from '../src/engine/runValidity';
import { meanCi } from '../src/engine/optimizer';
import { ENGINE_VERSION } from '../src/engine/version';
import type { ModelConfig } from '../src/engine/types';

const horizon = Number(process.argv[2] ?? 1200);
const count = Number(process.argv[3] ?? 10);
const only = process.argv[4];
const output = process.argv[5];
if (!Number.isInteger(horizon) || horizon < 60 || horizon > 86400 || !Number.isInteger(count) || count < 10 || count > 100) throw new Error('Нужны горизонт от 60 до 86400 с и от 10 до 100 зёрен.');
const warmup = 300;
const steps = process.argv[6] ? process.argv[6].split(',').map(Number) : [.2, .1, .05];
if (steps.length !== 3 || steps.some((dt, i) => !Number.isFinite(dt) || dt < .02 || dt > .5 || (i > 0 && dt >= steps[i - 1]))) {
  throw new Error('Нужны три строго убывающих шага от 0,02 до 0,5 с, разделённые запятыми.');
}
const seeds = Array.from({ length: count }, (_, i) => 42 + i * 1000);
// Заранее выбранные инженерные допуски, а не результат подгонки к прогонам.
const metrics = [
  { key: 'throughputVph', absolute: 5, relative: .05 },
  { key: 'avgWait', absolute: 1, relative: .05 },
  { key: 'avgDelay', absolute: 1, relative: .05 },
  { key: 'pedAvgWait', absolute: 1, relative: .05 },
  { key: 'maxQueue', absolute: 1, relative: .05 },
] as const;
const cases: Array<[string, () => ModelConfig]> = [
  ...PRESETS.map(p => [p.id, () => defaultModel(p.id)] as [string, () => ModelConfig]),
  ...TEMPLATES.slice(1).map(t => ['template-' + t.id, t.make] as [string, () => ModelConfig]),
];
const picked = cases.filter(([label]) => !only || label === only);
if (!picked.length) throw new Error('Не найдена модель для проверки.');
const engineDir = new URL('../src/engine/', import.meta.url);
const hash = createHash('sha256');
for (const file of readdirSync(engineDir).filter(f => f.endsWith('.ts')).sort()) hash.update(file).update(readFileSync(new URL(file, engineDir)));
interface Run { seed: number; dt: number; summary?: Summary; vehicles?: number; pedestrians?: number; invalid: string[] }
const report = {
  format: 'crossroad-convergence', version: 1, engineVersion: ENGINE_VERSION, engineHash: hash.digest('hex'),
  started: new Date().toISOString(), warmup, horizon, steps, seeds, tolerances: metrics,
  measurement: { maxQueueExcludesWarmup: true },
  verifierHash: createHash('sha256').update(readFileSync(new URL('./convergence.ts', import.meta.url))).digest('hex'),
  cases: [] as Array<{ label: string; cfg: ModelConfig; runs: Run[]; comparisons: unknown[]; failures: string[] }>,
  passed: false, completed: false,
};
console.log(`Шаг расчёта: движок ${ENGINE_VERSION}, ${warmup}+${horizon} с, ${count} зёрен, ${steps.join(' / ')} с`);
for (const [label, make] of picked) {
  const cfg = make();
  const result: typeof report.cases[number] = { label, cfg, runs: [], comparisons: [], failures: [] };
  report.cases.push(result);
  for (const seed of seeds) {
    for (const dt of steps) {
      const model = structuredClone(cfg); model.sim.seed = seed; model.sim.dt = dt;
      let sim: Simulation | undefined;
      const run: Run = { seed, dt, invalid: [] };
      try {
        const compiled = compileModel(model);
        if (compiled.errors.length) throw new Error(compiled.errors.join('\n'));
        sim = new Simulation(model, compiled.code, { headless: true, dt });
        sim.runUntil(warmup);
        const warm = { t: sim.st.t, counters: structuredClone(sim.st.counters) };
        sim.st.maxQueue = 0;
        sim.runUntil(warmup + horizon);
        run.summary = sim.summary(warm);
        run.vehicles = sim.st.counters.spawned + Object.values(sim.st.queue).reduce((n, q) => n + q.length, 0) + sim.st.counters.dropped;
        run.pedestrians = sim.st.counters.pedSpawned + sim.st.counters.pedDropped;
        run.invalid = invalidRunReasons(sim.st.counters, sim.logCounts['deadlock-manual'] ?? 0, model.sim.diagnosticRecovery);
        if (metrics.some(m => !Number.isFinite(run.summary![m.key]))) run.invalid.push('нечисловые показатели');
      } catch (error) { run.invalid.push(error instanceof Error ? error.message : String(error)); }
      finally { sim?.dispose(); }
      result.runs.push(run);
      if (run.invalid.length) result.failures.push(`seed=${seed}, dt=${dt}: ${run.invalid.join(', ')}`);
    }
    const paired = result.runs.filter(r => r.seed === seed);
    if (paired.some(r => r.vehicles !== paired[0].vehicles || r.pedestrians !== paired[0].pedestrians)) result.failures.push(`seed=${seed}: различаются количества входного спроса`);
    console.log(`${label}, seed=${seed}: ${paired.map(r => `${r.dt}: ${r.invalid.length ? r.invalid.join(', ') : 'пригоден'}`).join(' | ')}`);
  }
  // Непригодные повторы не удаляются из выборки ради успешного сравнения.
  if (!result.failures.length) {
    for (const metric of metrics) {
      const finest = result.runs.filter(r => r.dt === steps[2]).map(r => r.summary![metric.key]);
      const tolerance = Math.max(metric.absolute, Math.abs(meanCi(finest).mean) * metric.relative);
      for (let i = 0; i < steps.length - 1; i++) {
        const differences = seeds.map(seed => {
          const a = result.runs.find(r => r.seed === seed && r.dt === steps[i])!;
          const b = result.runs.find(r => r.seed === seed && r.dt === steps[i + 1])!;
          return b.summary![metric.key] - a.summary![metric.key];
        });
        const { mean, ci } = meanCi(differences);
        const passed = Number.isFinite(ci) && Math.abs(mean) + ci <= tolerance;
        result.comparisons.push({ metric: metric.key, coarse: steps[i], fine: steps[i + 1], differences, mean, ci95: ci, tolerance, passed });
        console.log(`${label} ${metric.key} ${steps[i]}→${steps[i + 1]}: ${mean.toFixed(3)} ± ${ci.toFixed(3)}, допуск ${tolerance.toFixed(3)}: ${passed ? 'да' : 'НЕТ'}`);
        if (!passed) result.failures.push(`${metric.key}, ${steps[i]}→${steps[i + 1]}: интервал выходит за допуск`);
      }
    }
  }
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
report.passed = report.cases.every(c => !c.failures.length);
report.completed = true;
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(report.passed ? 'Проверка чувствительности к шагу пройдена в заданных допусках.' : 'Проверка чувствительности к шагу НЕ пройдена.');
if (!report.passed) process.exitCode = 1;
