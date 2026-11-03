import type { InteractiveCommand, InteractiveFrame } from '../engine/interactiveRuntime';
import type { ModelConfig } from '../engine/types';

interface ReportClient {
  request(command: InteractiveCommand, details?: boolean): Promise<InteractiveFrame | null>;
  dispose(): void;
}
export interface ReportRunOptions {
  unit: 'seconds' | 'steps';
  amount: number;
  signal?: AbortSignal;
}
export function reportAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Экспорт отменён.', 'AbortError');
}
/** Ограниченные кванты и один запрос за раз; полный ряд передаётся только в конце. */
export async function runReport(client: ReportClient, cfg: ModelConfig, options: ReportRunOptions): Promise<InteractiveFrame> {
  const cancel = () => client.dispose();
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    reportAbort(options.signal);
    if (!Number.isFinite(options.amount) || options.amount < 1 || options.amount > (options.unit === 'seconds' ? 86400 : 1000)
      || (options.unit === 'steps' && !Number.isInteger(options.amount))) throw new Error('Для отчёта допустимы 1–86400 секунд или 1–1000 переключений.');
    await client.request({ type: 'init', cfg });
    const count = options.unit === 'steps' ? options.amount : 1;
    for (let i = 0; i < count; i++) {
      let frame: InteractiveFrame | null;
      do {
        reportAbort(options.signal);
        frame = await client.request(options.unit === 'seconds' ? { type: 'advance', target: options.amount } : { type: 'nextPhase' });
        if (!frame) throw new Error('Не получено состояние отчёта.');
        if (frame.state.t > 86400) throw new Error('Прогон отчёта превышает 24 часа модели.');
      } while (!frame.complete);
    }
    reportAbort(options.signal);
    const result = await client.request({ type: 'snapshot' }, true);
    reportAbort(options.signal);
    if (!result?.details) throw new Error('Не получены показатели отчёта.');
    return result;
  } catch (error) {
    reportAbort(options.signal);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    client.dispose();
  }
}
