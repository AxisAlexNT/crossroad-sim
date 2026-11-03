import { compileModel } from './compile';
import { Simulation, type SimState, type Series, type Samples, type LogEntry } from './sim';
import type { ModelConfig } from './types';

export type InteractiveCommand =
  | { type: 'init'; cfg: ModelConfig }
  | { type: 'advance'; target: number }
  | { type: 'nextPhase' }
  | { type: 'back'; seconds: number }
  | { type: 'previousPhase' }
  | { type: 'snapshot' }
  | { type: 'dispose' };

export interface InteractiveFrame {
  state: SimState;
  permit: Simulation['permit'];
  pedSignals: Array<ReturnType<Simulation['pedSignal']>>;
  complete: boolean;
  details?: {
    series: Series;
    samples: Samples;
    log: LogEntry[];
    logCounts: Simulation['logCounts'];
    levelCounts: Simulation['levelCounts'];
  };
}
export interface InteractiveRequest { id: number; command: InteractiveCommand; details?: boolean }
export type InteractiveReply = { id: number; frame: InteractiveFrame | null } | { id: number; error: string };

/** Единственный владелец изменяемой модели; один запрос выполняется за один ограниченный квант. */
export class InteractiveRuntime {
  private sim: Simulation | null = null;
  private phaseTarget: { signature: string; limit: number } | null = null;

  execute(command: InteractiveCommand, details = false, budgetMs = 8): InteractiveFrame | null {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 50) throw new Error('Недопустимый бюджет расчёта.');
    if (command.type === 'dispose') { this.sim?.dispose(); this.sim = null; this.phaseTarget = null; return null; }
    if (command.type === 'init') {
      const cfg = structuredClone(command.cfg);
      const compiled = compileModel(cfg);
      if (compiled.errors.length) throw new Error(compiled.errors.join('\n'));
      const next = new Simulation(cfg, compiled.code);
      this.sim?.dispose();
      this.sim = next;
      this.phaseTarget = null;
    }
    const sim = this.sim;
    if (!sim) throw new Error('Модель ещё не загружена.');
    let complete = true;
    if (command.type !== 'nextPhase' && command.type !== 'snapshot') this.phaseTarget = null;
    switch (command.type) {
      case 'advance':
        if (!Number.isFinite(command.target) || command.target < 0 || command.target > sim.st.t + 86400) throw new Error('Недопустимое целевое время.');
        complete = sim.runUntil(command.target, budgetMs);
        break;
      case 'nextPhase': {
        this.phaseTarget ??= { signature: sim.st.lampSig, limit: sim.st.t + 300 };
        const start = performance.now();
        while (sim.st.t < this.phaseTarget.limit && sim.st.lampSig === this.phaseTarget.signature) {
          sim.step();
          if (performance.now() - start >= budgetMs) break;
        }
        complete = sim.st.t >= this.phaseTarget.limit || sim.st.lampSig !== this.phaseTarget.signature;
        if (complete) this.phaseTarget = null;
        break;
      }
      case 'back':
        if (!Number.isFinite(command.seconds) || command.seconds < 0) throw new Error('Недопустимое время перемотки.');
        complete = sim.back(command.seconds);
        break;
      case 'previousPhase': complete = sim.backToPrevLampChange(); break;
    }
    // postMessage копирует снимок; возвращаем только данные, без функций и движка.
    return {
      state: sim.st, permit: sim.permit,
      pedSignals: sim.net.pedEdges.map((_, i) => sim.pedSignal(i)), complete,
      ...(details || command.type === 'init' || command.type === 'back' || command.type === 'previousPhase' ? {
        details: { series: sim.series, samples: sim.samples, log: sim.log, logCounts: sim.logCounts, levelCounts: sim.levelCounts },
      } : {}),
    };
  }
}
