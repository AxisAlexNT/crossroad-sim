import type { InteractiveCommand, InteractiveFrame, InteractiveReply } from '../engine/interactiveRuntime';

/** Обратное давление: следующий квант отправляется только после получения предыдущего. */
export class InteractiveChannel {
  private sequence = 0;
  private disposed = false;
  private pending: { timer: ReturnType<typeof setTimeout>; id: number; resolve: (frame: InteractiveFrame | null) => void; reject: (error: Error) => void } | null = null;

  constructor(private worker: Worker, private timeoutMs = 30_000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Недопустимое время ожидания фоновой модели.');
    this.worker.onmessage = (event: MessageEvent<InteractiveReply>) => {
      const message = event.data;
      const job = this.pending;
      if (this.disposed || !job || job.id !== message.id) return;
      clearTimeout(job.timer);
      this.pending = null;
      if ('error' in message) job.reject(new Error(message.error));
      else job.resolve(message.frame);
    };
    this.worker.onerror = event => this.fail(new Error(event.message || 'Ошибка фоновой модели.'));
    this.worker.onmessageerror = () => this.fail(new Error('Не удалось прочитать снимок фоновой модели.'));
  }

  get busy(): boolean { return this.pending !== null; }

  request(command: InteractiveCommand, details = false): Promise<InteractiveFrame | null> {
    if (this.disposed) return Promise.reject(new Error('Фоновая модель остановлена.'));
    if (this.pending) return Promise.reject(new Error('Предыдущий квант ещё не завершён.'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.fail(new Error('Фоновая модель не отвечает. Перезапустите расчёт.')), this.timeoutMs);
      this.pending = { id, resolve, reject, timer };
      try { this.worker.postMessage({ id, command, details }); }
      catch (error) { clearTimeout(timer); this.pending = null; reject(error); }
    });
  }

  dispose() { this.fail(new Error('Фоновая модель остановлена.')); }

  private fail(error: Error) {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); }
    this.pending = null;
  }
}
