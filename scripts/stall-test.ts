// Долгие прогоны всех предустановок и шаблонов с разными зёрнами: npm run test:stall [-- секунд зёрен]
// Ищем остановки движения, которые не объясняются столкновениями в модели: машина или автобус
// стоят дольше LIMIT секунд, весь перекрёсток без проезда дольше LIMIT, автобус не может выехать с остановки.
// Код возврата 1, если что-то нашлось.
import { defaultModel, PRESETS, TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation } from '../src/engine/sim';
import type { ModelConfig } from '../src/engine/types';

const horizon = Number(process.argv[2] ?? 7200);
const seeds = Number(process.argv[3] ?? 2);
const only = process.argv[4];
const LIMIT = 300;
/** После окончания аварии очередь рассасывается не сразу */
const AFTER_CRASH = 240;

interface Finding { label: string; seed: number; t: number; what: string }

function run(label: string, base: ModelConfig, seed: number): Finding[] {
  const cfg = structuredClone(base);
  cfg.sim.seed = seed;
  const { code, errors } = compileModel(cfg);
  if (errors.length) throw new Error(errors.join('\n'));
  const sim = new Simulation(cfg, code, { headless: true });
  const out: Finding[] = [];
  const seen = new Set<string>();
  let crashUntil = -1;
  // последнее заметное продвижение каждой машины: медленная очередь продвигается, а застрявшая машина нет
  const moved = new Map<number, { phase: string; s: number; t: number }>();
  for (let t = 10; t <= horizon; t += 10) {
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
    if (t < crashUntil) { for (const v of st.vehicles) moved.set(v.id, { phase: v.phase, s: v.s, t }); continue; }
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
  console.log(`${label.padEnd(22)} зерно ${String(seed).padStart(3)} | ${st(sim)} | блок ${lc.deadlock ?? 0} затор ${lc.gridlock ?? 0} столкн ${lc.crash ?? 0} наезд ${lc['ped-hit'] ?? 0} | находок ${out.length}`);
  sim.dispose();
  return out;
}
const st = (sim: Simulation) => `проехало ${sim.st.counters.crossedStop}, в модели ${sim.st.vehicles.length}`;

const cases: Array<[string, () => ModelConfig]> = [
  ...PRESETS.map((p) => [p.id, () => defaultModel(p.id)] as [string, () => ModelConfig]),
  ...TEMPLATES.slice(1).map((t) => ['шаблон ' + t.id, t.make] as [string, () => ModelConfig]),
];
const found: Finding[] = [];
const picked = cases.filter(([l]) => !only || l.includes(only));
for (const [label, make] of picked) for (let k = 0; k < seeds; k++) found.push(...run(label, make(), 42 + k * 1000));
if (found.length) {
  console.log('\nНАЙДЕНЫ ОСТАНОВКИ ДВИЖЕНИЯ:');
  for (const f of found.slice(0, 40)) console.log(`  ${f.label}, зерно ${f.seed}, t=${f.t}: ${f.what}`);
  process.exit(1);
}
console.log(`\nостановок движения без аварий нет: моделей ${picked.length}, зёрен ${seeds}, по ${horizon} с модели`);
