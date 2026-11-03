import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { InteractiveRuntime } from '../src/engine/interactiveRuntime';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation } from '../src/engine/sim';
import { ENGINE_VERSION } from '../src/engine/version';

// Измеряет копирование и приём снимков, не доставку Worker и не отрисовку браузера.
const cfg = defaultModel('v1');
const mode = process.argv[3] ?? 'baseline';
if (!['baseline', 'stress'].includes(mode)) throw new Error('Режим: baseline или stress.');
if (mode === 'stress') {
  for (const spawner of Object.values(cfg.spawners)) { spawner.params.rate = 10000; spawner.params.profile = []; }
  for (const source of cfg.peds.sources) source.rate = 20000;
}
const horizon = mode === 'stress' ? 900 : 1200;
const runtime = new InteractiveRuntime();
const mirror = new Simulation(cfg, compileModel(cfg).code);
const results = [];
try {
  runtime.execute({ type: 'init', cfg });
  while (!runtime.execute({ type: 'advance', target: horizon })!.complete) { /* bounded quanta */ }
  for (const details of [false, true]) {
    const frame = runtime.execute({ type: 'snapshot' }, details)!;
    const copy: number[] = [], accept: number[] = [];
    for (let i = 0; i < 120; i++) {
      const start = performance.now();
      const cloned = structuredClone(frame);
      const copied = performance.now();
      mirror.acceptFrame(cloned);
      const accepted = performance.now();
      if (i >= 20) { copy.push(copied - start); accept.push(accepted - copied); }
    }
    const stats = (a: number[]) => { a.sort((x, y) => x - y); return { medianMs: a[49], p95Ms: a[94], maxMs: a[99] }; };
    results.push({ details, time: frame.state.t, vehicles: frame.state.vehicles.length, pedestrianGroups: frame.state.peds.length,
      externalQueues: Object.fromEntries(Object.entries(frame.state.queue).map(([arm, queue]) => [arm, queue.length])),
      droppedVehicles: frame.state.counters.dropped, droppedPedestrians: frame.state.counters.pedDropped,
      jsonBytes: Buffer.byteLength(JSON.stringify(frame)), copy: stats(copy), accept: stats(accept) });
  }
  const report = { engineVersion: ENGINE_VERSION, mode, horizon,
    stressMeaning: mode === 'stress' ? 'Intentional overload at configured input-rate limits; dropped demand makes this a resource test, not a valid traffic experiment.' : null, node: process.version, cpu: cpus()[0]?.model, samples: 100,
    limitations: 'Local Node structuredClone and mirror indexing only; excludes Worker scheduling, browser rendering and mobile hardware. Concurrent validation workloads may affect timings.', results };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
} finally { runtime.execute({ type: 'dispose' }); mirror.dispose(); }
