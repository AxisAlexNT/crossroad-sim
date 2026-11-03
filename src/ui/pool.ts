// Пул Web Worker'ов для параллельной оценки вариантов светофорной программы.
import { createCalculationWorker } from './calculationWorker';
import type { EvalRequest, EvalResponse, EvaluationOutcome } from '../engine/evaluate';

export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Array<{ req: EvalRequest; resolve: (s: EvaluationOutcome) => void; reject: (e: Error) => void }> = [];
  private pending = new Map<number, { resolve: (s: EvaluationOutcome) => void; reject: (e: Error) => void; w: Worker }>();
  private nextId = 1;
  private closed = false;

  /** wasm — байты песочницы, если в модели есть пользовательский код */
  constructor(n: number, wasm?: Uint8Array) {
    try {
    for (let i = 0; i < (Number.isFinite(n) ? Math.max(1, Math.min(8, Math.floor(n))) : 1); i++) {
      const w = createCalculationWorker('optimization');
      this.workers.push(w);
      w.onmessage = (e: MessageEvent<EvalResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p || p.w !== w) return;
        this.pending.delete(e.data.id);
        this.idle.push(w);
        if (p) {
          if (e.data.summary) p.resolve(e.data.summary);
          else if (e.data.invalid) p.resolve({ invalid: e.data.invalid });
          else p.reject(new Error(e.data.error ?? 'ошибка оценки'));
        }
        this.pump();
      };
      w.onerror = e => this.terminate(new Error(e.message || 'Ошибка расчёта.'));
      w.onmessageerror = () => this.terminate(new Error('Не удалось прочитать результат расчёта.'));
      if (wasm) w.postMessage({ type: 'sandbox', wasm: wasm.slice().buffer });
      this.idle.push(w);
    }
    } catch (error) {
      this.terminate(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  eval(req: Omit<EvalRequest, 'id'>): Promise<EvaluationOutcome> {
    if (this.closed) return Promise.reject(new Error('Расчёт остановлен.'));
    if (this.queue.length >= 512) return Promise.reject(new Error('Слишком много ожидающих расчётов.'));
    return new Promise((resolve, reject) => {
      this.queue.push({ req: { ...req, id: this.nextId++ }, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.pending.set(job.req.id, { resolve: job.resolve, reject: job.reject, w });
      try { w.postMessage(job.req); }
      catch (error) { this.terminate(error instanceof Error ? error : new Error(String(error))); return; }
    }
  }

  terminate(error = new Error('остановлено')) {
    this.closed = true;
    for (const w of this.workers) w.terminate();
    for (const p of this.pending.values()) p.reject(error);
    for (const j of this.queue) j.reject(error);
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending.clear();
  }
}
