// Оптимизация длительностей фаз: NSGA-II (несколько целей → множество Парето) и
// дифференциальная эволюция (одна цель). Оценки считаются параллельно в Web Worker'ах.

import type { CompiledCode, ModelConfig, SignalProgram } from './types';
import type { Summary } from './sim';
import { cycleLength } from './signals';
import { buildNetwork } from './network';
import { longestGreen, maxRed } from './checks';
import { pickWeighted, rngNext, seedRng, type RngState } from './rng';

export type Objective = 'avgWait' | 'worstWait' | 'avgDelay' | 'throughput' | 'maxQueue' | 'dangers' | 'collisions' | 'cycle' | 'pedWait' | 'pedDangers' | 'pedHits' | 'deadlocks';

export const OBJECTIVES: Record<Objective, { label: string; unit: string; sense: 'min' | 'max' }> = {
  avgWait: { label: 'Среднее ожидание у стоп-линии', unit: 'с', sense: 'min' },
  worstWait: { label: 'Ожидание на самом загруженном подходе', unit: 'с', sense: 'min' },
  avgDelay: { label: 'Средняя задержка', unit: 'с', sense: 'min' },
  throughput: { label: 'Проезды стоп-линий в час', unit: 'авт/ч', sense: 'max' },
  maxQueue: { label: 'Наибольшая очередь', unit: 'авт', sense: 'min' },
  dangers: { label: 'Опасные моменты', unit: 'шт', sense: 'min' },
  collisions: { label: 'Столкновения в модели', unit: 'шт', sense: 'min' },
  cycle: { label: 'Длительность цикла', unit: 'с', sense: 'min' },
  pedWait: { label: 'Среднее ожидание пешеходов', unit: 'с', sense: 'min' },
  pedDangers: { label: 'Опасные сближения с пешеходами', unit: 'шт', sense: 'min' },
  pedHits: { label: 'Наезды на пешеходов в модели', unit: 'шт', sense: 'min' },
  deadlocks: { label: 'Взаимные блокировки', unit: 'шт', sense: 'min' },
};

export interface PhaseBound {
  idx: number;
  enabled: boolean;
  min: number;
  max: number;
}

export interface OptSettings {
  algorithm: 'auto' | 'nsga2' | 'de';
  objectives: Objective[];
  bounds: PhaseBound[];
  /** не более N секунд запрещающего сигнала для любой транспортной группы (0 — не ограничивать) */
  maxRed: number;
  /** максимальный цикл, с (0 — не ограничивать) */
  maxCycle: number;
  /** пешеходам хватает времени на переход (B / 1,2 м/с по проезжей части, до островка — по половине) */
  pedTime: boolean;
  /** к времени на переход добавить 5 с на начало движения: B / 1,2 + 5 */
  pedTimePlus5: boolean;
  /** нижняя граница длительности подбираемой фазы по умолчанию, с */
  minGreen: number;
  /** сколько лучших вариантов перепроверить на новых зёрнах после подбора */
  reevalTop: number;
  /** сколько новых зёрен для перепроверки */
  reevalSeeds: number;
  /** добавить в начальную популяцию длительности по формуле Вебстера */
  useWebster: boolean;
  budgetSeconds: number;
  simSeconds: number;
  warmup: number;
  dt: number;
  seeds: number;
  population: number;
  workers: number;
  seed: number;
}

export interface Candidate {
  x: number[];
  obj: number[];
  violation: number;
  summary?: Summary;
  cycle: number;
  rank?: number;
  crowd?: number;
  gen: number;
  /** перепроверка на новых зёрнах: средние целей, полуширина 95 % доверительного интервала, число прогонов */
  final?: { mean: number[]; ci: number[]; n: number; summary: Summary };
  /** откуда вариант: исходная программа или формула Вебстера */
  origin?: 'start' | 'webster';
}

export interface OptProgress {
  evaluations: number;
  generation: number;
  elapsed: number;
  best: Candidate[];
  /** все оценённые кандидаты (для графиков и таблицы) */
  all: Candidate[];
  log: string[];
  done: boolean;
  /** этап: поиск или перепроверка лучших на новых зёрнах */
  stage: 'search' | 'reeval';
  /** лучшие после перепроверки, по среднему на новых зёрнах */
  final: Candidate[];
}

