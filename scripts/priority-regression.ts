import assert from 'node:assert/strict';
import { defaultModel, TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation } from '../src/engine/sim';
import { invalidRunReasons } from '../src/engine/runValidity';

// Длительная стоянка приоритетного участника и возобновление движения
// после смены фазы. Начальные состояния задаются только публичными моделями.
const cases: Array<[string, number, number, number]> = [
  ['v2', 149042, .2, 1500], ['v2', 149042, .1, 1500],
  ['v5', 63042, .05, 1500], ['v5', 71042, .05, 1500], ['v5', 113042, .2, 1500],
  ['cross4', 61042, .05, 1500], ['tee', 133042, .2, 1500],
  ['skew', 59042, .2, 1500], ['skew', 59042, .1, 1500], ['skew', 108042, .1, 1500],
  ...[.2, .1, .05].map(dt => ['skew', 7042, dt, 7200] as [string, number, number, number]),
];
const failures: string[] = [];
for (const [label, seed, dt, horizon] of cases) {
  const cfg = TEMPLATES.find(t => t.id === label)?.make() ?? defaultModel(label);
  cfg.sim.seed = seed; cfg.sim.dt = dt;
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
  try {
    sim.runUntil(horizon);
    const invalid = invalidRunReasons(sim.st.counters, sim.logCounts['deadlock-manual'] ?? 0, cfg.sim.diagnosticRecovery);
    const tag = `${label}/${seed}, dt=${dt}`;
    if (invalid.length) failures.push(`${tag}: ${invalid.join(', ')}`);
    if (sim.st.counters.exited < 200) failures.push(`${tag}: выпуск остановлен`);
    console.log(JSON.stringify({ label, seed, dt, horizon, exited: sim.st.counters.exited, invalid }));
  } finally { sim.dispose(); }
}
assert.deepEqual(failures, [], 'Все воспроизведённые случаи должны завершаться без непригодных событий и остановки выпуска');
