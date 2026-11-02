// Пул Web Worker'ов для параллельной оценки вариантов светофорной программы.
import OptWorker from '../engine/optWorker?worker&inline';
import type { EvalRequest, EvalResponse } from '../engine/evaluate';
import type { Summary } from '../engine/sim';

export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Array<{ req: EvalRequest; resolve: (s: Summary) => void; reject: (e: Error) => void }> = [];
  private pending = new Map<number, { resolve: (s: Summary) => void; reject: (e: Error) => void; w: Worker }>();
  private nextId = 1;

  /** wasm — байты песочницы, если в модели есть пользовательский код */
  constructor(n: number, wasm?: Uint8Array) {
    for (let i = 0; i < Math.max(1, n); i++) {
      const w = new OptWorker();
      if (wasm) w.postMessage({ type: 'sandbox', wasm: wasm.slice().buffer });
      w.onmessage = (e: MessageEvent<EvalResponse>) => {
        const p = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        this.idle.push(w);
        if (p) {
          if (e.data.summary) p.resolve(e.data.summary);
          else p.reject(new Error(e.data.error ?? 'ошибка оценки'));
        }
        this.pump();
      };
      w.onerror = (e) => {
        for (const [id, p] of this.pending) if (p.w === w) { p.reject(new Error(e.message)); this.pending.delete(id); }
        this.idle.push(w);
        this.pump();
      };
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  eval(req: Omit<EvalRequest, 'id'>): Promise<Summary> {
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
      w.postMessage(job.req);
    }
  }

  terminate() {
    for (const w of this.workers) w.terminate();
    for (const p of this.pending.values()) p.reject(new Error('остановлено'));
    for (const j of this.queue) j.reject(new Error('остановлено'));
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending.clear();
  }
}