/** На телефоне и планшете подбор идёт в 1–2 потока, чтобы не перегревать устройство и не закрывались вкладки */
export function defaultWorkers(): number {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { mobile?: boolean } }) | undefined;
  const hc = nav?.hardwareConcurrency ?? 2;
  const ua = nav?.userAgent ?? '';
  const mobile = nav?.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || ((nav?.maxTouchPoints ?? 0) > 1 && /Macintosh/.test(ua));
  return mobile ? Math.max(1, Math.min(2, hc - 2)) : Math.max(1, Math.min(4, hc - 1));
}

export const MIN_GREEN_DEFAULT = 10;

export function phaseBounds(cfg: ModelConfig, minGreen: number): PhaseBound[] {
  return cfg.signals.phases.map((p, idx) => ({ idx, enabled: true, min: minGreen, max: Math.max(p.duration, minGreen + 10, 60) }));
}

export function defaultOptSettings(cfg: ModelConfig): OptSettings {
  return {
    algorithm: 'auto',
    objectives: ['avgWait'],
    bounds: phaseBounds(cfg, MIN_GREEN_DEFAULT),
    minGreen: MIN_GREEN_DEFAULT,
    maxRed: 90,
    maxCycle: 120,
    pedTime: true,
    pedTimePlus5: false,
    budgetSeconds: 120,
    simSeconds: 900,
    warmup: 180,
    dt: 0.2,
    seeds: 3,
    population: 12,
    workers: defaultWorkers(),
    seed: 1,
    reevalTop: 5,
    reevalSeeds: 5,
    useWebster: true,
  };
}

/** Быстрый подбор: одна цель и рекомендуемые ограничения, остальное как по умолчанию */
export function quickOptSettings(cfg: ModelConfig): OptSettings {
  return { ...defaultOptSettings(cfg), objectives: ['avgWait'], budgetSeconds: 60, simSeconds: 600, seeds: 3, reevalTop: 3, reevalSeeds: 4 };
}

function withDurations(p: SignalProgram, x: number[]): SignalProgram {
  const q: SignalProgram = JSON.parse(JSON.stringify(p));
  q.phases.forEach((ph, i) => { ph.duration = Math.round(x[i]); });
  return q;
}

/** Нарушение ограничений (0 — допустимо). Считается без симуляции. */
export function violation(cfg: ModelConfig, s: OptSettings, x: number[]): { v: number; cycle: number; why: string[] } {
  const p = withDurations(cfg.signals, x);
  const why: string[] = [];
  let v = 0;
  const cyc = cycleLength(p);
  if (s.maxCycle > 0 && cyc > s.maxCycle) { v += cyc - s.maxCycle; why.push(`цикл ${cyc} > ${s.maxCycle} с`); }
  if (s.maxRed > 0) {
    for (const g of p.groups) {
      if (g.kind !== 'vehicle') continue;
      const r = maxRed(p, g.id);
      if (r > s.maxRed) { v += r - s.maxRed; why.push(`красный «${g.name}» ${r.toFixed(0)} > ${s.maxRed} с`); }
    }
  }
  if (s.pedTime) {
    const net = buildNetwork({ ...cfg, signals: p });
    for (const g of p.groups) {
      if (g.kind !== 'pedestrian' || !p.phases.some((ph) => ph.green.includes(g.id))) continue;
      const green = longestGreen(p, g.id);
      for (const m of g.movements) {
        const ei = net.pedEdgeById.get(m);
        if (ei === undefined) continue;
        const e = net.pedEdges[ei];
        const need = (e.roadS1 - e.roadS0) / 1.2 + (s.pedTimePlus5 ? 5 : 0);
        if (need > 0.5 && green < need) { v += need - green; why.push(`пешеходам «${g.name}» не хватает ${(need - green).toFixed(0)} с`); }
      }
    }
  }
  return { v, cycle: cyc, why };
}

export function objectiveVector(s: OptSettings, sum: Summary, cycle: number): number[] {
  return s.objectives.map((o) => {
    switch (o) {
      case 'avgWait': return sum.avgWait;
      case 'worstWait': return sum.worstWait;
      case 'avgDelay': return sum.avgDelay;
      case 'throughput': return -sum.throughputVph;
      case 'maxQueue': return sum.maxQueue;
      case 'dangers': return sum.dangers;
      case 'collisions': return sum.collisions;
      case 'cycle': return cycle;
      case 'pedWait': return sum.pedAvgWait;
      case 'pedDangers': return sum.pedDangers;
      case 'pedHits': return sum.pedHits;
      case 'deadlocks': return sum.deadlocks;
    }
  });
}

