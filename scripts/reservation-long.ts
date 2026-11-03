import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation } from '../src/engine/sim';

// Приоритетный участник сохраняет резерв, остановившись перед конфликтной зоной.
// Ранее встречный поток получал второй резерв, и на 5517 с возникало столкновение.
for (const seed of [42, 1042, 2042, 4042, 6042, 7042, 9042]) {
  const cfg = defaultModel('v1'); cfg.sim.seed = seed; cfg.sim.dt = .1;
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
  try {
    sim.runUntil(7200);
    const c = sim.st.counters;
    console.log(JSON.stringify({ seed, t: sim.st.t, exited: c.exited, collisions: c.collisions, deadlocks: c.deadlocks, interventions: sim.logCounts['deadlock-manual'] ?? 0 }));
    assert.equal(c.collisions, 0, `Столкновения, seed=${seed}`);
    assert.equal(c.deadlocks, 0, `Блокировки, seed=${seed}`);
    assert.equal(sim.logCounts['deadlock-manual'] ?? 0, 0, `Диагностические вмешательства, seed=${seed}`);
    assert.ok(c.exited > 2000, 'Отсутствие столкновений не должно достигаться остановкой выпуска');
  } finally { sim.dispose(); }
}
