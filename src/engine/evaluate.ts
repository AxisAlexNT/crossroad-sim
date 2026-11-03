// Оценка варианта светофорной программы: прогон симуляции и сводка метрик.
import { Simulation, type Summary } from './sim';
import { invalidRunReasons } from './runValidity';
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
  invalid?: InvalidEvaluation;
}

export interface InvalidEvaluation { seed: number; durations: number[]; reasons: string[]; summary: Summary }
export type EvaluationOutcome = Summary | { invalid: InvalidEvaluation };
export class InvalidRunError extends Error {
  constructor(readonly detail: InvalidEvaluation) {
    super(`Непригодный прогон, зерно ${detail.seed}, фазы ${detail.durations.join(' / ')}: ${detail.reasons.join(', ')}.`);
  }
}

/** Отказ модели — результат кандидата; ошибки исполнения остаются исключениями. */
export function evaluateCandidate(req: EvalRequest): EvaluationOutcome {
  try { return evaluate(req); }
  catch (error) { if (error instanceof InvalidRunError) return { invalid: error.detail }; throw error; }
}

export function evaluate(req: EvalRequest): Summary {
  if (req.cfg.sim.diagnosticRecovery) throw new Error('Отключите диагностический разъезд перед подбором фаз.');
  const runs: Summary[] = [];
  for (let k = 0; k < Math.max(1, req.seeds); k++) {
    const cfg: ModelConfig = structuredClone(req.cfg);
    cfg.signals.phases.forEach((p, i) => { p.duration = Math.max(1, Math.round(req.durations[i] ?? p.duration)); });
    // одни и те же зёрна для всех вариантов: потоки машин и пешеходов у них общие, сравниваются только программы
    cfg.sim.seed = (req.seedBase ?? req.cfg.sim.seed) + k * 7919;
    const sim = new Simulation(cfg, req.code, { headless: true, dt: req.dt });
    try {
      sim.runUntil(req.warmup);
      const warm = { counters: structuredClone(sim.st.counters), t: sim.st.t };
      sim.st.maxQueue = 0;
      sim.runUntil(req.warmup + req.horizon);
      const reasons = invalidRunReasons(sim.st.counters, sim.logCounts['deadlock-manual'] ?? 0);
      if (reasons.length) throw new InvalidRunError({ seed: cfg.sim.seed, durations: cfg.signals.phases.map(p => p.duration), reasons, summary: sim.summary(warm) });
      runs.push(sim.summary(warm));
    } finally { sim.dispose(); }
  }
  const avg = { ...runs[0] };
  for (const key of Object.keys(avg) as Array<keyof Summary>) {
    avg[key] = runs.reduce((a, r) => a + (r[key] as number), 0) / runs.length;
  }
  return avg;
}

