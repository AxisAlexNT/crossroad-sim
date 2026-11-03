// Узлы, работающие по параметрам, без пользовательского кода. Поведение совпадает с кодом,
// который генерирует codegen.ts: тот же порядок обращений к генераторам случайных чисел,
// поэтому прогон с одинаковым зерном даёт одинаковый результат.
// ctx.random — поток моментов появления машин, ctx.pick, ctx.pickWeighted и ctx.uniform — отдельный поток их свойств.
import type { ExitContext, ExitParams, LaneChooserParams, LaneContext, NewVehicle, SpawnContext, SpawnerParams, VehicleInfo } from './types';

export type SpawnFn = (ctx: SpawnContext) => NewVehicle[];
export type ChooseFn = (v: VehicleInfo, ctx: LaneContext) => number;
export type ExitFn = (ctx: ExitContext) => boolean;

export function nativeSpawn(p: SpawnerParams): SpawnFn {
  const dests: Record<string, number> = {};
  for (const [d, w] of Object.entries(p.destinations)) if ((w ?? 0) > 0) dests[d] = w;
  const types = p.types.filter((t) => t.share > 0);
  const profile = p.profile.slice();
  const rateAt = (t: number) => {
    let r = p.rate;
    for (const x of profile) if (t >= x.from) r = x.rate;
    return r;
  };
  const make = (ctx: SpawnContext): NewVehicle => {
    const type = ctx.pickWeighted(types.map((x) => [x, x.share] as [typeof x, number]));
    return { destination: ctx.pick(dests), kind: type.kind, length: ctx.uniform(type.lengthMin, type.lengthMax) };
  };
  return (ctx) => {
    if (!types.length || !Object.keys(dests).length) return [];
    const m = ctx.memory as { acc?: number; need?: number };
    const out: NewVehicle[] = [];
    const until = +ctx.t.toFixed(6);
    let from = +(until - ctx.dt).toFixed(6);
    while (from < until) {
      let to = until;
      for (const x of profile) if (x.from > from && x.from < to) to = x.from;
      const rate = rateAt(from);
      if (rate > 0) {
        if (p.arrival === 'poisson' && m.need === undefined) m.need = -Math.log(1 - ctx.random());
        m.acc = (m.acc ?? 0) + rate * (to - from) / 3600;
        const batch = p.arrival === 'platoon' ? Math.max(1, p.platoonSize) : 1;
        while (m.acc + 1e-12 >= (p.arrival === 'poisson' ? m.need! : batch)) {
          m.acc = Math.max(0, m.acc - (p.arrival === 'poisson' ? m.need! : batch));
          const at = +(to - m.acc * 3600 / rate).toFixed(6);
          if (p.arrival === 'poisson') m.need = -Math.log(1 - ctx.random());
          for (let i = 0; i < batch; i++) out.push({ ...make(ctx), at });
        }
      }
      from = to;
    }
    return out;
  };
}

export function nativeChooser(p: LaneChooserParams, laneCount: number): ChooseFn {
  const weights: Record<string, number[]> = {};
  for (const [d, ws] of Object.entries(p.weights)) weights[d] = (ws ?? []).slice(0, laneCount);
  return (v, ctx) => {
    const w = weights[v.destination] ?? [];
    const options: Array<[number, number]> = [];
    w.forEach((x, lane) => { if (x > 0) options.push([lane, x]); });
    if (!options.length) {
      const ok = ctx.lanes.filter((l) => l.reachable.includes(v.destination));
      return ok.length ? ok[0].index : 0;
    }
    if (p.strategy === 'shortestQueue') {
      options.sort((a, b) => (ctx.lanes[a[0]]?.queue ?? 0) - (ctx.lanes[b[0]]?.queue ?? 0) || b[1] - a[1]);
      return options[0][0];
    }
    return ctx.pickWeighted(options);
  };
}

export function nativeExit(p: ExitParams): ExitFn {
  const blocked = p.blocked.slice();
  const cap = p.capacityPerLane;
  return (ctx) => {
    if (blocked.some((b) => ctx.t >= b.from && ctx.t < b.to)) return false;
    if (cap <= 0) return true;
    const m = ctx.memory as { tokens?: number[] };
    if (!m.tokens) m.tokens = [];
    const prev = m.tokens[ctx.lane] ?? 1;
    const now = Math.min(1, prev + (cap / 3600) * ctx.dt);
    if (now >= 1) { m.tokens[ctx.lane] = now - 1; return true; }
    m.tokens[ctx.lane] = now;
    return false;
  };
}
