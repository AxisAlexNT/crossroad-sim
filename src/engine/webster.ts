// Опорная оценка цикла по формуле Вебстера: C₀ = (1,5·L + 5) / (1 − Y).
// L — потерянное время за цикл, Y — сумма расчётных фазовых коэффициентов y = q / s.
// Это приближение для изолированного перекрёстка с фиксированной программой. Его удобно взять
// за начальную точку подбора, но оно не учитывает пешеходов, конфликты внутри фаз и автобусы.

import type { ModelConfig } from './types';
import { buildNetwork } from './network';
import { cycleLength } from './signals';
import { demandTo, phasePermits } from './checks';

/** Поток насыщения на полосу, ед./ч: прямо и для поворотов */
const SAT_STRAIGHT = 1800;
const SAT_TURN = 1600;
/** Потеря на трогание в начале каждой фазы, с */
const START_LOSS = 2;

export interface WebsterResult {
  ok: boolean;
  /** почему формула неприменима */
  why?: string;
  cycle: number;
  lost: number;
  Y: number;
  /** фазовые коэффициенты по фазам, 0 у чисто пешеходных */
  y: number[];
  /** длительности основных тактов, с, целые */
  durations: number[];
}

export function webster(cfg: ModelConfig, minGreen = 7, maxCycle = 180): WebsterResult {
  const net = buildNetwork(cfg);
  const p = cfg.signals;
  const n = p.phases.length;
  const fail = (why: string): WebsterResult => ({ ok: false, why, cycle: 0, lost: 0, Y: 0, y: [], durations: p.phases.map((x) => x.duration) });
  if (n < 2) return fail('в программе меньше двух фаз');

  // в каких фазах горит разрешающий основной сигнал для каждой связи
  const permits = p.phases.map((_, i) => phasePermits(p, net, i));
  const greenIn = net.conns.map((_, ci) => permits.map((pm, i) => (pm[ci] !== 'none' ? i : -1)).filter((i) => i >= 0));

  // интенсивность на полосу подхода: поток направления делится между полосами, откуда оно разрешено
  const laneFlow = new Map<string, { q: number; sat: number; phases: Set<number> }>();
  for (const c of net.conns) {
    if (c.illegal || c.busOnly) continue;
    const from = c.conn.from;
    const lanesForDir = net.conns.filter((x) => !x.illegal && !x.busOnly && x.conn.from.arm === from.arm && x.conn.to.arm === c.conn.to.arm);
    const lanes = new Set(lanesForDir.map((x) => x.conn.from.lane));
    const q = demandTo(cfg, from.arm, c.conn.to.arm) / Math.max(1, lanes.size) / Math.max(1, lanesForDir.filter((x) => x.conn.from.lane === from.lane).length);
    const key = `${from.arm}:${from.lane}`;
    const e = laneFlow.get(key) ?? { q: 0, sat: 0, phases: new Set<number>() };
    // поток насыщения смешанной полосы — средний по долям направлений
    const s = c.kind === 'straight' ? SAT_STRAIGHT : SAT_TURN;
    e.sat = e.q + q > 0 ? (e.sat * e.q + s * q) / (e.q + q) : s;
    e.q += q;
    for (const i of greenIn[c.idx]) e.phases.add(i);
    laneFlow.set(key, e);
  }
  // расчётный коэффициент фазы — наибольший у полос, которые в ней едут. Полоса, едущая в нескольких фазах,
  // делит свою нагрузку между ними поровну
  const y = p.phases.map(() => 0);
  for (const e of laneFlow.values()) {
    if (!e.phases.size || e.q <= 0) continue;
    const yl = e.q / e.sat / e.phases.size;
    for (const i of e.phases) y[i] = Math.max(y[i], yl);
  }
  const Y = y.reduce((a, b) => a + b, 0);
  // потерянное время: промтакты, трогание и фазы, в которых машины не едут вовсе
  const sumMain = p.phases.reduce((a, x) => a + x.duration, 0);
  const inter = cycleLength(p) - sumMain;
  const vehPhases = y.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
  const pedOnly = p.phases.reduce((a, x, i) => a + (y[i] > 0 ? 0 : x.duration), 0);
  const lost = inter + START_LOSS * vehPhases.length + pedOnly;
  if (!vehPhases.length) return fail('ни в одной фазе нет транспортных потоков');
  if (Y >= 0.95) return { ...fail(`сумма фазовых коэффициентов Y = ${Y.toFixed(2).replace('.', ',')}: спрос близок к пропускной способности или больше неё, формула неприменима`), Y, y, lost };
  const C0 = Math.min(maxCycle, (1.5 * lost + 5) / (1 - Y));
  // эффективный зелёный делится пропорционально коэффициентам, чисто пешеходные фазы остаются как есть
  const effective = Math.max(0, C0 - lost);
  const durations = p.phases.map((x, i) => (y[i] > 0 ? Math.max(minGreen, Math.round((effective * y[i]) / Y + START_LOSS)) : x.duration));
  const probe = { ...p, phases: p.phases.map((x, i) => ({ ...x, duration: durations[i] })) };
  return { ok: true, cycle: cycleLength(probe), lost, Y, y, durations };
}
