// Долгие прогоны всех предустановок и шаблонов с разными зёрнами: npm run test:stall [-- секунд зёрен]
// Ищем остановки движения, которые не объясняются столкновениями в модели: машина или автобус
// стоят дольше LIMIT секунд, весь перекрёсток без проезда дольше LIMIT, автобус не может выехать с остановки.
// Код возврата 1, если что-то нашлось.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { defaultModel, PRESETS, TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation } from '../src/engine/sim';
import { ENGINE_VERSION } from '../src/engine/version';
import { invalidRunReasons } from '../src/engine/runValidity';
import type { ModelConfig } from '../src/engine/types';

const horizon = Number(process.argv[2] ?? 7200);
const seeds = Number(process.argv[3] ?? 2);
const only = process.argv[4];
const seedBase = Number(process.argv[5] ?? 42);
const output = process.argv[6];
if (!Number.isSafeInteger(seedBase)) throw new Error('Начальное зерно должно быть целым безопасным числом.');
const strict = process.env.STRICT === '1';
if (!Number.isInteger(horizon) || horizon < 10 || !Number.isInteger(seeds) || seeds < 1) throw new Error('Нужны положительные целые горизонт (не меньше 10 с) и число зёрен.');
console.log(`Движок ${ENGINE_VERSION}; строгая проверка ${strict}; горизонт ${horizon} с; зёрен ${seeds}; начало ${new Date().toISOString()}`);
const LIMIT = 300;
/** После окончания аварии очередь рассасывается не сразу */
const AFTER_CRASH = 240;

interface Finding { label: string; seed: number; t: number; what: string }
const engineDir = new URL('../src/engine/', import.meta.url);
const hash = createHash('sha256');
for (const file of readdirSync(engineDir).filter(f => f.endsWith('.ts')).sort()) hash.update(file).update(readFileSync(new URL(file, engineDir)));
const report = {
  format: 'crossroad-stall', version: 1, engineVersion: ENGINE_VERSION, engineHash: hash.digest('hex'),
  verifierHash: createHash('sha256').update(readFileSync(new URL('./stall-test.ts', import.meta.url))).digest('hex'),
  started: new Date().toISOString(), horizon, strict, limitSeconds: LIMIT,
  seeds: Array.from({ length: seeds }, (_, i) => seedBase + i * 1000),
  runs: [] as Array<{ label: string; seed: number; t: number; counters?: Simulation['st']['counters']; findings: Finding[] }>,
  completed: false, passed: false,
};
const saveReport = () => { if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); };