/** Доминирование с учётом ограничений (Deb, 2002) */
function dominates(a: Candidate, b: Candidate): boolean {
  if (a.violation > 0 || b.violation > 0) return a.violation < b.violation;
  let better = false;
  for (let i = 0; i < a.obj.length; i++) {
    if (a.obj[i] > b.obj[i] + 1e-12) return false;
    if (a.obj[i] < b.obj[i] - 1e-12) better = true;
  }
  return better;
}

export function nonDominatedSort(pop: Candidate[]): Candidate[][] {
  const fronts: Candidate[][] = [[]];
  const S = new Map<Candidate, Candidate[]>();
  const n = new Map<Candidate, number>();
  for (const p of pop) {
    S.set(p, []);
    n.set(p, 0);
    for (const q of pop) {
      if (p === q) continue;
      if (dominates(p, q)) S.get(p)!.push(q);
      else if (dominates(q, p)) n.set(p, n.get(p)! + 1);
    }
    if (n.get(p) === 0) { p.rank = 0; fronts[0].push(p); }
  }
  let i = 0;
  while (fronts[i] && fronts[i].length) {
    const next: Candidate[] = [];
    for (const p of fronts[i]) for (const q of S.get(p)!) {
      n.set(q, n.get(q)! - 1);
      if (n.get(q) === 0) { q.rank = i + 1; next.push(q); }
    }
    i++;
    fronts.push(next);
  }
  return fronts.filter((f) => f.length);
}

/**
 * Расстояние скученности NSGA-II. Недопустимые варианты имеют цели Infinity: разности бесконечностей дают NaN,
 * поэтому для них считается расстояние по длительностям фаз
 */
export function crowding(front: Candidate[]) {
  for (const c of front) c.crowd = 0;
  if (!front.length) return;
  const finite = front.every((c) => c.obj.every(Number.isFinite));
  const vec = (c: Candidate) => (finite ? c.obj : c.x);
  const m = vec(front[0]).length;
  for (let k = 0; k < m; k++) {
    front.sort((a, b) => vec(a)[k] - vec(b)[k]);
    front[0].crowd = front[front.length - 1].crowd = Infinity;
    const d0 = vec(front[front.length - 1])[k] - vec(front[0])[k];
    const span = Number.isFinite(d0) && d0 > 0 ? d0 : 1;
    for (let i = 1; i < front.length - 1; i++) {
      const d = (vec(front[i + 1])[k] - vec(front[i - 1])[k]) / span;
      if (Number.isFinite(d)) front[i].crowd! += d;
    }
  }
}

/** Квантиль распределения Стьюдента 0,975 для 1…30 степеней свободы, дальше — нормальное */
const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

/** Среднее и полуширина 95 % доверительного интервала */
export function meanCi(xs: number[]): { mean: number; ci: number } {
  const n = xs.length;
  if (!n) return { mean: NaN, ci: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, ci: NaN };
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1));
  return { mean, ci: (T975[n - 2] ?? 1.96) * sd / Math.sqrt(n) };
}

export type Evaluator = (x: number[]) => Promise<Summary>;
/** Оценка нескольких вариантов. seedBase — зерно первого прогона, по умолчанию зерно модели */
export type EvalMany = (xs: number[][], opts?: { seeds?: number; seedBase?: number }) => Promise<Summary[]>;

export class Optimizer {
  private stopFlag = false;
  private rng: RngState;
  evaluations = 0;
  generation = 0;
  archive: Candidate[] = [];
  logLines: string[] = [];
  private t0 = 0;

  private stage: 'search' | 'reeval' = 'search';
  final: Candidate[] = [];
  private abortFlag = false;

  constructor(private cfg: ModelConfig, private s: OptSettings, private evalMany: EvalMany, private onProgress: (p: OptProgress) => void, private webster?: number[] | null) {
    this.rng = seedRng(s.seed);
  }

