import { invalidRunReasons } from './runValidity';
import { ENGINE_VERSION } from './version';
import { normalizeModel } from './model';
import { compileModel } from './compile';
import { Simulation, type Series, type Summary } from './sim';
import type { ModelConfig } from './types';

export interface ExperimentSpec { cfg: ModelConfig; warmup: number; horizon: number; seeds: number[]; dt: number }
export interface RunResult { seed: number; summary: Summary; series: Series; interventions: number; invalidReasons?: string[]; status: 'complete' | 'invalid' }
export interface ExperimentResult { format: 'crossroad-experiment'; version: 1; engineVersion: string; spec: ExperimentSpec; runs: RunResult[] }
export interface ComparisonResult { metric: keyof Summary; differences: number[]; mean: number; ci95: number | null }
export function validateExperiment(s: ExperimentSpec) {
  if (!Number.isFinite(s.warmup) || s.warmup < 0 || s.warmup > 86400 || !Number.isFinite(s.horizon) || s.horizon < 1 || s.horizon > 86400 || !Number.isFinite(s.dt) || s.dt < .02 || s.dt > .5 || !Array.isArray(s.seeds) || s.seeds.length < 1 || s.seeds.length > 100 || new Set(s.seeds).size !== s.seeds.length || s.seeds.some(n => !Number.isInteger(n) || n < 0 || n > 2147483647)) throw new Error('Недопустимые параметры эксперимента.');
}
export function runExperiment(spec: ExperimentSpec, progress: (n: number) => void = () => {}): ExperimentResult {
  validateExperiment(spec);
  const result: ExperimentResult = { format: 'crossroad-experiment', version: 1, engineVersion: ENGINE_VERSION, spec: structuredClone(spec), runs: [] };
  for (const seed of spec.seeds) {
    const cfg = structuredClone(spec.cfg); cfg.sim.seed = seed;
    const compiled = compileModel(cfg);
    if (compiled.errors.length) throw new Error(compiled.errors.join('\n'));
    const sim = new Simulation(cfg, compiled.code, { dt: spec.dt });
    try {
      sim.runUntil(spec.warmup);
      const warm = { counters: structuredClone(sim.st.counters), t: sim.st.t };
      sim.st.maxQueue = 0;
      sim.runUntil(spec.warmup + spec.horizon);
      const interventions = sim.logCounts['deadlock-manual'] ?? 0;
      const summary = sim.summary(warm);
      const invalidReasons = invalidRunReasons(sim.st.counters, interventions, cfg.sim.diagnosticRecovery);
      result.runs.push({ seed, summary, series: structuredClone(sim.series), interventions, invalidReasons, status: invalidReasons.length ? 'invalid' : 'complete' });
      progress(result.runs.length);
    } finally { sim.dispose(); }
  }
  return result;
}
export function compareExperiments(a: ExperimentResult, b: ExperimentResult, metric: keyof Summary): ComparisonResult {
  if (a.engineVersion !== b.engineVersion || a.spec.dt !== b.spec.dt || a.spec.horizon !== b.spec.horizon || a.spec.warmup !== b.spec.warmup || JSON.stringify(a.spec.seeds) !== JSON.stringify(b.spec.seeds)) throw new Error('Для парного сравнения нужны одинаковые версии, шаг, окно и зёрна.');
  const demand = (r: ExperimentResult) => JSON.stringify([r.spec.cfg.spawners, r.spec.cfg.peds.sources, r.spec.cfg.transit]);
  if (demand(a) !== demand(b)) throw new Error('Различается входной спрос или маршруты: парное сравнение не выполняется.');
  if (a.runs.length !== a.spec.seeds.length || b.runs.length !== b.spec.seeds.length || [...a.runs, ...b.runs].some(r => r.status !== 'complete' || r.interventions > 0 || !!r.invalidReasons?.length || r.summary.errors > 0 || r.summary.collisions > 0 || r.summary.pedHits > 0 || r.summary.deadlocks > 0)) throw new Error('Нужны завершённые прогоны без вмешательств.');
  const differences = a.runs.map((r, i) => b.runs[i].summary[metric] - r.summary[metric]);
  if (differences.some(x => !Number.isFinite(x))) throw new Error('Показатель сравнения должен быть конечным числом.');
  const n = differences.length, mean = differences.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? differences.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const t = [0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228];
  const critical = n <= 11 ? t[n - 1] : n <= 21 ? 2.228 : n <= 31 ? 2.086 : 2.042;
  return { metric, differences, mean, ci95: n > 1 ? critical * Math.sqrt(variance / n) : null };
}

/** Результаты загружаются как данные, без запуска вложенной модели. */
export function parseExperiment(input: unknown): ExperimentResult {
  if (!input || typeof input !== 'object') throw new Error('Ожидается результат эксперимента.');
  const r = input as ExperimentResult;
  if (r.format !== 'crossroad-experiment' || r.version !== 1 || typeof r.engineVersion !== 'string' || !r.spec || !Array.isArray(r.runs)) throw new Error('Неизвестный формат результата.');
  validateExperiment(r.spec);
  r.spec.cfg = normalizeModel(r.spec.cfg);
  if (r.runs.length !== r.spec.seeds.length) throw new Error('Неполный набор повторов.');
  const keys: Array<keyof Summary> = ['horizon', 'crossed', 'throughputVph', 'avgWait', 'avgDelay', 'worstWait', 'maxQueue', 'dangers', 'collisions', 'errors', 'crossings', 'unserved', 'pedDone', 'pedAvgWait', 'pedDangers', 'pedHits', 'missedTurns', 'violations', 'deadlocks', 'busServed'];
  for (let i = 0; i < r.runs.length; i++) {
    const run = r.runs[i];
    if (run.seed !== r.spec.seeds[i] || !['complete', 'invalid'].includes(run.status) || !Number.isInteger(run.interventions) || run.interventions < 0 || !run.summary || keys.some(k => !Number.isFinite(run.summary[k]) || run.summary[k] < 0)) throw new Error('Повреждённые показатели повтора.');
    if (run.invalidReasons !== undefined && (!Array.isArray(run.invalidReasons) || run.invalidReasons.some(x => typeof x !== 'string'))) throw new Error('Повреждённые причины непригодности.');
    if ((run.interventions || run.invalidReasons?.length || run.summary.errors || run.summary.collisions || run.summary.pedHits || run.summary.deadlocks) && run.status !== 'invalid') throw new Error('Прогон с вмешательствами не может считаться пригодным.');
    if (!run.series || !Array.isArray(run.series.t) || run.series.t.length > 100000 || !Array.isArray(run.series.avgWait) || run.series.avgWait.length !== run.series.t.length) throw new Error('Повреждённые временные ряды.');
    if (run.series.t.some((t, j, a) => !Number.isFinite(t) || (j > 0 && t <= a[j - 1]))) throw new Error('Некорректное время ряда.');
    run.series.avgWait = run.series.avgWait.map(v => v === null ? NaN : Number.isFinite(v) ? v : NaN);
  }
  return r;
}
