// Светофорная программа: фазы (основные такты), промтакты, состояния сигнальных групп во времени.

import type { Phase, SignalGroup, SignalProgram } from './types';

/** Отображаемое состояние группы */
export type Lamp = 'G' | 'FG' | 'Y' | 'RY' | 'R' | 'OFF';

export interface SignalRuntime {
  phaseIdx: number;
  nextIdx: number;
  segment: 'main' | 'inter';
  segStart: number;
  segDur: number;
  /** длительность текущей фазы (может отличаться от программы при управлении кодом) */
  phaseDur: number;
  cycleCount: number;
}

export function groupById(p: SignalProgram): Map<string, SignalGroup> {
  return new Map(p.groups.map((g) => [g.id, g]));
}

/** Длительность промтакта между фазами */
export function intergreen(p: SignalProgram, from: Phase, to: Phase): number {
  const gm = groupById(p);
  const t = p.timing;
  let need = 0;
  let starts = false;
  for (const g of p.groups) {
    const a = from.green.includes(g.id);
    const b = to.green.includes(g.id);
    if (a && !b) {
      if (g.kind === 'pedestrian') need = Math.max(need, t.pedClearance);
      else need = Math.max(need, t.yellow + t.allRed);
    }
    if (!a && b && g.kind === 'vehicle') starts = true;
  }
  void gm;
  if (need > 0) return Math.max(need, starts ? t.redYellow : 0);
  return starts ? t.redYellow : 0;
}

export function cycleLength(p: SignalProgram): number {
  let total = 0;
  const n = p.phases.length;
  for (let i = 0; i < n; i++) {
    total += p.phases[i].duration;
    total += intergreen(p, p.phases[i], p.phases[(i + 1) % n]);
  }
  return total;
}

export function initSignal(p: SignalProgram): SignalRuntime {
  const n = p.phases.length;
  const rt: SignalRuntime = {
    phaseIdx: 0,
    nextIdx: n > 1 ? 1 : 0,
    segment: 'main',
    segStart: 0,
    segDur: p.phases[0]?.duration ?? 1,
    phaseDur: p.phases[0]?.duration ?? 1,
    cycleCount: 0,
  };
  // сдвиг цикла: начинаем с того места фиксированного цикла, которое соответствует offset
  const { segs, cycle } = buildTimeline(p);
  if (cycle > 0 && n > 0 && p.offset) {
    const tc = ((p.offset % cycle) + cycle) % cycle;
    const seg = segs.find((s) => tc >= s.start && tc < s.end) ?? segs[0];
    rt.phaseIdx = seg.phaseIdx;
    rt.nextIdx = seg.nextIdx;
    rt.segment = seg.kind;
    rt.segStart = seg.start - tc;
    rt.segDur = seg.end - seg.start;
    rt.phaseDur = p.phases[seg.phaseIdx].duration;
  }
  return rt;
}

/** Переход к следующему сегменту (основной такт ↔ промтакт) */
export function advanceSegment(
  p: SignalProgram,
  rt: SignalRuntime,
  t: number,
  chooseNext: (current: number) => number,
  durationOf: (idx: number) => number,
): void {
  const n = p.phases.length;
  if (rt.segment === 'main') {
    const ig = intergreen(p, p.phases[rt.phaseIdx], p.phases[rt.nextIdx]);
    if (ig > 0) {
      rt.segment = 'inter';
      rt.segStart = t;
      rt.segDur = ig;
      return;
    }
  }
  // начинаем следующую фазу
  rt.phaseIdx = rt.nextIdx;
  if (rt.phaseIdx === 0) rt.cycleCount++;
  rt.segment = 'main';
  rt.segStart = t;
  rt.phaseDur = Math.max(1, Math.round(durationOf(rt.phaseIdx)));
  rt.segDur = rt.phaseDur;
  rt.nextIdx = n > 0 ? ((chooseNext(rt.phaseIdx) % n) + n) % n : 0;
}

export function lampOf(p: SignalProgram, rt: SignalRuntime, g: SignalGroup, t: number): Lamp {
  const cur = p.phases[rt.phaseIdx];
  const nxt = p.phases[rt.nextIdx];
  if (!cur) return g.kind === 'arrow' ? 'OFF' : 'R';
  const off: Lamp = g.kind === 'arrow' ? 'OFF' : 'R';
  const tm = p.timing;
  const segEnd = rt.segStart + rt.segDur;
  const inCur = cur.green.includes(g.id);
  const inNext = nxt ? nxt.green.includes(g.id) : false;
  if (rt.segment === 'main') {
    if (!inCur) return off;
    if (!inNext && segEnd - t <= tm.flashGreen + 1e-9) return 'FG';
    return 'G';
  }
  // промтакт
  if (inCur && inNext) return 'G';
  if (inCur && !inNext) {
    if (g.kind === 'vehicle' && t - rt.segStart < tm.yellow - 1e-9) return 'Y';
    return off;
  }
  if (!inCur && inNext && g.kind === 'vehicle' && segEnd - t <= tm.redYellow + 1e-9) return 'RY';
  return off;
}

export function lampPermits(l: Lamp): boolean {
  return l === 'G' || l === 'FG';
}

/** Статическая лента цикла для отображения (ленточный график) */
export interface TimelineSeg {
  start: number;
  end: number;
  phaseIdx: number;
  kind: 'main' | 'inter';
  nextIdx: number;
}

export function buildTimeline(p: SignalProgram): { segs: TimelineSeg[]; cycle: number } {
  const segs: TimelineSeg[] = [];
  const n = p.phases.length;
  let t = 0;
  for (let i = 0; i < n; i++) {
    const ph = p.phases[i];
    const nx = (i + 1) % n;
    segs.push({ start: t, end: t + ph.duration, phaseIdx: i, kind: 'main', nextIdx: nx });
    t += ph.duration;
    const ig = intergreen(p, ph, p.phases[nx]);
    if (ig > 0) {
      segs.push({ start: t, end: t + ig, phaseIdx: i, kind: 'inter', nextIdx: nx });
      t += ig;
    }
  }
  return { segs, cycle: t };
}

/** Состояние групп в момент t фиксированного цикла (для ленточного графика) */
export function lampAtCycleTime(p: SignalProgram, g: SignalGroup, tc: number): Lamp {
  const { segs } = buildTimeline(p);
  const seg = segs.find((s) => tc >= s.start && tc < s.end) ?? segs[segs.length - 1];
  if (!seg) return 'R';
  const rt: SignalRuntime = {
    phaseIdx: seg.phaseIdx,
    nextIdx: seg.nextIdx,
    segment: seg.kind,
    segStart: seg.start,
    segDur: seg.end - seg.start,
    phaseDur: p.phases[seg.phaseIdx].duration,
    cycleCount: 0,
  };
  return lampOf(p, rt, g, tc);
}

/** Интервалы состояний группы на одном цикле */
export function groupBands(p: SignalProgram, g: SignalGroup): Array<{ from: number; to: number; lamp: Lamp }> {
  const { cycle } = buildTimeline(p);
  const out: Array<{ from: number; to: number; lamp: Lamp }> = [];
  const step = 0.5;
  let cur: Lamp | null = null;
  let from = 0;
  for (let t = 0; t < cycle - 1e-9; t += step) {
    const l = lampAtCycleTime(p, g, t + 1e-6);
    if (l !== cur) {
      if (cur !== null) out.push({ from, to: t, lamp: cur });
      cur = l;
      from = t;
    }
  }
  if (cur !== null) out.push({ from, to: cycle, lamp: cur });
  return out;
}