  /** Первое нажатие останавливает поиск и переходит к перепроверке лучших, второе прерывает и её */
  stop() {
    if (this.stopFlag) this.abortFlag = true;
    this.stopFlag = true;
  }
  get aborted() { return this.abortFlag; }
  get inReeval() { return this.stage === 'reeval'; }

  private rand = () => rngNext(this.rng);

  private log(msg: string) {
    this.logLines.push(`[${((performance.now() - this.t0) / 1000).toFixed(1)} с] ${msg}`);
    if (this.logLines.length > 400) this.logLines.splice(0, 100);
  }

  private clampRound(x: number[]): number[] {
    return x.map((v, i) => {
      const b = this.s.bounds[i];
      if (!b?.enabled) return this.cfg.signals.phases[i].duration;
      return Math.max(b.min, Math.min(b.max, Math.round(v)));
    });
  }

  private randomX(): number[] {
    // при ограничениях на цикл и красный большая часть случайных точек недопустима: берём лучшую из нескольких попыток,
    // а слишком длинный цикл ужимаем пропорционально
    let best: number[] = [];
    let bestV = Infinity;
    for (let k = 0; k < 30 && bestV > 0; k++) {
      let x = this.clampRound(this.s.bounds.map((b, i) => (b.enabled ? b.min + this.rand() * (b.max - b.min) : this.cfg.signals.phases[i].duration)));
      let vio = violation(this.cfg, this.s, x);
      if (vio.v > 0 && this.s.maxCycle > 0 && vio.cycle > this.s.maxCycle) {
        const free = x.reduce((a, v, i) => a + (this.s.bounds[i]?.enabled ? v - this.s.bounds[i].min : 0), 0);
        const over = vio.cycle - this.s.maxCycle;
        if (free > over) {
          const kf = 1 - over / free;
          x = this.clampRound(x.map((v, i) => (this.s.bounds[i]?.enabled ? this.s.bounds[i].min + (v - this.s.bounds[i].min) * kf : v)));
          vio = violation(this.cfg, this.s, x);
        }
      }
      if (vio.v < bestV) { bestV = vio.v; best = x; }
    }
    return best;
  }

  private elapsed() { return (performance.now() - this.t0) / 1000; }
  private outOfTime() { return this.stopFlag || this.elapsed() > this.s.budgetSeconds; }

  private async evaluate(xs: number[][]): Promise<Candidate[]> {
    const out: Candidate[] = xs.map((x) => {
      const vio = violation(this.cfg, this.s, x);
      return { x, obj: [], violation: vio.v, cycle: vio.cycle, gen: this.generation };
    });
    const feasible = out.filter((c) => c.violation === 0);
    // недопустимые кандидаты не симулируем — их сравнивают только по нарушению
    for (const c of out) if (c.violation > 0) c.obj = this.s.objectives.map(() => Infinity);
    if (feasible.length) {
      const sums = await this.evalMany(feasible.map((c) => c.x));
      feasible.forEach((c, i) => {
        c.summary = sums[i];
        c.obj = objectiveVector(this.s, sums[i], c.cycle);
      });
    }
    this.evaluations += xs.length;
    this.archive.push(...out);
    if (this.archive.length > 3000) this.archive.splice(0, 1000);
    return out;
  }

  best(): Candidate[] {
    const feas = this.archive.filter((c) => c.violation === 0 && c.summary);
    if (!feas.length) return [...this.archive].sort((a, b) => a.violation - b.violation).slice(0, 5);
    if (this.s.objectives.length === 1) return [...feas].sort((a, b) => a.obj[0] - b.obj[0]).slice(0, 10);
    // множество Парето по архиву (без дубликатов)
    const seen = new Set<string>();
    const uniq = feas.filter((c) => { const k = c.x.join(','); if (seen.has(k)) return false; seen.add(k); return true; });
    return nonDominatedSort(uniq)[0] ?? [];
  }

  private report(done = false) {
    this.onProgress({ evaluations: this.evaluations, generation: this.generation, elapsed: this.elapsed(), best: this.best(), all: this.archive.slice(), log: [...this.logLines], done, stage: this.stage, final: this.final.slice() });
  }

