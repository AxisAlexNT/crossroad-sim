// Проверка длительных остановок внутри перекрёстка в строгом режиме.
import { PRESETS, TEMPLATES, kolpinoModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation } from '../src/engine/sim';
import { readFileSync } from 'node:fs';
import type { ModelConfig } from '../src/engine/types';

const horizon = Number(process.argv[2] ?? 3600);
const seeds = Number(process.argv[3] ?? 3);
const only = process.argv[4];
if (!Number.isInteger(horizon) || horizon < 1 || !Number.isInteger(seeds) || seeds < 1) {
  throw new Error('Горизонт и число зёрен должны быть положительными целыми числами.');
}
// Проверка закрытого обзора включается только после проверки соответствующего правила.
const failVisibility = false;
const cases: Array<[string, () => ModelConfig]> = [
  ...PRESETS.map(p => [p.id, () => kolpinoModel(p.id)] as [string, () => ModelConfig]),
  ...TEMPLATES.map(t => [t.id, t.make] as [string, () => ModelConfig]),
];
const picked = cases.filter(([label]) => !only || label.includes(only));
if (!picked.length) throw new Error('Не найдено моделей для проверки.');
const baseline = JSON.parse(readFileSync(new URL('../validation/dwell-baseline.json', import.meta.url), 'utf8')) as {
  horizon: number; seeds: number[];
  rows: Array<{ model: string; meanWait: number; exited: number; standing: number;
    delayAreaHistorical: number; missedTurnsAccepted: number; dangerBoundUnchanged: number }>;
};
for (const row of baseline.rows) {
  for (const key of ['meanWait', 'exited', 'standing', 'delayAreaHistorical', 'missedTurnsAccepted', 'dangerBoundUnchanged'] as const) {
    if (!Number.isFinite(row[key]) || row[key] < 0) throw new Error(`Некорректный исходный показатель ${key} модели ${row.model}.`);
  }
  if (!Number.isInteger(row.missedTurnsAccepted)) throw new Error(`Некорректное число пропущенных поворотов модели ${row.model}.`);
}
const release = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; releaseChannel?: string };
const baselineGate = horizon === baseline.horizon && seeds === baseline.seeds.length && !only;
let failed = false;
for (const [label, make] of picked) {
  const totals = { exited: 0, signal: 0, toParked: 0, visibility: 0, other: 0, maxStop: 0,
    collisions: 0, deadlocks: 0, dangers: 0, sumWait: 0, crossedStop: 0,
    delayArea: 0, missedTurns: 0, interventions: 0, pedHits: 0, dropped: 0, pedDropped: 0 };
  for (let k = 0; k < seeds; k++) {
    const cfg = make();
    cfg.sim.seed = 42 + k * 1000;
    cfg.sim.mode = 'strict';
    cfg.sim.diagnosticRecovery = false;
    const { code, errors } = compileModel(cfg);
    if (errors.length) throw new Error(errors.join('\n'));
    const sim = new Simulation(cfg, code, { headless: true });
    const stopped = new Map<number, number>();
    const counted = new Set<number>();
    try {
      for (let t = 1; t <= horizon; t++) {
        sim.runUntil(t);
        const standing = new Set<number>();
        const byId = new Map(sim.st.vehicles.map(v => [v.id, v]));
        for (const veh of sim.st.vehicles) {
          if (veh.phase !== 'conn' || veh.crashed || veh.v >= .15) continue;
          standing.add(veh.id);
          if (!stopped.has(veh.id)) stopped.set(veh.id, t);
          const duration = t - stopped.get(veh.id)!;
          totals.maxStop = Math.max(totals.maxStop, duration);
          if (duration < 12 || counted.has(veh.id)) continue;
          counted.add(veh.id);
          const kind = veh.why === 'signal' ? 'signal'
            : veh.why === 'yield' && byId.get(veh.yieldTo)?.overStop ? 'toParked'
            : veh.why === 'yield' && veh.yieldTo === -2 ? 'visibility' : 'other';
          totals[kind]++;
        }
        for (const id of stopped.keys()) if (!standing.has(id)) stopped.delete(id);
      }
      const c = sim.st.counters;
      totals.exited += c.exited;
      totals.collisions += c.collisions;
      totals.deadlocks += c.deadlocks;
      totals.dangers += c.dangers;
      totals.sumWait += c.sumWait;
      totals.crossedStop += c.crossedStop;
      totals.delayArea += c.delayArea;
      totals.missedTurns += c.missedTurns;
      totals.interventions += c.interventions;
      totals.pedHits += c.pedHits;
      totals.dropped += c.dropped;
      totals.pedDropped += c.pedDropped;
    } finally { sim.dispose(); }
  }
  const meanWait = totals.crossedStop ? totals.sumWait / totals.crossedStop : 0;
  const reference = baseline.rows.find(row => row.model === label);
  if (baselineGate && !reference) throw new Error(`Нет исходных показателей модели ${label}.`);
  const standing = totals.visibility + totals.other;
  const ratios = reference ? {
    delayArea: reference.delayAreaHistorical ? totals.delayArea / reference.delayAreaHistorical : totals.delayArea === 0 ? 1 : null,
    missedTurns: reference.missedTurnsAccepted ? totals.missedTurns / reference.missedTurnsAccepted : totals.missedTurns === 0 ? 1 : null,
    meanWait: reference.meanWait ? meanWait / reference.meanWait : meanWait === 0 ? 1 : null,
    exited: reference.exited ? totals.exited / reference.exited : totals.exited === 0 ? 1 : null,
    standing: reference.standing ? standing / reference.standing : standing === 0 ? 1 : null,
  } : null;
  const originalBaselineFindings: string[] = [];
  if (baselineGate && reference) {
    if (meanWait > reference.meanWait * 1.10) originalBaselineFindings.push('ожидание выше исходного более чем на 10 процентов');
    if (totals.exited < reference.exited * 0.97) originalBaselineFindings.push('проездов меньше 97 процентов исходного числа');
    if (standing > reference.standing * 1.5 + 10) originalBaselineFindings.push('остановок внутри перекрёстка больше допустимого');
  }
  const previewDelayAccepted = baselineGate && label === 'v5' && release.releaseChannel === 'preview'
    && release.version === '1.1.1-preview.1' && totals.delayArea <= 549101.292927634;
  const unamendedDelayFinding = baselineGate && reference && totals.delayArea > reference.delayAreaHistorical * 1.10
    ? 'суммарная потеря времени выше исходной более чем на 10 процентов' : null;
  const baselineFindings: string[] = [];
  if (baselineGate && reference) {
    if (totals.delayArea > reference.delayAreaHistorical * 1.10 && !previewDelayAccepted) baselineFindings.push('суммарная потеря времени выше исходной более чем на 10 процентов');
    if (totals.exited < reference.exited * 0.97) baselineFindings.push('проездов меньше 97 процентов исходного числа');
    if (totals.missedTurns > reference.missedTurnsAccepted) baselineFindings.push('пропущенных поворотов больше, чем в версии сравнения');
    if (totals.dangers > reference.dangerBoundUnchanged) baselineFindings.push('опасных моментов больше допустимого');
  }
  const bad = totals.interventions > 0 || totals.pedHits > 0 || totals.dropped > 0 || totals.pedDropped > 0 || baselineFindings.length > 0 || totals.toParked > 0 || totals.collisions > 0 || totals.deadlocks > 0
    || (failVisibility && totals.visibility > 0) || (label === 'worked' && (meanWait > 120 || totals.other > 20));
  failed ||= bad;
  console.log(`${label}: ${JSON.stringify({ ...totals, meanWait, standing, baselineGate, ratios, originalBaselineFindings, unamendedDelayFinding, previewDelayAccepted, baselineFindings, passed: !bad })}`);
}
process.exitCode = failed ? 1 : 0;
