import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { evaluate, type EvaluationOutcome } from '../src/engine/evaluate';
import { Optimizer, defaultOptSettings, type OptProgress } from '../src/engine/optimizer';

const cfg = defaultModel('v1');
const { code } = compileModel(cfg);
const summary = evaluate({ id: 0, cfg, code, durations: cfg.signals.phases.map(p => p.duration), dt: .1, warmup: 0, horizon: 10, seeds: 1 });
const invalid = (x: number[]): EvaluationOutcome => ({ invalid: { seed: 123, durations: x, reasons: ['test collision'], summary: { ...summary, collisions: 1 } } });
async function run(mode: 'search' | 'reeval' | 'allreeval' | 'all' | 'transport' | 'incomplete') {
  const settings = { ...defaultOptSettings(cfg), maxCycle: 0, maxRed: 0, pedTime: false, population: 4, useWebster: false, reevalTop: 4, reevalSeeds: 3 };
  let progress: OptProgress | undefined;
  let failedKey = '';
  let calls = 0;
  const optimizer = new Optimizer(cfg, settings, async (xs, options) => {
    calls++;
    if (mode === 'transport') throw new Error('transport failed');
    if (mode === 'incomplete') return [];
    if (!failedKey) failedKey = xs[0].join(',');
    return xs.map(x => mode === 'all' || (mode === 'allreeval' && !!options) || (x.join(',') === failedKey && (mode === 'search' || !!options)) ? invalid(x) : { ...summary, avgWait: x[0] });
  }, p => { progress = p; if (p.stage === 'search' && !p.done) optimizer.stop(); });
  if (mode === 'transport' || mode === 'incomplete') {
    await assert.rejects(optimizer.run(), mode === 'transport' ? /transport failed/ : /неполный/);
    return;
  }
  const result = await optimizer.run();
  assert.ok(progress?.done);
  const rejected = progress.all.filter(c => c.invalid);
  assert.ok(rejected.length > 0);
  assert.ok(rejected.every(c => !c.summary && !c.final && c.invalid?.seed === 123));
  assert.ok(result.every(c => !c.invalid && c.final?.n === 3));
  assert.ok(optimizer.best().every(c => !c.invalid));
  if (mode === 'all') { assert.equal(result.length, 0); assert.equal(calls, 1); }
  else if (mode === 'allreeval') assert.equal(result.length, 0);
  else assert.ok(result.length > 0);
  if (mode === 'reeval') assert.ok(rejected.every(c => c.rejectedAt === 'reeval'));
}
for (const mode of ['search', 'reeval', 'allreeval', 'all', 'transport', 'incomplete'] as const) await run(mode);
console.log('Optimizer: invalid runs excluded; complete revalidation required; infrastructure errors propagated.');
