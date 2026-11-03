import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { migrateSession } from '../src/engine/session';
import { compileModel } from '../src/engine/compile';
import { Simulation, type SimState } from '../src/engine/sim';
import { initSandbox } from '../src/engine/sandbox';
import { ENGINE_VERSION } from '../src/engine/version';

const fromStart = process.argv.includes('--from-start');
if (process.argv.slice(2).some(arg => arg !== '--from-start')) throw new Error('Поддерживается только параметр --from-start.');
const replay = JSON.parse(readFileSync(new URL('../validation/repro-interlocking-v106.replay.json', import.meta.url), 'utf8')) as {
  format: string; version: number; engineVersion: string; engineHash: string; session: string; recordedAt: number; state: SimState;
};
if (replay.format !== 'crossroad-debug-replay' || replay.version !== 1 || !Number.isFinite(replay.recordedAt) || replay.recordedAt < 0) throw new Error('Неверный формат снимка.');
const session = JSON.parse(readFileSync(new URL('../validation/repro-interlocking-v106.session.json', import.meta.url), 'utf8'));
const { cfg, report } = migrateSession(session);
if (report.warnings.length) throw new Error(report.warnings.join('\n'));
await initSandbox(new Uint8Array(readFileSync(new URL('../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm', import.meta.url))));
const compiled = compileModel(cfg);
if (compiled.errors.length) throw new Error(compiled.errors.join('\n'));
const hash = createHash('sha256');
const engineDir = new URL('../src/engine/', import.meta.url);
for (const file of readdirSync(engineDir).filter(name => name.endsWith('.ts')).sort()) hash.update(file).update(readFileSync(new URL(file, engineDir)));
const engineMatches = hash.digest('hex') === replay.engineHash;
if (!engineMatches) console.error('Правила движка отличаются от записанного снимка. Проверяется поведение текущей версии.');
const sim = new Simulation(cfg, compiled.code, { headless: true });
try {
  const ids = replay.state.status.deadlock?.vids ?? [];
  if (!fromStart) sim.restore(structuredClone(replay.state));
  const countersBefore = structuredClone(sim.st.counters);
  sim.runUntil(fromStart ? replay.recordedAt : replay.recordedAt + 30);
  const actors = ids.map(id => sim.st.vehicles.find(v => v.id === id));
  const activeIds = sim.st.status.deadlock?.vids ?? [];
  const reproduced = ids.length > 0 && ids.every((id, i) => {
    const current = actors[i], recorded = replay.state.vehicles.find(v => v.id === id);
    return current && recorded && activeIds.includes(id) && current.v < .3 && Math.abs(current.s - recorded.s) < 1e-6;
  });
  console.log(JSON.stringify({
    mode: fromStart ? 'from-start' : 'snapshot-plus-30s', engineVersion: ENGINE_VERSION,
    recordedEngineVersion: replay.engineVersion, engineMatches, t: sim.st.t, reproduced,
    activeDeadlock: sim.st.status.deadlock, countersBefore, countersAfter: sim.st.counters,
    actors: actors.filter(v => !!v).map(v => ({ id: v.id, movement: sim.net.conns[v.conn]?.conn.id, phase: v.phase,
      s: v.s, v: v.v, why: v.why, whyId: v.whyId, yieldTo: v.yieldTo })),
  }, null, 2));
} finally { sim.dispose(); }