function run(label: string, base: ModelConfig, seed: number): Finding[] {
  const cfg = structuredClone(base);
  cfg.sim.seed = seed;
  if (strict) { cfg.sim.mode = 'strict'; cfg.sim.diagnosticRecovery = false; }
  const { code, errors } = compileModel(cfg);
  if (errors.length) throw new Error(errors.join('\n'));
  const sim = new Simulation(cfg, code, { headless: true });
  try {
  const out: Finding[] = [];
  const seen = new Set<string>();
  let crashUntil = -1;
  // последнее заметное продвижение каждой машины: медленная очередь продвигается, а застрявшая машина нет
  const moved = new Map<number, { phase: string; s: number; t: number }>();
  for (let checkpoint = 10; checkpoint < horizon + 10; checkpoint += 10) {
    const t = Math.min(checkpoint, horizon);
    sim.runUntil(t);
    const st = sim.st;
    if (st.vehicles.some((v) => v.crashed) || st.peds.some((p) => p.hit)) crashUntil = t + AFTER_CRASH;
    for (const v of st.vehicles) {
      const m = moved.get(v.id);
      if (!m || m.phase !== v.phase || Math.abs(v.s - m.s) > 1 || v.crashed || (v.dwellUntil >= 0 && t < v.dwellUntil)) moved.set(v.id, { phase: v.phase, s: v.s, t });
    }
    if (moved.size > st.vehicles.length * 2 + 100) {
      const alive = new Set(st.vehicles.map((v) => v.id));
      for (const k of moved.keys()) if (!alive.has(k)) moved.delete(k);
    }
    if (!strict && t < crashUntil) { for (const v of st.vehicles) moved.set(v.id, { phase: v.phase, s: v.s, t }); continue; }
    const add = (key: string, what: string) => {
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ label, seed, t, what });
    };
    for (const v of st.vehicles) {
      const m = moved.get(v.id);
      if (!m || t - m.t < LIMIT) continue;
      if (process.env.CHAIN && !out.length) {
        // цепочка ожидания от первой найденной машины
        let cur: typeof v | undefined = v;
        const chain: string[] = [];
        const ids = new Set<number>();
        while (cur && !ids.has(cur.id) && chain.length < 40) {
          ids.add(cur.id);
          chain.push(`#${cur.id} ${cur.kind} ${cur.phase} ${cur.origin}${cur.lane}→${cur.dest}${cur.outLane} conn${cur.conn} s${cur.s.toFixed(1)} v${cur.v.toFixed(1)} ${cur.why}${cur.whyId}${cur.why === 'yield' ? ' yTo' + cur.yieldTo : ''}${cur.dwellUntil >= 0 ? ' dwell' : ''}${cur.inBay ? ' bay' : ''}`);
          const nextId: number = cur.why === 'yield' ? cur.yieldTo : cur.whyId;
          cur = st.vehicles.find((x) => x.id === nextId);
        }
        console.log('  цепочка:\n    ' + chain.join('\n    '));
      }
      add(`v${v.id}`, `#${v.id} ${v.kind} ${v.origin}→${v.dest} ${v.phase} не продвигается ${(t - (moved.get(v.id)?.t ?? t)).toFixed(0)} с, причина ${v.why}${v.whyId >= 0 ? ' #' + v.whyId : ''}`);
    }
    for (const x of st.status.stall) if (x.key === 'all' && t - x.since > LIMIT) add('all' + Math.floor(x.since), `весь перекрёсток без проезда ${(t - x.since).toFixed(0)} с`);
  }
  const lc = sim.logCounts;
  if (strict) {
    for (const reason of invalidRunReasons(sim.st.counters, lc['deadlock-manual'] ?? 0, cfg.sim.diagnosticRecovery)) out.push({ label, seed, t: sim.st.t, what: reason });
  }
  console.log(`${label.padEnd(22)} зерно ${String(seed).padStart(3)} | ${st(sim)} | блок ${lc.deadlock ?? 0} затор ${lc.gridlock ?? 0} столкн ${lc.crash ?? 0} наезд ${lc['ped-hit'] ?? 0} | находок ${out.length}`);
  report.runs.push({ label, seed, t: sim.st.t, counters: structuredClone(sim.st.counters), findings: out });
  return out;
  } finally { sim.dispose(); }
}
const st = (sim: Simulation) => `проехало ${sim.st.counters.crossedStop}, в модели ${sim.st.vehicles.length}`;

const cases: Array<[string, () => ModelConfig]> = [
  ...PRESETS.map((p) => [p.id, () => defaultModel(p.id)] as [string, () => ModelConfig]),
  ...TEMPLATES.filter(t => t.id !== 'kolpino' && !PRESETS.some(p => p.id === t.id)).map((t) => ['шаблон ' + t.id, t.make] as [string, () => ModelConfig]),
];
const found: Finding[] = [];
const picked = cases.filter(([l]) => !only || l.includes(only));
if (!picked.length) throw new Error('Не найдено моделей для проверки.');
saveReport();
for (const [label, make] of picked) for (let k = 0; k < seeds; k++) {
  const seed = seedBase + k * 1000;
  try { found.push(...run(label, make(), seed)); }
  catch (error) {
    const failure = { label, seed, t: 0, what: error instanceof Error ? error.message : String(error) };
    found.push(failure);
    report.runs.push({ label, seed, t: 0, findings: [failure] });
  } finally { saveReport(); }
}
report.completed = true;
report.passed = found.length === 0;
saveReport();
if (found.length) {
  console.log('\nНАЙДЕНЫ ОСТАНОВКИ ДВИЖЕНИЯ:');
  for (const f of found.slice(0, 40)) console.log(`  ${f.label}, зерно ${f.seed}, t=${f.t}: ${f.what}`);
  process.exit(1);
}
console.log(`\nостановок движения без аварий нет: моделей ${picked.length}, зёрен ${seeds}, по ${horizon} с модели`);
