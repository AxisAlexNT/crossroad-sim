// Оценка варианта светофорной программы: прогон симуляции и сводка метрик.
import { Simulation, type Summary } from './sim';
import type { CompiledCode, ModelConfig } from './types';

export interface EvalRequest {
  id: number;
  cfg: ModelConfig;
  code: CompiledCode;
  durations: number[];
  dt: number;
  warmup: number;
  horizon: number;
  seeds: number;
  /** зерно первого прогона, по умолчанию зерно модели. Остальные прогоны — с шагом 7919 */
  seedBase?: number;
}

export interface EvalResponse {
  id: number;
  summary?: Summary;
  error?: string;
}

export function evaluate(req: EvalRequest): Summary {
  const runs: Summary[] = [];
  for (let k = 0; k < Math.max(1, req.seeds); k++) {
    const cfg: ModelConfig = structuredClone(req.cfg);
    cfg.signals.phases.forEach((p, i) => { p.duration = Math.max(1, Math.round(req.durations[i] ?? p.duration)); });
    // одни и те же зёрна для всех вариантов: потоки машин и пешеходов у них общие, сравниваются только программы
    cfg.sim.seed = (req.seedBase ?? req.cfg.sim.seed) + k * 7919;
    const sim = new Simulation(cfg, req.code, { headless: true, dt: req.dt });
    sim.runUntil(req.warmup);
    const warm = { counters: structuredClone(sim.st.counters), t: sim.st.t };
    sim.st.maxQueue = 0;
    sim.runUntil(req.warmup + req.horizon);
    runs.push(sim.summary(warm));
    sim.dispose();
  }
  const avg = { ...runs[0] };
  for (const key of Object.keys(avg) as Array<keyof Summary>) {
    avg[key] = runs.reduce((a, r) => a + (r[key] as number), 0) / runs.length;
  }
  return avg;
}

