// Обслуживание одной остановки: модель, зерно, id остановки, горизонт, выходной JSON.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { defaultModel, PRESETS } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation } from '../src/engine/sim';
import { ENGINE_VERSION } from '../src/engine/version';

const [label, seedArg, stopId, horizonArg, output] = process.argv.slice(2);
const seed = Number(seedArg), horizon = Number(horizonArg);
if (!PRESETS.some(p => p.id === label) || !Number.isSafeInteger(seed) || !Number.isInteger(horizon) || horizon < 1 || !output) {
  throw new Error('Нужны предустановка, целое зерно, остановка, положительный горизонт и выходной JSON.');
}
const cfg = defaultModel(label); cfg.sim.seed = seed;
const stop = cfg.transit.stops.find(s => s.id === stopId);
if (!stop) throw new Error('Остановка не найдена.');
const compiled = compileModel(cfg);
if (compiled.errors.length) throw new Error(compiled.errors.join('\n'));
const engineDir = new URL('../src/engine/', import.meta.url), hash = createHash('sha256');
for (const file of readdirSync(engineDir).filter(f => f.endsWith('.ts')).sort()) hash.update(file).update(readFileSync(new URL(file, engineDir)));
const sim = new Simulation(cfg, compiled.code, { headless: true });
const visits: Array<{ id: number; start: number; scheduledEnd: number; released: number | null; position: number; inBay: boolean }> = [];
const active = new Map<number, typeof visits[number]>();
try {
  while (sim.st.t < horizon) {
    sim.step();
    for (const v of sim.st.vehicles) {
      const visit = active.get(v.id);
      const serving = v.stopsLeft[0] === stopId && v.dwellUntil >= 0;
      if (visit && !serving) { visit.released = sim.st.t; active.delete(v.id); }
      if (!visit && serving) {
        const entry = { id: v.id, start: sim.st.t, scheduledEnd: v.dwellUntil, released: null, position: v.s, inBay: v.inBay };
        visits.push(entry); active.set(v.id, entry);
      }
    }
  }
  writeFileSync(output, JSON.stringify({
    format: 'crossroad-stop-trace', version: 1, engineVersion: ENGINE_VERSION, engineHash: hash.digest('hex'),
    verifierHash: createHash('sha256').update(readFileSync(new URL('./trace-stop.ts', import.meta.url))).digest('hex'),
    model: label, seed, dt: cfg.sim.dt, horizon, stop, dwellMin: cfg.transit.dwellMin, dwellMax: cfg.transit.dwellMax,
    limitations: 'Transitions observed after each integration step. Release means completion of stop service, not exit from the model. Null release includes service unfinished at the observation horizon.',
    visits,
  }, null, 2) + '\n');
  console.log(`Обслуживаний: ${visits.length}; незавершённых: ${active.size}.`);
} finally { sim.dispose(); }
