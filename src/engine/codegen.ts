// Генерация TypeScript-кода узлов из параметров. Код показывается пользователю,
// его можно править вручную и применять. Контракты функций — в types.ts.

import type { ExitParams, LaneChooserParams, SignalProgram, SpawnerParams } from './types';

const num = (x: number) => String(x);
const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

export function genSpawnerCode(armLabel: string, p: SpawnerParams): string {
  const dests = Object.entries(p.destinations)
    .filter(([, w]) => (w ?? 0) > 0)
    .map(([d, w]) => `${key(d)}: ${num(w ?? 0)}`)
    .join(', ');
  const types = p.types
    .filter((t) => t.share > 0)
    .map((t) => `  { kind: '${t.kind}', share: ${num(t.share)}, length: [${num(t.lengthMin)}, ${num(t.lengthMax)}] },`)
    .join('\n');
  const profile = p.profile.length
    ? `[\n${p.profile.map((r) => `  { from: ${num(r.from)}, rate: ${num(r.rate)} },`).join('\n')}\n]`
    : '[]';
  const arrival = {
    poisson: 'Пуассоновский поток: интервалы между машинами случайные, с показательным распределением',
    uniform: 'Равномерный поток, одинаковые интервалы',
    platoon: 'Пачки машин, как после соседнего светофора',
  }[p.arrival];
  return `// Узел появления машин: подход «${armLabel}».
// Сгенерировано из параметров. Можно править и нажать «Применить код».
// ${arrival}.
import type { SpawnContext, NewVehicle, ArmId, VehicleKind } from 'sim';

const RATE_VPH = ${num(p.rate)};          // интенсивность, авт/ч
const PROFILE: { from: number; rate: number }[] = ${profile}; // профиль по времени, с → авт/ч
const ARRIVAL: 'poisson' | 'uniform' | 'platoon' = '${p.arrival}';
const PLATOON_SIZE = ${num(p.platoonSize)};
// Доли машин по подходам выезда (ключ — id подхода)
const DESTINATIONS: Record<ArmId, number> = { ${dests} };
const TYPES: { kind: VehicleKind; share: number; length: [number, number] }[] = [
${types}
];

function rateAt(t: number): number {
  let r = RATE_VPH;
  for (const p of PROFILE) if (t >= p.from) r = p.rate;
  return r;
}

function makeVehicle(ctx: SpawnContext): NewVehicle {
  const type = ctx.pickWeighted(TYPES.map((x) => [x, x.share] as [typeof x, number]));
  return {
    destination: ctx.pick(DESTINATIONS),
    kind: type.kind,
    length: ctx.uniform(type.length[0], type.length[1]),
  };
}

export function spawn(ctx: SpawnContext): NewVehicle[] {
  if (!TYPES.length || !Object.keys(DESTINATIONS).length) return [];
  const m = ctx.memory as { acc?: number; need?: number };
  const out: NewVehicle[] = [];
  const until = +ctx.t.toFixed(6);
  let from = +(until - ctx.dt).toFixed(6);
  // Интегрируем профиль по частям и сохраняем момент каждого события.
  while (from < until) {
    let to = until;
    for (const x of PROFILE) if (x.from > from && x.from < to) to = x.from;
    const rate = rateAt(from);
    if (rate > 0) {
      if (ARRIVAL === 'poisson' && m.need === undefined) m.need = -Math.log(1 - ctx.random());
      m.acc = (m.acc ?? 0) + rate * (to - from) / 3600;
      const batch = ARRIVAL === 'platoon' ? Math.max(1, PLATOON_SIZE) : 1;
      while (m.acc + 1e-12 >= (ARRIVAL === 'poisson' ? m.need! : batch)) {
        m.acc = Math.max(0, m.acc - (ARRIVAL === 'poisson' ? m.need! : batch));
        const at = +(to - m.acc * 3600 / rate).toFixed(6);
        if (ARRIVAL === 'poisson') m.need = -Math.log(1 - ctx.random());
        for (let i = 0; i < batch; i++) out.push({ ...makeVehicle(ctx), at });
      }
    }
    from = to;
  }
  return out;
}
`;
}

