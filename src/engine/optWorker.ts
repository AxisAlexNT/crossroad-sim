// Web Worker: прогоняет симуляцию с заданными длительностями фаз и возвращает метрики.
// Если в модели есть код, изменённый вручную, воркер сначала получает байты песочницы.
import '../polyfills';
import { evaluateCandidate, type EvalRequest, type EvalResponse } from './evaluate';
import { initSandbox } from './sandbox';

type Msg = EvalRequest | { type: 'sandbox'; wasm: ArrayBuffer };
export function installOptimizationWorker() {
const ctx = self as unknown as { onmessage: ((e: MessageEvent<Msg>) => void) | null; postMessage: (m: EvalResponse) => void };
let ready: Promise<unknown> = Promise.resolve();
ctx.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if ('type' in m) { ready = initSandbox(m.wasm); return; }
  void ready.then(() => {
    try {
      const result = evaluateCandidate(m);
      ctx.postMessage('invalid' in result ? { id: m.id, invalid: result.invalid } : { id: m.id, summary: result });
    } catch (err) {
      ctx.postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) });
    }
  }).catch(err => ctx.postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) }));
};

}
