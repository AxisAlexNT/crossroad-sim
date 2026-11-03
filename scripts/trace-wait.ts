// Причинная трассировка ожидания: модель, зерно, id машины, начало, конец, файл JSON.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { defaultModel, PRESETS, TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import { ENGINE_VERSION } from '../src/engine/version';

const [label, seedArg, idArg, fromArg, toArg, output] = process.argv.slice(2);
const seed = Number(seedArg), id = Number(idArg), from = Number(fromArg), to = Number(toArg);
if (!label || !output || ![seed, id, from, to].every(Number.isSafeInteger) || id < 0 || from < 0 || to <= from) {
  throw new Error('Нужны модель, целое зерно, id машины, начало ≥ 0, конец > начала и путь JSON.');
}
const cfg = PRESETS.some(p => p.id === label) ? defaultModel(label) : TEMPLATES.find(t => t.id === label)?.make();
if (!cfg) throw new Error('Неизвестная модель.');
cfg.sim.seed = seed;
const { code, errors } = compileModel(cfg);
if (errors.length) throw new Error(errors.join('\n'));
const engineDir = new URL('../src/engine/', import.meta.url), hash = createHash('sha256');
for (const file of readdirSync(engineDir).filter(f => f.endsWith('.ts')).sort()) hash.update(file).update(readFileSync(new URL(file, engineDir)));
const sim = new Simulation(cfg, code, { headless: true });
const describe = (v: Vehicle) => ({
  id: v.id, kind: v.kind, phase: v.phase, origin: v.origin, destination: v.dest, lane: v.lane,
  outLane: v.outLane, conn: v.conn, s: v.s, speed: v.v, why: v.why, whyId: v.whyId, yieldTo: v.yieldTo,
  permit: sim.permit[v.conn], dwellUntil: v.dwellUntil, nextStop: v.stopsLeft[0] ?? null,
  inBay: v.inBay, committed: [...v.committed],
});
const checkpoints = [];
try {
  for (let t = from; ; t = Math.min(to, t + 10)) {
    sim.runUntil(t);
    const chain = [], seen = new Set<number>();
    let v = sim.st.vehicles.find(v => v.id === id);
    while (v && !seen.has(v.id)) {
      seen.add(v.id); chain.push(describe(v));
      const blocker = v.why === 'yield' ? v.yieldTo : ['leader', 'merge', 'exit', 'lc'].includes(v.why) ? v.whyId : -1;
      v = sim.st.vehicles.find(o => o.id === blocker);
    }
    const stops = new Set(chain.map(v => v.nextStop).filter(Boolean));
    checkpoints.push({
      t: sim.st.t, present: chain.length > 0, chain, cycleTo: v?.id ?? null,
      serving: sim.st.vehicles.filter(v => v.dwellUntil >= sim.st.t && stops.has(v.stopsLeft[0])).map(describe),
      crossedStop: sim.st.counters.crossedStop, exited: sim.st.counters.exited,
    });
    if (t === to) break;
  }
  writeFileSync(output, JSON.stringify({
    format: 'crossroad-wait-trace', version: 1, engineVersion: ENGINE_VERSION, engineHash: hash.digest('hex'),
    verifierHash: createHash('sha256').update(readFileSync(new URL('./trace-wait.ts', import.meta.url))).digest('hex'),
    model: label, seed, dt: cfg.sim.dt, vehicle: id, from, to, checkpointSeconds: 10,
    limitations: 'Checkpoint observations, not a complete event history. Absence alone does not prove successful exit. The diagnostic does not alter validity or strict acceptance thresholds.',
    checkpoints,
  }, null, 2) + '\n');
  console.log(`Трассировка ${label}, зерно ${seed}, машина ${id}: ${checkpoints.length} снимков.`);
} finally { sim.dispose(); }