export function genLaneChooserCode(armLabel: string, p: LaneChooserParams, laneCount: number): string {
  const lines = Object.entries(p.weights)
    .map(([d, ws]) => `  ${key(d)}: [${(ws ?? []).slice(0, laneCount).map(num).join(', ')}],`)
    .join('\n');
  return `// Точка перестроения: подход «${armLabel}».
// Решает, в какую полосу (0 — у оси дороги) встаёт машина до начала сплошной разметки.
// Сгенерировано из параметров. Можно править и нажать «Применить код».
import type { VehicleInfo, LaneContext, ArmId } from 'sim';

const STRATEGY: 'weights' | 'shortestQueue' = '${p.strategy}';
// Веса полос для каждого направления выезда (индекс массива — номер полосы)
const WEIGHTS: Record<ArmId, number[]> = {
${lines}
};

export function chooseLane(v: VehicleInfo, ctx: LaneContext): number {
  const w = WEIGHTS[v.destination] ?? [];
  const options: [number, number][] = [];
  w.forEach((x, lane) => { if (x > 0) options.push([lane, x]); });
  if (options.length === 0) {
    // нет весов — любая полоса, из которой можно доехать
    const ok = ctx.lanes.filter((l) => l.reachable.includes(v.destination));
    return ok.length ? ok[0].index : 0;
  }
  if (STRATEGY === 'shortestQueue') {
    // из разрешённых полос — та, где очередь короче (при равенстве — по весу)
    options.sort((a, b) => ctx.lanes[a[0]].queue - ctx.lanes[b[0]].queue || b[1] - a[1]);
    return options[0][0];
  }
  return ctx.pickWeighted(options);
}
`;
}

export function genExitCode(armLabel: string, p: ExitParams): string {
  const blocked = p.blocked.map((b) => `  { from: ${num(b.from)}, to: ${num(b.to)} },`).join('\n');
  return `// Выезд из модели: дорога «${armLabel}».
// Возвращает true, если машина в конце полосы может покинуть модель на этом шаге.
// Так моделируется пробка дальше по дороге. Сгенерировано из параметров.
import type { ExitContext } from 'sim';

const CAPACITY_PER_LANE_VPH = ${num(p.capacityPerLane)}; // 0 — без ограничений
const BLOCKED: { from: number; to: number }[] = [
${blocked}
];

export function canExit(ctx: ExitContext): boolean {
  if (BLOCKED.some((b) => ctx.t >= b.from && ctx.t < b.to)) return false;
  if (CAPACITY_PER_LANE_VPH <= 0) return true;
  const m = ctx.memory as { tokens?: number[]; last?: number };
  m.tokens ??= [];
  // «ведро с жетонами»: жетоны копятся со скоростью пропускной способности
  const prev = m.tokens[ctx.lane] ?? 1;
  const now = Math.min(1, prev + (CAPACITY_PER_LANE_VPH / 3600) * ctx.dt);
  if (now >= 1) { m.tokens[ctx.lane] = now - 1; return true; }
  m.tokens[ctx.lane] = now;
  return false;
}
`;
}

export function genControllerCode(p: SignalProgram): string {
  const names = p.phases.map((ph, i) => `//   ${i}: «${ph.name}» — ${ph.duration} с`).join('\n');
  return `// Контроллер светофорного объекта, работает в режиме «код».
// Вызывается в конце каждой фазы. Фазы программы:
${names}
import type { ControllerContext } from 'sim';

/** Какая фаза идёт следующей (по умолчанию — по кругу) */
export function nextPhase(ctx: ControllerContext): number {
  return (ctx.phaseIndex + 1) % ctx.phaseCount;
}

/** Длительность основного такта фазы, целые секунды. Пример адаптивности — ниже. */
export function phaseDuration(ctx: ControllerContext, phaseIndex: number): number {
  const base = ctx.durations[phaseIndex];
  // Пример: продлить первую фазу, если очередь на подходе S длиннее 10 машин
  // if (phaseIndex === 0 && (ctx.queues.S ?? 0) > 10) return base + 10;
  // Пример: пропустить пешеходную фазу, если никто не ждёт
  // if (ctx.pedsWaiting === 0 && phaseIndex === ctx.phaseCount - 1) return 1;
  return base;
}
`;
}
