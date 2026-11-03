import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation } from '../src/engine/sim';
import { InteractiveRuntime, type InteractiveCommand, type InteractiveFrame } from '../src/engine/interactiveRuntime';
import { runReport } from '../src/ui/reportRun';

class Client {
  runtime = new InteractiveRuntime();
  disposed = false;
  pending = false;
  requests = 0;
  async request(command: InteractiveCommand, details = false): Promise<InteractiveFrame | null> {
    assert.equal(this.pending, false, 'Report must never queue concurrent commands');
    this.pending = true; this.requests++;
    try {
      await new Promise(resolve => setImmediate(resolve));
      if (this.disposed) throw new Error('disposed');
      return structuredClone(this.runtime.execute(command, details, .1));
    } finally { this.pending = false; }
  }
  dispose() { this.disposed = true; this.runtime.execute({ type: 'dispose' }); }
}
const cfg = defaultModel('v1');
for (const unit of ['seconds', 'steps'] as const) {
  const client = new Client();
  const amount = unit === 'seconds' ? 90 : 5;
  const result = await runReport(client, cfg, { unit, amount });
  const direct = new Simulation(cfg, compileModel(cfg).code);
  try {
    if (unit === 'seconds') direct.runUntil(amount);
    else for (let i = 0; i < amount; i++) direct.runToNextLampChange();
    assert.deepEqual(result.state, direct.st);
    assert.deepEqual(result.details?.series, direct.series);
    assert.ok(client.requests > 3, 'Long calculation must yield between bounded quanta');
    assert.ok(client.disposed);
  } finally { direct.dispose(); }
}
for (const amount of [NaN, Infinity, -1, 86401]) {
  const client = new Client();
  await assert.rejects(runReport(client, cfg, { unit: 'seconds', amount }));
  assert.equal(client.requests, 0); assert.ok(client.disposed);
}
const aborted = new AbortController(); aborted.abort();
const before = new Client();
await assert.rejects(runReport(before, cfg, { unit: 'seconds', amount: 90, signal: aborted.signal }), { name: 'AbortError' });
assert.equal(before.requests, 0); assert.ok(before.disposed);
const during = new AbortController(), client = new Client();
const running = runReport(client, cfg, { unit: 'seconds', amount: 86400, signal: during.signal });
setImmediate(() => during.abort());
await assert.rejects(running, { name: 'AbortError' }); assert.ok(client.disposed);
console.log('Report run: exact seconds/signal transitions, bounded requests, validation and cancellation.');