  async run(): Promise<Candidate[]> {
    this.t0 = performance.now();
    const multi = this.s.objectives.length > 1;
    const algo = this.s.algorithm === 'auto' ? (multi ? 'nsga2' : 'de') : this.s.algorithm;
    this.log(`Алгоритм: ${algo === 'nsga2' ? 'NSGA-II' : 'дифференциальная эволюция'}. Целей ${this.s.objectives.length}, популяция ${this.s.population}, бюджет ${this.s.budgetSeconds} с. Прогон ${this.s.warmup} + ${this.s.simSeconds} с модели, шаг ${this.s.dt} с.`);
    const N = Math.max(4, this.s.population);
    const start = this.clampRound(this.cfg.signals.phases.map((p) => p.duration));
    const init = [start];
    const web = this.s.useWebster && this.webster && this.webster.length === start.length ? this.clampRound(this.webster) : null;
    if (web && web.join() !== start.join()) init.push(web);
    while (init.length < N) init.push(this.randomX());
    let pop = await this.evaluate(init);
    pop[0].origin = 'start';
    if (web && init[1] === web) pop[1].origin = 'webster';
    this.log(`Начальная популяция оценена, вариантов: ${pop.length}${web ? ', среди них длительности по формуле Вебстера' : ''}. Прогонов на вариант ${Math.max(1, this.s.seeds)}, все варианты считаются на одних и тех же зёрнах.`);
    this.report();
    while (!this.outOfTime()) {
      this.generation++;
      pop = algo === 'nsga2' ? await this.nsgaStep(pop, N) : await this.deStep(pop);
      const b = this.best()[0];
      if (b?.summary) this.log(`Поколение ${this.generation}: первый по сортировке вариант ${this.s.objectives.map((o, i) => `${OBJECTIVES[o].label.toLowerCase()} ${(OBJECTIVES[o].sense === 'max' ? -b.obj[i] : b.obj[i]).toFixed(1)}`).join(', ')}, длительности фаз ${b.x.join(' / ')} с`);
      this.report();
    }
    this.log(this.stopFlag ? 'Поиск остановлен пользователем.' : 'Бюджет времени исчерпан.');
    if (!this.abortFlag) await this.reevaluate();
    this.report(true);
    return this.final.length ? this.final : this.best();
  }

  /**
   * Лучшие варианты могли выиграть случайно: на тех же зёрнах, на которых шёл поиск, их оценка смещена.
   * Поэтому они пересчитываются на новых зёрнах, а итог выбирается по среднему на них
   */
  private async reevaluate() {
    const top = this.best().filter((c) => c.violation === 0 && c.summary).slice(0, Math.max(0, this.s.reevalTop));
    const n = Math.max(0, Math.round(this.s.reevalSeeds));
    if (!top.length || n < 1) return;
    this.stage = 'reeval';
    this.log(`Перепроверка лучших вариантов на новых зёрнах: вариантов ${top.length}, зёрен ${n}.`);
    this.report();
    const per: Summary[][] = top.map(() => []);
    const base = this.cfg.sim.seed + 100003;
    for (let k = 0; k < n; k++) {
      if (this.abortFlag) break;
      const sums = await this.evalMany(top.map((c) => c.x), { seeds: 1, seedBase: base + k * 7919 });
      sums.forEach((sm, i) => per[i].push(sm));
      this.evaluations += top.length;
    }
    const done = top.map((c, i) => ({ c, runs: per[i] })).filter((r) => r.runs.length);
    for (const { c, runs } of done) {
      const objs = runs.map((r) => objectiveVector(this.s, r, c.cycle));
      const stats = this.s.objectives.map((_, j) => meanCi(objs.map((o) => o[j])));
      const summary = { ...runs[0] };
      for (const key of Object.keys(summary) as Array<keyof Summary>) summary[key] = runs.reduce((a, r) => a + (r[key] as number), 0) / runs.length;
      c.final = { mean: stats.map((x) => x.mean), ci: stats.map((x) => x.ci), n: runs.length, summary };
    }
    const cands = done.map((r) => r.c);
    if (this.s.objectives.length === 1) cands.sort((a, b) => a.final!.mean[0] - b.final!.mean[0]);
    else {
      const asMean = cands.map((c) => ({ ...c, obj: c.final!.mean, violation: 0 }));
      const fronts = nonDominatedSort(asMean);
      const order = new Map<string, number>();
      fronts.forEach((f, i) => f.forEach((c) => order.set(c.x.join(','), i)));
      cands.sort((a, b) => (order.get(a.x.join(',')) ?? 0) - (order.get(b.x.join(',')) ?? 0) || a.final!.mean[0] - b.final!.mean[0]);
    }
    this.final = cands;
    const fmt = (c: Candidate) => this.s.objectives.map((o, j) => {
      const sign = OBJECTIVES[o].sense === 'max' ? -1 : 1;
      return `${OBJECTIVES[o].label.toLowerCase()} ${(sign * c.final!.mean[j]).toFixed(1)} ± ${Number.isFinite(c.final!.ci[j]) ? c.final!.ci[j].toFixed(1) : '—'}`;
    }).join(', ');
    if (cands[0]) this.log(`Перепроверка закончена. В модели лучший по среднему на новых зёрнах: фазы ${cands[0].x.join(' / ')} с, ${fmt(cands[0])}. Доверительные интервалы 95 %, при их перекрытии варианты в модели не различаются.`);
  }

