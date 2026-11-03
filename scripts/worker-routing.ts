import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
const output: any[] = [];
const context = { onmessage: null as null | ((e: { data: any }) => unknown), postMessage: (value: unknown) => output.push(value) };
(globalThis as any).self = context;
await import('../src/engine/calculationWorker');
const start = context.onmessage!;
const send = async (data: unknown) => { await context.onmessage!({ data }); await new Promise(resolve => setTimeout(resolve, 0)); };
const cfg = defaultModel('v1');
for (let i = 0; i < 2; i++) {
  start({ data: { type: 'start-worker', mode: 'interactive' } });
  await send({ id: 1, command: { type: 'init', cfg } });
  assert.equal(output.pop().frame.state.t, 0, 'Новый обработчик получает отдельное состояние');
  await send({ id: 2, command: { type: 'advance', target: 1 } });
  assert.ok(output.pop().frame.state.t > 0);
  await send({ id: 3, command: { type: 'dispose' } });
  assert.equal(output.pop().frame, null);
}
start({ data: { type: 'start-worker', mode: 'optimization' } });
await send({ id: 4, cfg, code: compileModel(cfg).code, durations: cfg.signals.phases.map(p => p.duration), dt: .1, warmup: 0, horizon: 1, seeds: 1 });
assert.ok(output.pop().summary, 'Подбор возвращает сводку по прежнему протоколу');
start({ data: { type: 'start-worker', mode: 'experiment' } });
await send({ spec: { cfg, warmup: 0, horizon: 1, dt: .1, seeds: [42] } });
assert.ok(output.pop().result, 'Эксперимент возвращает результаты по прежнему протоколу');
assert.throws(() => start({ data: { type: 'start-worker', mode: 'unknown' } }));
console.log('Единый фоновый код: выбор обработчика, отдельное состояние и три протокола работают.');