  private tournament(pop: Candidate[]): Candidate {
    const a = pop[Math.floor(this.rand() * pop.length)];
    const b = pop[Math.floor(this.rand() * pop.length)];
    if ((a.rank ?? 0) !== (b.rank ?? 0)) return (a.rank ?? 0) < (b.rank ?? 0) ? a : b;
    return (a.crowd ?? 0) >= (b.crowd ?? 0) ? a : b;
  }

  private async nsgaStep(pop: Candidate[], N: number): Promise<Candidate[]> {
    for (const f of nonDominatedSort(pop)) crowding(f);
    const kids: number[][] = [];
    const etaC = 15, etaM = 20;
    const n = pop[0].x.length;
    while (kids.length < N) {
      const p1 = this.tournament(pop).x, p2 = this.tournament(pop).x;
      const c1 = [...p1], c2 = [...p2];
      if (this.rand() < 0.9) {
        for (let i = 0; i < n; i++) {
          if (this.rand() > 0.5 || !this.s.bounds[i]?.enabled) continue;
          const u = this.rand();
          const beta = u <= 0.5 ? Math.pow(2 * u, 1 / (etaC + 1)) : Math.pow(1 / (2 * (1 - u)), 1 / (etaC + 1));
          c1[i] = 0.5 * ((1 + beta) * p1[i] + (1 - beta) * p2[i]);
          c2[i] = 0.5 * ((1 - beta) * p1[i] + (1 + beta) * p2[i]);
        }
      }
      for (const c of [c1, c2]) {
        for (let i = 0; i < n; i++) {
          const b = this.s.bounds[i];
          if (!b?.enabled || this.rand() > 1 / Math.max(1, n)) continue;
          const u = this.rand();
          const d = u < 0.5 ? Math.pow(2 * u, 1 / (etaM + 1)) - 1 : 1 - Math.pow(2 * (1 - u), 1 / (etaM + 1));
          c[i] += d * (b.max - b.min);
        }
        kids.push(this.clampRound(c));
      }
    }
    const offspring = await this.evaluate(kids.slice(0, N));
    const all = [...pop, ...offspring];
    const next: Candidate[] = [];
    for (const f of nonDominatedSort(all)) {
      crowding(f);
      if (next.length + f.length <= N) next.push(...f);
      else {
        f.sort((a, b) => (b.crowd ?? 0) - (a.crowd ?? 0));
        next.push(...f.slice(0, N - next.length));
        break;
      }
    }
    return next;
  }

  private async deStep(pop: Candidate[]): Promise<Candidate[]> {
    const F = 0.6, CR = 0.9;
    const n = pop[0].x.length;
    const trials = pop.map((target, i) => {
      const idx = [...pop.keys()].filter((k) => k !== i);
      const pick = () => idx.splice(Math.floor(this.rand() * idx.length), 1)[0];
      const a = pop[pick()].x, b = pop[pick() ?? 0]?.x ?? a, c = pop[pick() ?? 0]?.x ?? a;
      const jr = Math.floor(this.rand() * n);
      return this.clampRound(target.x.map((xv, j) => (this.rand() < CR || j === jr ? a[j] + F * (b[j] - c[j]) : xv)));
    });
    const evald = await this.evaluate(trials);
    return pop.map((target, i) => (dominates(evald[i], target) || (!dominates(target, evald[i]) && this.rand() < 0.5) ? evald[i] : target));
  }
}

export { pickWeighted };
