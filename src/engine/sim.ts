// Микросимуляция перекрёстка.
// Машины движутся по траекториям по модели следования за лидером IDM, светофор работает по программе.
// Машины уступают друг другу по ПДД (13.4, 13.5 и 6.3, 13.8, помеха справа) с учётом обзора:
// встречные левоповоротники, стоящие в перекрёстке, закрывают видимость встречного прямого потока.
// Пешеходы идут группами по графу переходов, ждут разрешающего сигнала у бордюра и на островках.
// Машины уступают пешеходам на переходах. Наезды и опасные сближения считаются по габаритам.

import type {
  PedSource, ArmId, BusStop, CompiledCode, ControllerContext, ExitContext, LaneContext, LaneInfo, ModelConfig,
  NewVehicle, SignalGroup, SpawnContext, VehicleInfo, VehicleKind,
} from './types';
import { armRelations, buildNetwork, pedRouteOptions, type ArmRelations, type ConflictRef, type Network, type PedRoute } from './network';
import { obbOverlap, pointAt, dist, type OBB } from './geometry';
import { pickWeighted, rngNext, rngSeedFrom, seedRng, streamSeed, type RngState } from './rng';
import { TWO_ROW_WIDTH } from './network';
import { advanceSegment, cycleLength, initSignal, lampOf, lampPermits, type Lamp, type SignalRuntime } from './signals';
import { MAX_FAILS, SandboxNode } from './sandbox';
import { nativeChooser, nativeExit, nativeSpawn } from './nodes';

export type Permit = 'main' | 'arrow' | 'none';

export interface Vehicle {
  /** Собственный генератор случайных чисел машины */
  rng: RngState;
  /** Склонность водителя отклоняться от оси манёвра, от −1 вправо до 1 влево: сдвиг у стоп-линии и изгиб */
  lat: number;
  lat2: number;
  /** Время реакции водителя, с, и с какого момента он собирается тронуться */
  reaction: number;
  goSince: number;
  /** с какого момента стоит, −1 если едет */
  haltT: number;
  /** Текущий сдвиг поперёк полосы подхода, м: ряд на широкой полосе или обход по своей траектории */
  shiftNow: number;
  /** Кого эта машина пропускает в свою полосу из соседней, номер или -1, и до какого времени */
  lcYield: number;
  lcYieldUntil: number;
  /** Кто из соседней полосы пропускает эту машину, номер или -1 */
  lcHelper: number;
  id: number;
  kind: VehicleKind;
  len: number;
  wid: number;
  origin: ArmId;
  dest: ArmId;
  phase: 'approach' | 'conn' | 'exit';
  lane: number;
  targetLane: number;
  lcFrom: number;
  lcT: number;
  conn: number;
  outLane: number;
  s: number;
  ps: number;
  v: number;
  a: number;
  amax: number;
  bcomf: number;
  T: number;
  s0: number;
  v0f: number;
  tWanted: number;
  tEnter: number;
  tStop: number;
  stopTime: number;
  risky: boolean;
  /** какие нарушения ПДД этот водитель готов совершить */
  viol: { solid: boolean; stop: boolean; red: boolean; turn: boolean };
  /** на сколько метров за стоп-линию заезжает при остановке (нарушитель) */
  overStopDist: number;
  /** стоит за стоп-линией на запрещающий сигнал */
  overStop: boolean;
  /** перестраивается через сплошную (нарушение) */
  solidCross: boolean;
  /** едет по запрещённому разметкой манёвру */
  illegal: boolean;
  /** куда хотел, если пришлось изменить направление у сплошной */
  origDest: ArmId | null;
  /** с какого момента стоит перед сплошной в ожидании окна для перестроения */
  lcWaitSince: number;
  error: string | null;
  wrongLane: boolean;
  /** рейсовый автобус: маршрут, оставшиеся остановки, стоянка */
  route: string | null;
  stopsLeft: string[];
  dwellUntil: number;
  inBay: boolean;
  bayT: number;
  /** На сколько полос левее кармана автобус стоял перед заездом в него */
  bayShift: number;
  /** почему машина тормозит: ограничение, давшее наименьшее ускорение */
  why: Why;
  whyId: number;
  /** с какого момента стоит (для диагностики), −1 — едет */
  stopSince: number;
  committed: number[];
  yieldingAt: number;
  /** Кого ждёт при уступании: номер машины, -2 — окончания разрешающего сигнала встречным, -1 — не определено */
  yieldTo: number;
  /** До этого времени машина выбирается из неразрешимой блокировки и не проверяет пересечения с другими манёврами */
  ghostUntil: number;
  entryPermit: Permit;
  yellowDecision: 0 | 1 | 2;
  crashed: boolean;
  crashUntil: number;
  stuckSince: number;
  forcedLogged: boolean;
  gridlockLogged: boolean;
  danger: number;
  x: number;
  y: number;
  h: number;
  px: number;
  py: number;
  ph: number;
}

export type Why = 'free' | 'leader' | 'merge' | 'signal' | 'yield' | 'ped' | 'crash' | 'exit' | 'lc' | 'bus' | 'curve' | 'stop';

export interface PedAgent {
  id: number;
  /** людей в группе */
  size: number;
  speed: number;
  origin: string;
  dest: string;
  route: Array<{ edge: number; dir: 1 | -1 }>;
  leg: number;
  /** пройдено по текущему ребру в направлении движения, м */
  w: number;
  waiting: boolean;
  waitTime: number;
  /** сколько секунд путь загорожен машиной */
  blocked: number;
  tSpawn: number;
  hit: boolean;
  hitUntil: number;
  danger: number;
  x: number;
  y: number;
  h: number;
  px: number;
  py: number;
}

export interface Crash {
  id: number;
  x: number;
  y: number;
  r: number;
  until: number;
  vids: number[];
  blocks: Array<{ conn: number; s: number }>;
}

export interface Counters {
  spawned: number;
  crossedStop: number;
  exited: number;
  sumWait: number;
  /** Проезды стоп-линии и суммарное ожидание по подходам */
  crossedBy: Record<string, number>;
  waitBy: Record<string, number>;
  sumDelay: number;
  errors: number;
  collisions: number;
  dangers: number;
  crossings: number;
  forcedLC: number;
  gridlock: number;
  codeErrors: number;
  removedCrash: number;
  dropped: number;
  pedSpawned: number;
  pedDone: number;
  pedWaitSum: number;
  pedDangers: number;
  pedHits: number;
  pedRouteErrors: number;
  missedTurns: number;
  violSolid: number;
  violStop: number;
  violRed: number;
  violTurn: number;
  busSpawned: number;
  busServed: number;
  busDwellSum: number;
  deadlocks: number;
  stalls: number;
}

export interface DeadlockInfo {
  since: number;
  detected: number;
  phase: string;
  segment: string;
  movements: string[];
  vids: number[];
  lastSeen: number;
}

export interface StatusInfo {
  key: string;
  label: string;
  since: number;
  detail: string;
}

export interface SimStatus {
  deadlock: DeadlockInfo | null;
  stall: StatusInfo[];
  slow: StatusInfo[];
}

interface Diag {
  lastCross: Record<string, number>;
  greenAcc: Record<string, number>;
  lastAnyCross: number;
  speedWin: Record<string, number[]>;
  speedRef: Record<string, number>;
  speedN: Record<string, number>;
  cycleCount: Record<string, number>;
  lastCycle: number;
  slowCand: Record<string, number>;
}

export interface SimState {
  t: number;
  tick: number;
  /** Генератор для всего, что не относится к отдельным потокам ниже */
  rng: RngState;
  /**
   * Отдельные потоки случайных чисел: появление машин и их свойства по каждому подходу,
   * автобусы по маршрутам, пешеходы по источникам. Так варианты сравниваются на одних и тех же потоках
   */
  streams: Record<string, RngState>;
  /** Накопленная интенсивность и порог до следующего появления для автобусов и пешеходов */
  arrivals: Record<string, { acc: number; need: number }>;
  nextVid: number;
  nextPid: number;
  nextCrash: number;
  vehicles: Vehicle[];
  peds: PedAgent[];
  queue: Record<ArmId, Array<{ nv: NewVehicle; t: number; rs: number }>>;
  sig: SignalRuntime;
  lamps: Record<string, Lamp>;
  lampSig: string;
  lastLampChange: number;
  permitEnd: number[];
  memory: { spawners: Record<string, Record<string, unknown>>; choosers: Record<string, Record<string, unknown>>; exits: Record<string, Record<string, unknown>>; controller: Record<string, unknown> };
  confLast: Array<{ a: number; b: number }>;
  crashes: Crash[];
  counters: Counters;
  recentStop: Array<{ t: number; wait: number }>;
  recentPed: Array<{ t: number; wait: number }>;
  dangerPairs: Record<string, number>;
  crashPairs: Record<string, number>;
  maxQueue: number;
  status: SimStatus;
  diag: Diag;
}

/** Выборки для гистограмм: время, подход, значение */
export interface Sample {
  t: number;
  a: string;
  v: number;
}

export interface Samples {
  wait: Sample[];
  delay: Sample[];
  pedWait: Sample[];
  cycle: Sample[];
  dwell: Sample[];
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  t: number;
  level: LogLevel;
  code: string;
  msg: string;
  detail?: string;
  vid?: number;
}

export interface Series {
  t: number[];
  inSystem: number[];
  throughput: number[];
  avgWait: number[];
  maxQueue: number[];
  passed: number[];
  errors: number[];
  dangers: number[];
  crossings: number[];
  collisions: number[];
  pedActive: number[];
  pedDone: number[];
  pedWait: number[];
  pedDangers: number[];
  pedHits: number[];
  violations: number[];
  missed: number[];
  meanSpeed: number[];
  queues: Record<ArmId, number[]>;
}

export function emptySeries(arms: ArmId[] = []): Series {
  const queues: Record<ArmId, number[]> = {};
  for (const a of arms) queues[a] = [];
  return { t: [], inSystem: [], throughput: [], avgWait: [], maxQueue: [], passed: [], errors: [], dangers: [], crossings: [], collisions: [], pedActive: [], pedDone: [], pedWait: [], pedDangers: [], pedHits: [], violations: [], missed: [], meanSpeed: [], queues };
}

function seriesArrays(s: Series): number[][] {
  const out: number[][] = [];
  for (const [k, val] of Object.entries(s)) {
    if (k === 'queues') out.push(...Object.values(val as Record<string, number[]>));
    else out.push(val as number[]);
  }
  return out;
}

export interface Summary {
  horizon: number;
  crossed: number;
  throughputVph: number;
  avgWait: number;
  avgDelay: number;
  /** Среднее ожидание на подходе, где оно больше всего, с */
  worstWait: number;
  maxQueue: number;
  dangers: number;
  collisions: number;
  errors: number;
  crossings: number;
  unserved: number;
  pedDone: number;
  pedAvgWait: number;
  pedDangers: number;
  pedHits: number;
  missedTurns: number;
  violations: number;
  deadlocks: number;
  busServed: number;
}

/** Пешеходы ждут сигнала на таком расстоянии от края проезжей части, м */
const CURB_WAIT = 0.8;
/** Сколько рейсовый автобус ждёт окна для перестроения к остановке перед сплошной, с */
const BUS_LC_PATIENCE = 20;
/** Сколько секунд машина выбирается из неразрешимой блокировки, не проверяя пересечения */
const GHOST_TIME = 8;
/** На каком расстоянии до стоп-линии широкая полоса начинает работать как два ряда, м */
const ROW_ZONE = 30;
/** Скорость смещения поперёк полосы при занятии ряда, м/с */
const ROW_SPEED = 1.0;
/** Сколько секунд водитель в очереди соседней полосы пропускает перестраивающуюся машину */
const LC_COURTESY = 6;
const LC_TIME = 3.0;
/** Время реакции водителя на внезапно появившуюся из-за помехи машину, с */
const REACTION = 0.8;
const B_MAX = 7.0;

/** Значение в диапазоне по распределению: равномерное, нормальное (±3σ в диапазоне) или треугольное. Всегда два случайных числа */
function sampleRange(r: { min: number; max: number; dist: string }, st: RngState): number {
  const u1 = rngNext(st), u2 = rngNext(st);
  const lo = Math.min(r.min, r.max), hi = Math.max(r.min, r.max);
  if (hi - lo < 1e-9) return lo;
  if (r.dist === 'triangular') return lo + (hi - lo) * (u1 + u2) / 2;
  if (r.dist === 'normal') {
    const z = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(lo, Math.min(hi, (lo + hi) / 2 + z * (hi - lo) / 6));
  }
  return lo + (hi - lo) * u1;
}
const VEH_WIDTH: Record<VehicleKind, number> = { car: 1.8, van: 2.0, truck: 2.5, bus: 2.55 };
const RECENT_WINDOW = 300;
/** Интервал снимков состояния для перемотки, с */
const SNAPSHOT_EVERY = 5;
/** Предел очереди машин, ожидающих въезда в модель, на подход */
const MAX_VIRTUAL_QUEUE = 1500;
/** Предел числа групп пешеходов в модели */
const MAX_PEDS = 600;
/** Предел длины рядов графиков: старшая половина прореживается */
const MAX_SERIES = 20000;

type SpawnFn = (ctx: SpawnContext) => NewVehicle[];
type ChooseFn = (v: VehicleInfo, ctx: LaneContext) => number;
type ExitFn = (ctx: ExitContext) => boolean;
type NextFn = (ctx: ControllerContext) => number;
type DurFn = (ctx: ControllerContext, i: number) => number;

export class Simulation {
  cfg: ModelConfig;
  net: Network;
  rel: ArmRelations;
  st: SimState;
  series: Series;
  log: LogEntry[] = [];
  /** число записей журнала по уровням (вместе с вытесненными) */
  levelCounts: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 };
  samples: Samples = { wait: [], delay: [], pedWait: [], cycle: [], dwell: [] };
  dt: number;
  history: SimState[] = [];
  lampChanges: number[] = [];
  logCounts: Record<string, number> = {};
  maxLog = 4000;
  armList: ArmId[];
  private spawnFns: Record<ArmId, SpawnFn | undefined> = {};
  private chooseFns: Record<ArmId, ChooseFn | undefined> = {};
  private exitFns: Record<ArmId, ExitFn | undefined> = {};
  private nextFn: NextFn | null = null;
  private durFn: DurFn | null = null;
  private groups: SignalGroup[];
  private mainGroupsOf: string[][];
  private arrowGroupsOf: string[][];
  /** пешеходные группы для каждого ребра пешеходного графа */
  pedGroupsOf: string[][];
  permit: Permit[] = [];
  yellowMain: boolean[] = [];
  private curveLimits: Array<Array<{ s: number; v: number }>> = [];
  private routes: Map<string, PedRoute[]>;
  private pedSources: Array<{ node: number; nodeId: string; cfgIdx: number }> = [];
  private routeErrLogged = new Set<string>();
  private laneLists: Record<ArmId, Vehicle[][]> = {};
  /** Автобусы в заездных карманах, готовые выехать, по полосам */
  private bayReady: Record<string, Vehicle[]> = {};
  /** Кто заставил уступить при последней проверке mustWait */
  private blocker = -1;
  private connLists: Vehicle[][] = [];
  private exitLists: Record<ArmId, Vehicle[][]> = {};
  private pedsByEdge: PedAgent[][] = [];
  private lateSight = false;
  headless = false;

  constructor(cfg: ModelConfig, code: CompiledCode, opts: { headless?: boolean; dt?: number } = {}) {
    this.cfg = cfg;
    this.headless = !!opts.headless;
    this.dt = opts.dt ?? cfg.sim.dt;
    this.net = buildNetwork(cfg);
    this.rel = armRelations(cfg.arms);
    this.armList = cfg.arms.map((a) => a.id);
    this.series = emptySeries(this.armList);
    this.groups = cfg.signals.groups;
    this.mainGroupsOf = this.net.conns.map(() => []);
    this.arrowGroupsOf = this.net.conns.map(() => []);
    this.pedGroupsOf = this.net.pedEdges.map(() => []);
    for (const g of this.groups) {
      for (const mid of g.movements) {
        if (g.kind === 'pedestrian') {
          const ei = this.net.pedEdgeById.get(mid);
          if (ei !== undefined) this.pedGroupsOf[ei].push(g.id);
          continue;
        }
        // сигнал направления действует на все его траектории
        for (const ci of this.net.connsById.get(mid) ?? []) (g.kind === 'arrow' ? this.arrowGroupsOf : this.mainGroupsOf)[ci].push(g.id);
      }
    }
    this.curveLimits = this.net.conns.map((c) => {
      const out: Array<{ s: number; v: number }> = [];
      for (let i = 0; i < c.path.pts.length; i += 2) if (c.path.vmax[i] < 30) out.push({ s: c.path.cum[i], v: c.path.vmax[i] });
      return out;
    });
    this.routes = pedRouteOptions(this.net);
    cfg.peds.sources.forEach((src, i) => {
      const ni = this.net.pedNodeById.get(src.node);
      if (ni !== undefined) this.pedSources.push({ node: ni, nodeId: src.node, cfgIdx: i });
    });
    this.loadCode(code);
    this.st = this.initialState();
    this.updateSignals(true);
    this.history.push(structuredClone(this.st));
  }

  private stopMap: Map<string, BusStop> | null = null;
  stopById(id: string): BusStop | undefined {
    if (!this.stopMap) this.stopMap = new Map((this.cfg.transit?.stops ?? []).map((x) => [x.id, x]));
    return this.stopMap.get(id);
  }

  armName(id: ArmId): string {
    return this.cfg.arms.find((a) => a.id === id)?.short ?? id;
  }

  pedNodeName(id: string): string {
    return this.cfg.peds.nodes.find((n) => n.id === id)?.label ?? id;
  }

  /** Окружения пользовательского кода: освобождаются в dispose() */
  private sandboxes: SandboxNode[] = [];

  private loadCode(code: CompiledCode) {
    for (const d of this.armList) {
      const sp = this.cfg.spawners[d], ch = this.cfg.laneChoosers[d], ex = this.cfg.exits[d];
      const inLanes = this.net.arms[d].cfg.inLanes;
      // узлы по параметрам — встроенная логика, код, изменённый вручную, — в песочнице
      const spN = this.sandboxed(code.spawners[d], 'spawn', `Появление машин, ${this.armName(d)}`);
      this.spawnFns[d] = spN
        ? (ctx) => spN.call('spawn', [], 0, { t: ctx.t, dt: ctx.dt, arm: ctx.arm, memory: ctx.memory }, ctx.random, this.streamFn('attr:' + d)) as NewVehicle[]
        : sp ? nativeSpawn(sp.params) : undefined;
      const chN = this.sandboxed(code.laneChoosers[d], 'chooseLane', `Перестроение, ${this.armName(d)}`);
      this.chooseFns[d] = chN
        ? (v, ctx) => chN.call('chooseLane', [v], 1, { t: ctx.t, arm: ctx.arm, lanes: ctx.lanes, memory: ctx.memory }, ctx.random) as number
        : ch ? nativeChooser(ch.params, inLanes) : undefined;
      const exN = this.sandboxed(code.exits[d], 'canExit', `Выезд, ${this.armName(d)}`);
      this.exitFns[d] = exN
        ? (ctx) => exN.call('canExit', [], 0, { t: ctx.t, dt: ctx.dt, arm: ctx.arm, lane: ctx.lane, memory: ctx.memory }, this.streamFn('exit:' + d)) as boolean
        : ex ? nativeExit(ex.params) : undefined;
    }
    if (this.cfg.signals.controller === 'code' && code.controller) {
      const n = this.sandboxed(code.controller, 'nextPhase', 'Контроллер светофора');
      if (n) {
        const plain = (c: ControllerContext) => ({ t: c.t, phaseIndex: c.phaseIndex, phaseCount: c.phaseCount, durations: c.durations, queues: c.queues, pedsWaiting: c.pedsWaiting, memory: c.memory });
        this.nextFn = (c) => n.call('nextPhase', [], 0, plain(c), this.streamFn('signal')) as number;
        if (n.has('phaseDuration')) this.durFn = (c, i) => n.call('phaseDuration', [i], 0, plain(c), this.streamFn('signal')) as number;
      }
    }
  }

  /** Загрузить код узла в отдельную песочницу. Если не вышло, узел работает по параметрам */
  private sandboxed(js: string | undefined, name: string, label: string): SandboxNode | null {
    if (!js) return null;
    try {
      const node = new SandboxNode(js);
      this.sandboxes.push(node);
      if (!node.has(name)) {
        this.addLog('error', 'code', `${label}: не найдена экспортируемая функция ${name}(), узел работает по параметрам`);
        return null;
      }
      return node;
    } catch (e) {
      this.addLog('error', 'code', `${label}: пользовательский код не запущен, узел работает по параметрам`, e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  /** Ошибка в коде узла: после MAX_FAILS ошибок подряд узел переходит на параметры */
  private codeFailed(kind: 'spawn' | 'chooseLane' | 'canExit' | 'controller', arm: ArmId | null) {
    const st = this.st;
    st.counters.codeErrors++;
    const node = this.sandboxes.find((n) => n.fails >= MAX_FAILS && !n.disposed);
    if (!node) return;
    node.dispose();
    const label = arm ? `«${this.armName(arm)}»` : '';
    if (kind === 'spawn' && arm) this.spawnFns[arm] = this.cfg.spawners[arm] ? nativeSpawn(this.cfg.spawners[arm].params) : undefined;
    else if (kind === 'chooseLane' && arm) this.chooseFns[arm] = this.cfg.laneChoosers[arm] ? nativeChooser(this.cfg.laneChoosers[arm].params, this.net.arms[arm].cfg.inLanes) : undefined;
    else if (kind === 'canExit' && arm) this.exitFns[arm] = this.cfg.exits[arm] ? nativeExit(this.cfg.exits[arm].params) : undefined;
    else { this.nextFn = null; this.durFn = null; }
    this.addLog('error', 'code', `Код узла ${kind}() ${label} ошибся ${MAX_FAILS} раз подряд и отключён до перезапуска, узел работает по параметрам`);
  }

  /** Освободить окружения пользовательского кода */
  dispose() {
    for (const n of this.sandboxes) n.dispose();
    this.sandboxes = [];
  }

  private initialState(): SimState {
    const queue: SimState['queue'] = {};
    const mem = { spawners: {}, choosers: {}, exits: {}, controller: {} } as SimState['memory'];
    for (const d of this.armList) {
      queue[d] = [];
      mem.spawners[d] = {};
      mem.choosers[d] = {};
      mem.exits[d] = {};
    }
    return {
      t: 0, tick: 0, rng: seedRng(this.cfg.sim.seed), streams: {}, arrivals: {}, nextVid: 1, nextPid: 1, nextCrash: 1,
      vehicles: [], peds: [], queue,
      sig: initSignal(this.cfg.signals), lamps: {}, lampSig: '', lastLampChange: 0,
      permitEnd: this.net.conns.map(() => -1e9),
      memory: mem,
      confLast: this.net.conflicts.map(() => ({ a: -1e9, b: -1e9 })),
      crashes: [],
      counters: {
        spawned: 0, crossedStop: 0, exited: 0, sumWait: 0, crossedBy: {}, waitBy: {}, sumDelay: 0, errors: 0, collisions: 0, dangers: 0, crossings: 0,
        forcedLC: 0, gridlock: 0, codeErrors: 0, removedCrash: 0, dropped: 0,
        pedSpawned: 0, pedDone: 0, pedWaitSum: 0, pedDangers: 0, pedHits: 0, pedRouteErrors: 0,
        missedTurns: 0, violSolid: 0, violStop: 0, violRed: 0, violTurn: 0, busSpawned: 0, busServed: 0, busDwellSum: 0, deadlocks: 0, stalls: 0,
      },
      recentStop: [], recentPed: [], dangerPairs: {}, crashPairs: {}, maxQueue: 0,
      status: { deadlock: null, stall: [], slow: [] },
      diag: {
        lastCross: Object.fromEntries(this.armList.map((a) => [a, 0])), greenAcc: Object.fromEntries(this.armList.map((a) => [a, 0])), lastAnyCross: 0,
        speedWin: {}, speedRef: {}, speedN: {}, cycleCount: Object.fromEntries(this.armList.map((a) => [a, 0])), lastCycle: 0, slowCand: {},
      },
    };
  }

  // ---------------- Журнал ----------------

  addLog(level: LogLevel, code: string, msg: string, detail?: string, vid?: number) {
    this.logCounts[code] = (this.logCounts[code] ?? 0) + 1;
    this.levelCounts[level]++;
    if (this.headless) return;
    if (this.log.length >= this.maxLog) this.log.splice(0, 500);
    this.log.push({ t: this.st ? +this.st.t.toFixed(1) : 0, level, code, msg, detail, vid });
  }

  private rand = () => rngNext(this.st.rng);

  /** Именованный поток случайных чисел: создаётся при первом обращении из общего зерна */
  private stream(key: string): RngState {
    const st = this.st;
    return (st.streams[key] ??= seedRng(streamSeed(this.cfg.sim.seed, key)));
  }
  private streamFn(key: string): () => number {
    const r = this.stream(key);
    return () => rngNext(r);
  }

  /**
   * Появления по пуассоновскому потоку: накопленная интенсивность до следующего события распределена
   * показательно. Моменты не зависят от шага симуляции, на одно событие уходит одно случайное число
   */
  private poissonArrivals(key: string, perHour: number): number {
    if (perHour <= 0) return 0;
    const st = this.st;
    const r = this.stream('arr:' + key);
    const a = (st.arrivals[key] ??= { acc: 0, need: -Math.log(1 - rngNext(r)) });
    a.acc += (perHour * this.dt) / 3600;
    let n = 0;
    while (a.acc >= a.need && n < 50) {
      a.acc -= a.need;
      a.need = -Math.log(1 - rngNext(r));
      n++;
    }
    return n;
  }

  // ---------------- Светофор ----------------

  private controllerCtx(idx: number): ControllerContext {
    const queues: Record<ArmId, number> = {};
    for (const d of this.armList) queues[d] = this.armQueue(d);
    return {
      t: this.st.t, phaseIndex: idx, phaseCount: this.cfg.signals.phases.length,
      durations: this.cfg.signals.phases.map((p) => p.duration), queues,
      pedsWaiting: this.st.peds.filter((p) => p.waiting).reduce((a, p) => a + p.size, 0),
      memory: this.st.memory.controller,
    };
  }

  private chooseNext = (i: number): number => {
    const n = this.cfg.signals.phases.length;
    if (this.nextFn) {
      try {
        const r = this.nextFn(this.controllerCtx(i));
        if (Number.isInteger(r) && r >= 0 && r < n) return r;
        this.addLog('error', 'code', `Контроллер вернул недопустимый номер фазы: ${r}`);
      } catch (e) {
        this.addLog('error', 'code', 'Ошибка в nextPhase()', e instanceof Error ? e.message : String(e));
        this.codeFailed('controller', null);
      }
    }
    return (i + 1) % Math.max(1, n);
  };

  private durationOf = (i: number): number => {
    const base = this.cfg.signals.phases[i]?.duration ?? 1;
    if (this.durFn) {
      try {
        const r = this.durFn(this.controllerCtx(i), i);
        if (Number.isFinite(r) && r >= 1) return Math.round(r);
      } catch (e) {
        this.addLog('error', 'code', 'Ошибка в phaseDuration()', e instanceof Error ? e.message : String(e));
        this.codeFailed('controller', null);
      }
    }
    return base;
  };

  private updateSignals(force = false) {
    const st = this.st;
    const p = this.cfg.signals;
    if (p.phases.length === 0) return;
    let guard = 0;
    while (st.t >= st.sig.segStart + st.sig.segDur - 1e-9 && guard++ < 20) {
      advanceSegment(p, st.sig, st.sig.segStart + st.sig.segDur, this.chooseNext, this.durationOf);
    }
    let sig = '';
    for (const g of this.groups) {
      const l = lampOf(p, st.sig, g, st.t);
      st.lamps[g.id] = l;
      sig += l;
    }
    if (sig !== st.lampSig) {
      if (!force) this.lampChanges.push(st.t);
      st.lampSig = sig;
      st.lastLampChange = st.t;
    }
    const prevPermit = this.permit;
    this.permit = this.net.conns.map((_, ci) => {
      if (this.mainGroupsOf[ci].some((g) => lampPermits(st.lamps[g]))) return 'main';
      if (this.arrowGroupsOf[ci].some((g) => lampPermits(st.lamps[g]))) return 'arrow';
      return 'none';
    });
    // запрещённый разметкой манёвр нарушитель совершает, когда горит разрешающий сигнал для его полосы
    for (let ci = this.net.legalCount; ci < this.net.conns.length; ci++) {
      const f = this.net.conns[ci].conn.from;
      let pm: Permit = 'none';
      for (const cj of this.net.connsFromLane[f.arm]?.[f.lane] ?? []) {
        if (this.permit[cj] === 'main') { pm = 'main'; break; }
        if (this.permit[cj] === 'arrow') pm = 'arrow';
      }
      this.permit[ci] = pm;
    }
    this.yellowMain = this.net.conns.map((c, ci) => {
      if (!c.illegal) return this.mainGroupsOf[ci].some((g) => st.lamps[g] === 'Y');
      return (this.net.connsFromLane[c.conn.from.arm]?.[c.conn.from.lane] ?? []).some((cj) => this.mainGroupsOf[cj].some((g) => st.lamps[g] === 'Y'));
    });
    this.permit.forEach((pm, ci) => {
      if (pm === 'none' && prevPermit[ci] && prevPermit[ci] !== 'none') st.permitEnd[ci] = st.t;
    });
  }

  /** Пешеходный сигнал на ребре: 'start' — можно начинать переход, 'go' — можно продолжать, 'stop' */
  pedSignal(edge: number): 'free' | 'start' | 'go' | 'stop' {
    const gs = this.pedGroupsOf[edge];
    if (!gs || !gs.length) return 'free';
    let go = false;
    for (const g of gs) {
      const l = this.st.lamps[g];
      if (l === 'G') return 'start';
      if (l === 'FG') go = true;
    }
    return go ? 'go' : 'stop';
  }

  // ---------------- Появление машин ----------------

  private spawnCtx(arm: ArmId): SpawnContext {
    const st = this.st;
    // моменты появления и свойства машин — из разных потоков подхода
    const attr = this.stream('attr:' + arm);
    return {
      t: st.t, dt: this.dt, arm, random: this.streamFn('arr:' + arm),
      uniform: (a, b) => a + (b - a) * rngNext(attr),
      pick: (w: Record<string, number>) => pickWeighted(attr, Object.entries(w).map(([k, x]) => [k, x ?? 0] as [string, number])),
      pickWeighted: <T>(items: Array<[T, number]>) => pickWeighted(attr, items),
      memory: st.memory.spawners[arm],
    };
  }

  private laneInfos(arm: ArmId): LaneInfo[] {
    const lists = this.laneLists[arm] ?? [];
    return this.net.reachable[arm].map((reach, i) => ({
      index: i, reachable: [...reach], vehicles: lists[i]?.length ?? 0,
      queue: (lists[i] ?? []).filter((v) => v.v < 1).length,
    }));
  }

  /** Рейсовые автобусы: пуассоновский поток по каждому маршруту */
  private spawnBuses() {
    const tr = this.cfg.transit;
    if (!tr?.enabled) return;
    const st = this.st;
    for (const r of tr.routes) {
      if (!r.enabled || r.perHour <= 0 || !st.queue[r.from] || !this.armList.includes(r.to)) continue;
      const n = this.poissonArrivals('bus:' + r.id, r.perHour);
      for (let i = 0; i < n; i++) {
        const rs = rngSeedFrom(this.stream('busveh:' + r.id));
        if (!this.net.reachableBus[r.from]?.some((x) => x.includes(r.to))) continue;
        st.queue[r.from].push({ nv: { destination: r.to, kind: 'bus', length: r.length, route: r.id }, t: st.t, rs });
        st.counters.busSpawned++;
      }
    }
  }

  private spawnAll() {
    const st = this.st;
    this.spawnBuses();
    for (const arm of this.armList) {
      const fn = this.spawnFns[arm];
      if (fn) {
        try {
          const out = fn(this.spawnCtx(arm)) ?? [];
          for (const nv of out) {
            // своё зерно для каждой машины: её водитель, полоса и нарушения не зависят от того, что было с другими
            const rs = rngSeedFrom(this.stream('veh:' + arm));
            if (!nv || !this.armList.includes(nv.destination)) {
              this.addLog('error', 'code', `Появление машин, ${this.armName(arm)}: неизвестный подход выезда «${String(nv?.destination)}»`);
              st.counters.codeErrors++;
              continue;
            }
            const anyLane = (nv.route ? this.net.reachableBus : this.net.reachable)[arm].some((r) => r.includes(nv.destination));
            if (!anyLane) {
              st.counters.errors++;
              this.addLog('error', 'route', `С подхода «${this.armName(arm)}» нельзя проехать на «${this.armName(nv.destination)}»: ни одна полоса не связана с этим выездом. Машина не создана.`);
              continue;
            }
            if (st.queue[arm].length >= MAX_VIRTUAL_QUEUE) {
              st.counters.dropped++;
              if (st.counters.dropped === 1 || st.counters.dropped % 500 === 0) {
                this.addLog('warn', 'overflow', `Очередь за пределами модели на подходе «${this.armName(arm)}» превысила ${MAX_VIRTUAL_QUEUE} машин: спрос больше пропускной способности. Новые машины не добавляются, всего отброшено ${st.counters.dropped}.`);
              }
              continue;
            }
            st.queue[arm].push({ nv: { ...nv, length: Math.max(3, Math.min(20, nv.length || 4.5)) }, t: st.t, rs });
          }
        } catch (e) {
          this.addLog('error', 'code', `Ошибка в spawn(), подход «${this.armName(arm)}»`, e instanceof Error ? e.message : String(e));
          this.codeFailed('spawn', arm);
        }
      }
      this.insertFromQueue(arm);
    }
  }

  private insertFromQueue(arm: ArmId) {
    const st = this.st;
    const g = this.net.arms[arm];
    const q = st.queue[arm];
    let guard = 0;
    while (q.length > 0 && guard++ < 4) {
      const item = q[0];
      const nv = item.nv;
      // генератор этой машины: при повторной попытке вставки те же случайные числа
      const vr = seedRng(item.rs ?? 0);
      const vrand = () => rngNext(vr);
      const nLanes = g.cfg.inLanes;
      const lists = this.laneLists[arm];
      const info: VehicleInfo = { id: st.nextVid, kind: nv.kind, length: nv.length, destination: nv.destination, lane: 0 };
      let target = 0;
      let err: string | null = null;
      const chooser = nv.route ? undefined : this.chooseFns[arm];
      const fallback = () => this.net.reachable[arm].findIndex((r) => r.includes(nv.destination));
      const route = nv.route ? this.cfg.transit.routes.find((r) => r.id === nv.route) : undefined;
      const approachStop = route?.stops.map((id) => this.stopById(id)).find((x) => x && x.arm === arm && x.side === 'approach');
      if (nv.route) {
        // рейсовый автобус: к остановке у бордюра — крайняя правая полоса, иначе ближайшая к бордюру полоса нужного направления
        const lanes = this.net.reachableBus[arm].map((r, i) => (r.includes(nv.destination) ? i : -1)).filter((i) => i >= 0);
        target = approachStop ? nLanes - 1 : lanes.length ? lanes[lanes.length - 1] : 0;
        // к остановке на выезде — из полосы, откуда можно попасть в полосу выезда у бордюра
        const stopIds = route ? route.stops.filter((id) => !!this.stopById(id)) : [];
        if (!approachStop && this.busNeedsCurbExit(nv.route, stopIds, nv.destination)) {
          const curb = this.net.arms[nv.destination].cfg.outLanes - 1;
          const ok = lanes.filter((i) => (this.net.connFor[arm][i]?.[nv.destination] ?? []).some((ci) => this.net.conns[ci].conn.to.lane === curb));
          if (ok.length) target = ok[ok.length - 1];
        }
      } else if (chooser) {
        try {
          const ctx: LaneContext = {
            t: st.t, arm, lanes: this.laneInfos(arm), random: vrand,
            pickWeighted: <T>(items: Array<[T, number]>) => pickWeighted(vr, items),
            memory: st.memory.choosers[arm],
          };
          const r = chooser(info, ctx);
          if (!Number.isInteger(r) || r < 0 || r >= nLanes) {
            err = `код выбрал несуществующую полосу «${String(r)}», а полос на подходе ${nLanes}`;
            target = Math.max(0, fallback());
          } else target = r;
        } catch (e) {
          this.addLog('error', 'code', `Ошибка в chooseLane(), подход «${this.armName(arm)}»`, e instanceof Error ? e.message : String(e));
          this.codeFailed('chooseLane', arm);
          target = Math.max(0, fallback());
        }
      } else target = Math.max(0, fallback());
      const reach = (nv.route ? this.net.reachableBus : this.net.reachable)[arm][target] ?? [];
      const wrong = !reach.includes(nv.destination) && !(nv.route && approachStop);
      if (wrong && !err) {
        const okLanes = this.net.reachable[arm].map((r, i) => (r.includes(nv.destination) ? i : -1)).filter((i) => i >= 0);
        err = `машина хочет на «${this.armName(nv.destination)}», а код поставил её в полосу ${target}. ` +
          `Из полосы ${target} можно проехать: ${reach.length ? reach.map((d) => this.armName(d)).join(', ') : 'никуда, связей нет'}. ` +
          `Нужная полоса: ${okLanes.join(' или ')}.`;
      }
      let lane = nv.route || vrand() < (this.cfg.laneChoosers[arm]?.params.preLaned ?? 1) ? target : Math.floor(vrand() * nLanes);
      const free = (i: number) => {
        const l = lists?.[i] ?? [];
        const last = l[0];
        return !last || last.s - last.len > nv.length + 4;
      };
      if (!free(lane)) {
        const alt = [...Array(nLanes).keys()].sort((a, b) => Math.abs(a - target) - Math.abs(b - target)).find(free);
        if (alt === undefined) break;
        lane = alt;
      }
      q.shift();
      const kind = nv.kind;
      const truck = kind === 'truck' || kind === 'bus';
      const v0 = g.cfg.speedLimit / 3.6;
      const dr = this.cfg.sim.drivers;
      // параметры водителя: из узла появления этого подхода или общие, каждый — по своему распределению
      const sd = this.cfg.spawners[arm]?.params.drivers;
      const pick = (r: { min: number; max: number; dist: string } | undefined, lo: number, hi: number) => sampleRange(r ?? { min: lo, max: hi, dist: 'uniform' }, vr);
      const accel = pick(sd?.accel, dr.accelMin, dr.accelMax);
      const headway = pick(sd?.headway, dr.headwayMin, dr.headwayMax);
      const gap = pick(sd?.gap, dr.gap, dr.gap);
      const speedF = pick(sd?.speed, dr.speedMin, dr.speedMax);
      const reaction = pick(sd?.reaction, dr.reactionMin, dr.reactionMax);
      const lastInLane = (lists?.[lane] ?? [])[0];
      const veh: Vehicle = {
        id: st.nextVid++, kind, len: nv.length, wid: VEH_WIDTH[kind] ?? 1.8, origin: arm, dest: nv.destination,
        phase: 'approach', lane, targetLane: target, lcFrom: lane, lcT: -1, conn: -1, outLane: 0, s: 0, ps: 0,
        v: lastInLane && lastInLane.s < 60 ? Math.min(lastInLane.v, v0 * 0.9) : v0 * 0.9, a: 0,
        amax: truck ? dr.heavyAccel : accel, bcomf: truck ? 2.0 : 2.5,
        T: truck ? headway + 0.2 : headway,
        s0: gap, v0f: speedF, reaction, goSince: -1, haltT: -1, tWanted: item.t, tEnter: st.t, tStop: -1, stopTime: st.t - item.t,
        risky: false, viol: { solid: false, stop: false, red: false, turn: false }, overStopDist: 0, overStop: false, solidCross: false, illegal: false,
        origDest: null, lcWaitSince: -1, error: null, wrongLane: wrong, committed: [],
        rng: vr, lat: rngNext(vr) * 2 - 1, lat2: rngNext(vr) * 2 - 1, shiftNow: 0, lcYield: -1, lcYieldUntil: 0, lcHelper: -1, route: nv.route ?? null, stopsLeft: route ? route.stops.filter((id) => !!this.stopById(id)) : [], dwellUntil: -1, inBay: false, bayT: 0, bayShift: 0,
        why: 'free', whyId: -1, stopSince: -1,
        yieldingAt: -1, yieldTo: -1, ghostUntil: 0, entryPermit: 'none', yellowDecision: 0, crashed: false, crashUntil: 0, stuckSince: -1,
        forcedLogged: false, gridlockLogged: false, danger: -1e9, x: 0, y: 0, h: 0, px: 0, py: 0, ph: 0,
      };
      // рискованные водители (рейсовые автобусы — нет) иногда нарушают ПДД
      if (!nv.route && vrand() < this.cfg.sim.riskyShare) {
        const vs = this.cfg.sim.violations;
        veh.risky = true;
        // рискованные водители держат меньший интервал и подъезжают ближе
        veh.T *= dr.riskyFactor;
        veh.s0 *= dr.riskyFactor;
        veh.viol = { solid: vrand() < vs.solidLine, stop: vrand() < vs.stopLine, red: vrand() < vs.redLight, turn: vrand() < vs.illegalTurn };
        veh.overStopDist = veh.viol.stop ? 1.5 + 2 * vrand() : 0;
      }
      if (err) {
        veh.error = err;
        st.counters.errors++;
        this.addLog('error', 'lane', `Машина #${veh.id}, ${this.armName(arm)} → ${this.armName(veh.dest)}: ${err}`, undefined, veh.id);
      }
      this.pose(veh);
      veh.px = veh.x; veh.py = veh.y; veh.ph = veh.h;
      st.vehicles.push(veh);
      st.counters.spawned++;
      (lists[lane] ??= []).unshift(veh);
    }
  }

  // ---------------- Пешеходы ----------------

  /** Участок проезжей части ребра в системе отсчёта движения (dir) */
  private roadSpan(edge: number, dir: 1 | -1): [number, number] {
    const e = this.net.pedEdges[edge];
    const L = e.path.length;
    return dir > 0 ? [e.roadS0, e.roadS1] : [L - e.roadS1, L - e.roadS0];
  }

  /** Позиция пешехода на пути ребра (в координатах самого ребра) */
  private pedU(p: PedAgent): number {
    const r = p.route[p.leg];
    const L = this.net.pedEdges[r.edge].path.length;
    return r.dir > 0 ? p.w : L - p.w;
  }

  private spawnPeds() {
    const st = this.st;
    if (st.peds.length >= MAX_PEDS) return;
    for (const src of this.pedSources) {
      const cfg = this.cfg.peds.sources[src.cfgIdx];
      if (!cfg || cfg.rate <= 0) continue;
      const meanSize = cfg.groups.reduce((a, g) => a + g.size * g.share, 0) / Math.max(1e-9, cfg.groups.reduce((a, g) => a + g.share, 0)) || 1;
      const key = `ped:${src.nodeId}:${src.cfgIdx}`;
      const n = this.poissonArrivals(key, cfg.rate / meanSize);
      for (let i = 0; i < n && st.peds.length < MAX_PEDS; i++) this.spawnPedGroup(src, cfg, seedRng(rngSeedFrom(this.stream('attr:' + key))));
    }
  }

  /** Новая группа пешеходов у источника. Все её случайные свойства — из собственного генератора */
  private spawnPedGroup(src: { node: number; nodeId: string; cfgIdx: number }, cfg: PedSource, pr: RngState) {
    const st = this.st;
    const dests = Object.entries(cfg.destinations).filter(([k, w]) => w > 0 && k !== src.nodeId && this.net.pedNodeById.has(k));
    if (!dests.length) return;
    const dest = pickWeighted(pr, dests);
    const key = `${src.nodeId}>${dest}`;
    const opts = this.routes.get(key);
    if (!opts || !opts.length || !opts[0].steps.length) {
      st.counters.pedRouteErrors++;
      if (!this.routeErrLogged.has(key)) {
        this.routeErrLogged.add(key);
        this.addLog('error', 'ped-route', `Пешеходы не могут попасть из «${this.pedNodeName(src.nodeId)}» в «${this.pedNodeName(dest)}»: в графе переходов нет пути.`);
      }
      return;
    }
    // из близких по длине маршрутов чаще выбирают короткий
    const route = opts.length === 1 ? opts[0].steps : pickWeighted(pr, opts.map((o) => [o.steps, Math.exp(-(o.length - opts[0].length) / 8)] as [PedRoute['steps'], number]));
    const size = cfg.groups.length ? pickWeighted(pr, cfg.groups.map((g) => [g.size, g.share] as [number, number])) : 1;
    const base = cfg.speedMin + (cfg.speedMax - cfg.speedMin) * rngNext(pr);
    const speed = base * (size >= 3 ? 0.85 : size === 2 ? 0.95 : 1);
    const p: PedAgent = {
      id: st.nextPid++, size, speed, origin: src.nodeId, dest, route, leg: 0, w: 0, waiting: false, waitTime: 0, blocked: 0,
      tSpawn: st.t, hit: false, hitUntil: 0, danger: -1e9, x: 0, y: 0, h: 0, px: 0, py: 0,
    };
    this.pedPose(p);
    p.px = p.x; p.py = p.y;
    st.peds.push(p);
    st.counters.pedSpawned += size;
  }

  private pedPose(p: PedAgent) {
    const r = p.route[p.leg];
    const e = this.net.pedEdges[r.edge];
    const u = this.pedU(p);
    const q = pointAt(e.path, Math.max(0, Math.min(e.path.length, u)));
    p.x = q.p.x;
    p.y = q.p.y;
    p.h = r.dir > 0 ? q.h : q.h + Math.PI;
  }

  /**
   * Машина, которая вот-вот проедет через точку перехода и уже не успеет остановиться
   * (или, на нерегулируемом переходе, подъедет раньше, чем через horizon секунд).
   */
  private vehicleNear(edge: number, u: number, signalled: boolean, horizon: number): boolean {
    const late = (d: number, v: number) => (signalled ? d < (v * v) / (2 * 2.5) + 1.5 : d / Math.max(v, 0.1) < horizon);
    for (const c of this.net.conns) {
      for (const x of c.crossings) {
        if (x.edge !== edge || Math.abs(x.u - u) > 6) continue;
        for (const v of this.connLists[c.idx]) {
          const d = x.s - v.s;
          if (d < -v.len - 1 || v.crashed) continue;
          if (d < 1 && v.v > 0.3) return true;
          if (v.v > 0.5 && late(d, v.v)) return true;
        }
        const f = c.conn.from;
        const L = this.net.arms[f.arm].cfg.approachLength;
        for (const v of this.laneLists[f.arm]?.[f.lane] ?? []) {
          if (v.conn !== c.idx || this.permit[c.idx] === 'none') continue;
          const d = L - v.s + x.s;
          if (v.v > 0.5 && late(d, v.v)) return true;
        }
      }
    }
    return false;
  }

  private updatePeds() {
    const st = this.st;
    const dt = this.dt;
    const done: PedAgent[] = [];
    for (const p of st.peds) {
      p.px = p.x; p.py = p.y;
      if (p.hit) continue;
      const r = p.route[p.leg];
      const e = this.net.pedEdges[r.edge];
      const L = e.path.length;
      const [r0] = this.roadSpan(r.edge, r.dir);
      let step = p.speed * dt;
      // у бордюра (или на островке) перед проезжей частью — проверяем сигнал
      if (p.w <= r0 - CURB_WAIT && p.w + step > r0 - CURB_WAIT) {
        const sig = this.pedSignal(r.edge);
        const u0 = r.dir > 0 ? e.roadS0 : e.roadS1;
        const ok = (sig === 'start' || sig === 'free') && !this.vehicleNear(r.edge, u0, sig === 'start', 4);
        if (!ok) {
          p.w = Math.max(p.w, r0 - CURB_WAIT);
          p.waiting = true;
          p.waitTime += dt;
          step = 0;
        } else p.waiting = false;
      }
      if (step > 0 && p.w >= r0 - CURB_WAIT) {
        const blk = this.vehicleAhead(p, step);
        // стоящую машину пешеходы недолго ждут, потом обходят её целиком, не останавливаясь у каждого шага
        if (blk === 'moving' || (blk === 'stopped' && p.blocked <= 4)) {
          step = 0;
          p.waitTime += dt;
          p.blocked += dt;
        } else if (!blk) p.blocked = 0;
      }
      p.w += step;
      if (p.w >= L) {
        if (p.leg + 1 < p.route.length) {
          p.leg++;
          p.w = 0;
        } else {
          done.push(p);
          continue;
        }
      }
      this.pedPose(p);
    }
    if (done.length) {
      const set = new Set(done);
      st.peds = st.peds.filter((p) => !set.has(p));
      for (const p of done) {
        st.counters.pedDone += p.size;
        st.counters.pedWaitSum += p.waitTime * p.size;
        st.recentPed.push({ t: st.t, wait: p.waitTime });
        this.pushSample(this.samples.pedWait, p.origin, p.waitTime);
      }
    }
    // пострадавшие пешеходы уходят с перехода после того, как место столкновения освобождено
    if (st.peds.some((p) => p.hit && st.t >= p.hitUntil)) st.peds = st.peds.filter((p) => !(p.hit && st.t >= p.hitUntil));
    // разбор по рёбрам для машин
    this.pedsByEdge = this.net.pedEdges.map(() => []);
    for (const p of st.peds) this.pedsByEdge[p.route[p.leg].edge].push(p);
  }

  /** Должна ли машина пропустить пешеходов в точке пересечения с переходом (ПДД 13.1, 14.1) */
  private pedBlocks(edge: number, u: number, tAhead: number): boolean {
    const list = this.pedsByEdge[edge];
    if (!list || !list.length) return false;
    const e = this.net.pedEdges[edge];
    // половина ширины машины, пешеход и запас — вдоль перехода
    const span = 2.0;
    for (const p of list) {
      const pu = this.pedU(p);
      if (p.hit) {
        if (Math.abs(u - pu) < span + 1) return true;
        continue;
      }
      const r = p.route[p.leg];
      const toward = (u - pu) * r.dir;
      const onRoad = pu > e.roadS0 + 0.05 && pu < e.roadS1 - 0.05;
      if (onRoad) {
        if (Math.abs(u - pu) < span) return true;
        if (toward > 0 && toward < p.speed * tAhead + span) return true;
        continue;
      }
      // ещё на тротуаре или островке: уступаем тем, кто идёт к переходу на разрешающий сигнал
      if (!p.waiting && toward > 0 && toward < p.speed * tAhead + span) {
        const sig = this.pedSignal(r.edge);
        if (sig === 'start' || sig === 'free') return true;
      }
    }
    return false;
  }

  // ---------------- Индексация ----------------

  private index() {
    const st = this.st;
    for (const d of this.armList) {
      this.laneLists[d] = Array.from({ length: this.net.arms[d].cfg.inLanes }, () => []);
      this.exitLists[d] = Array.from({ length: this.net.arms[d].cfg.outLanes }, () => []);
    }
    this.connLists = this.net.conns.map(() => []);
    this.bayReady = {};
    for (const v of st.vehicles) {
      // автобус, заехавший в карман, не занимает полосу, пока не начнёт выезжать.
      // Когда он готов выехать, едущие сзади его пропускают (ПДД 18.3)
      if (v.inBay && v.bayT >= 0.75) {
        if (v.dwellUntil >= 0 && st.t >= v.dwellUntil) {
          const key = v.phase === 'exit' ? `x${v.dest}:${v.outLane}` : `a${v.origin}:${v.lane}`;
          (this.bayReady[key] ??= []).push(v);
        }
        continue;
      }
      if (v.phase === 'approach') {
        this.laneLists[v.origin][v.lane]?.push(v);
        if (v.lcT >= 0 && v.lcFrom !== v.lane) this.laneLists[v.origin][v.lcFrom]?.push(v);
      } else if (v.phase === 'conn') this.connLists[v.conn].push(v);
      else this.exitLists[v.dest]?.[v.outLane]?.push(v);
    }
    const bys = (a: Vehicle, b: Vehicle) => a.s - b.s;
    for (const d of this.armList) {
      this.laneLists[d].forEach((l) => l.sort(bys));
      this.exitLists[d].forEach((l) => l.sort(bys));
    }
    this.connLists.forEach((l) => l.sort(bys));
  }

  private leaderIn(list: Vehicle[] | undefined, veh: Vehicle): Vehicle | null {
    if (!list) return null;
    let best: Vehicle | null = null;
    for (const o of list) {
      if (o === veh) continue;
      // автобус в кармане, рядом с которым мы уже едем, не помеха
      if (o.inBay && o.s - o.len < veh.s + 0.5) continue;
      // на широкой полосе у стоп-линии машины в разных рядах стоят рядом и друг другу не мешают
      if (veh.phase === 'approach' && o.phase === 'approach' && Math.abs(o.shiftNow - veh.shiftNow) >= (o.wid + veh.wid) / 2 + 0.45 && this.net.arms[veh.origin].cfg.laneWidth >= TWO_ROW_WIDTH) continue;
      // строгий порядок по положению, при равенстве — по номеру: две машины не могут быть лидерами друг друга
      if (o.s > veh.s || (o.s === veh.s && o.id < veh.id)) {
        if (!best || o.s < best.s) best = o;
      }
    }
    return best;
  }

  // ---------------- Физика ----------------

  private idm(veh: Vehicle, v0: number, gap: number, vLead: number): number {
    const v = veh.v;
    const dv = v - vLead;
    const sStar = veh.s0 + Math.max(0, v * veh.T + (v * dv) / (2 * Math.sqrt(veh.amax * veh.bcomf)));
    const g = Math.max(0.1, gap);
    return veh.amax * (1 - Math.pow(v / Math.max(0.1, v0), 4) - (sStar / g) * (sStar / g));
  }

  private timeToCover(d: number, v: number, a: number, vcap = 12): number {
    if (d <= 0) return 0;
    const v1 = Math.max(v, 0);
    const tAcc = Math.max(0, (vcap - v1) / a);
    const dAcc = v1 * tAcc + 0.5 * a * tAcc * tAcc;
    if (dAcc >= d) return (-v1 + Math.sqrt(v1 * v1 + 2 * a * d)) / a;
    return tAcc + (d - dAcc) / vcap;
  }

  /** Следующая остановка автобуса — на выезде к подходу назначения: нужна полоса у бордюра */
  /** Из этой полосы подхода автобус доедет до своей остановки: к остановке на выезде — только из полосы, связанной с полосой у бордюра */
  private busLaneOk(veh: Vehicle, lane: number): boolean {
    if (!veh.route || !this.busNeedsCurbExit(veh.route, veh.stopsLeft, veh.dest)) return true;
    const curb = this.net.arms[veh.dest].cfg.outLanes - 1;
    const opts = this.net.connFor[veh.origin][lane]?.[veh.dest] ?? [];
    if (opts.some((ci) => this.net.conns[ci].conn.to.lane === curb)) return true;
    // если такой полосы на подходе нет вовсе, едет как может
    const n = this.net.arms[veh.origin].cfg.inLanes;
    for (let i = 0; i < n; i++) if ((this.net.connFor[veh.origin][i]?.[veh.dest] ?? []).some((ci) => this.net.conns[ci].conn.to.lane === curb)) return false;
    return true;
  }

  private busNeedsCurbExit(route: string | null, stopsLeft: string[], dest: ArmId): boolean {
    if (!route || !stopsLeft.length) return false;
    const st = stopsLeft.map((id) => this.stopById(id)).find((x) => !!x);
    return !!st && st.side === 'exit' && st.arm === dest;
  }

  private connOfLane(veh: Vehicle): number {
    const opts = (this.net.connFor[veh.origin][veh.lane]?.[veh.dest] ?? []).filter((ci) => veh.route || !this.net.conns[ci].busOnly);
    if (!opts.length) return -1;
    // широкие машины и рейсовые автобусы рядов не образуют и едут по основной траектории
    const wide = veh.wid > 2.1 || !!veh.route;
    const usable = wide ? opts.filter((ci) => this.net.conns[ci].variant === 0) : opts;
    const list = usable.length ? usable : opts;
    // рейсовый автобус едет по выделенному для автобусов направлению, если оно есть
    if (veh.route) {
      const own = list.filter((ci) => this.net.conns[ci].busOnly);
      if (own.length && !this.busNeedsCurbExit(veh.route, veh.stopsLeft, veh.dest)) return own[0];
    }
    if (this.busNeedsCurbExit(veh.route, veh.stopsLeft, veh.dest)) {
      return list.reduce((b, ci) => (this.net.conns[ci].conn.to.lane > this.net.conns[b].conn.to.lane ? ci : b), list[0]);
    }
    // водитель выбирает траекторию сам. По умолчанию — случайно любую из доступных, иначе ту, где впереди свободно
    if (this.cfg.sim.trajectoryChoice === 'random' && list.length > 1) {
      const rows = list.filter((ci) => this.net.conns[ci].row);
      const pool = rows.length ? rows : list;
      return pool[Math.min(pool.length - 1, Math.floor(rngNext(veh.rng) * pool.length))];
    }
    let best = list[0], bestCost = Infinity;
    for (const ci of list) {
      const c = this.net.conns[ci];
      let cost = (this.exitLists[c.conn.to.arm]?.[c.conn.to.lane]?.length ?? 0) + this.connLists[ci].length;
      if (c.row) cost -= 2;
      else if (c.variant > 0) cost += 0.5;
      const first = this.connLists[ci][0];
      if (first && first.v < 1 && first.s - first.len < 6) cost += 8;
      for (const sb of c.siblings) for (const o of this.connLists[sb.conn]) if (o.v < 1 && o.s - o.len <= sb.until) { cost += 8; break; }
      if (cost < bestCost) { bestCost = cost; best = ci; }
    }
    return best;
  }

  /** Машину сейчас пропускает в нужную полосу водитель сзади */
  private helped(veh: Vehicle): boolean {
    if (veh.lcHelper < 0) return false;
    const h = this.st.vehicles.find((o) => o.id === veh.lcHelper);
    // пропускающий должен быть рядом: стоит сразу за задней частью машины, а не где-то в конце очереди
    if (h && h.lcYield === veh.id && this.st.t <= h.lcYieldUntil && h.s > veh.s - veh.len - 8) return true;
    veh.lcHelper = -1;
    return false;
  }

  /** Сдвиг поперёк полосы подхода, к которому стремится машина: начинается за ROW_ZONE м до стоп-линии */
  private shiftTarget(veh: Vehicle): number {
    if (veh.phase !== 'approach' || veh.conn < 0) return 0;
    const c = this.net.conns[veh.conn];
    if (!c) return 0;
    const sh = c.shiftIn || this.implicit(veh, veh.conn).sh;
    if (!sh) return 0;
    const L = this.net.arms[veh.origin].cfg.approachLength;
    const k = (veh.s - (L - ROW_ZONE)) / 10;
    return sh * Math.max(0, Math.min(1, k));
  }

  private rerouteConn(veh: Vehicle): number {
    const from = (this.net.connsFromLane[veh.origin][veh.lane] ?? []).filter((ci) => veh.route || !this.net.conns[ci].busOnly);
    if (!from.length) return -1;
    return from.find((ci) => this.net.conns[ci].kind === 'straight') ?? from[0];
  }

  private exitBlocked(ci: number, veh: Vehicle): boolean {
    const c = this.net.conns[ci];
    const list = this.exitLists[c.conn.to.arm]?.[c.conn.to.lane] ?? [];
    let avail = this.net.arms[c.conn.to.arm].cfg.exitLength;
    let moving = false;
    if (list.length) {
      const last = list[0];
      avail = last.s - last.len;
      moving = last.v > 3;
    }
    // автобус стоит на остановке в самой полосе: за ним поместятся только те, для кого хватит места до его задней части
    for (const o of list) {
      if (o.dwellUntil < 0 || o.inBay || o.v > 0.5) continue;
      let room = o.s - o.len;
      for (const x of list) if (x !== o && x.s < o.s - o.len + 0.1) room -= x.len + 2.5;
      avail = moving ? room : Math.min(avail, room);
      moving = false;
      break;
    }
    if (moving) return false;
    let demand = veh.len + 2.5;
    for (const cj of this.net.connsToLane[c.conn.to.arm][c.conn.to.lane]) {
      for (const o of this.connLists[cj]) if (o !== veh) demand += o.len + 2.5;
    }
    return demand > avail + 1;
  }

  private isTurnLeft(ci: number): boolean {
    const k = this.net.conns[ci].kind;
    return k === 'left' || k === 'uturn';
  }

  /** Кто кому уступает: true — veh (манёвр A) уступает машине o (манёвр B) */
  private yieldsTo(veh: Vehicle, A: number, o: Vehicle, B: number): boolean {
    // нарушитель, едущий по запрещённому манёвру, уступает всем
    if (this.net.conns[A].illegal && !this.net.conns[B].illegal) return true;
    if (this.net.conns[B].illegal && !this.net.conns[A].illegal) return false;
    const meIn = veh.phase === 'conn';
    const themIn = o.phase === 'conn';
    const meClearing = meIn && this.permit[A] === 'none';
    const themClearing = themIn && this.permit[B] === 'none';
    if (themClearing && !meClearing) return true;
    if (meClearing && !themClearing) return false;
    const pa = this.permit[A] !== 'none' ? this.permit[A] : veh.entryPermit;
    const pb = this.permit[B] !== 'none' ? this.permit[B] : o.entryPermit;
    if (pa === 'arrow' && pb !== 'arrow') return true;
    if (pb === 'arrow' && pa !== 'arrow') return false;
    const ta = this.isTurnLeft(A), tb = this.isTurnLeft(B);
    const fa = this.net.conns[A].conn.from.arm, fb = this.net.conns[B].conn.from.arm;
    if (ta && !tb && this.rel.opposite[fa] === fb) return true;
    if (!ta && tb && this.rel.opposite[fb] === fa) return false;
    if (ta && !tb) return true;
    if (!ta && tb) return false;
    if (this.rel.onRight[fa] === fb) return true;
    if (this.rel.onRight[fb] === fa) return false;
    return veh.id > o.id;
  }

  private leftWaiting(arm: ArmId | null, exclude: Vehicle): boolean {
    if (!arm) return false;
    for (const c of this.net.conns) {
      if (c.conn.from.arm !== arm || !this.isTurnLeft(c.idx)) continue;
      for (const o of this.connLists[c.idx]) if (o !== exclude && o.v < 2 && o.s > 1) return true;
    }
    return false;
  }

  private obstructed(veh: Vehicle, A: number): boolean {
    if (!this.isTurnLeft(A)) return false;
    return this.leftWaiting(this.rel.opposite[this.net.conns[A].conn.from.arm], veh);
  }

  /** Взаимное перекрытие обзора стоящими в перекрёстке левоповоротниками */
  private occluded(veh: Vehicle, A: number, B: number): boolean {
    const ca = this.net.conns[A], cb = this.net.conns[B];
    if (cb.conn.from.arm !== this.rel.opposite[ca.conn.from.arm]) return false;
    const ta = this.isTurnLeft(A), tb = this.isTurnLeft(B);
    if (ta && !tb) return this.leftWaiting(cb.conn.from.arm, veh);
    if (!ta && tb) return this.leftWaiting(ca.conn.from.arm, veh);
    return false;
  }

  private mustWait(veh: Vehicle, A: number, cr: ConflictRef, dStart: number, dEnd: number): boolean {
    const cf = this.net.conflicts[cr.conflict];
    const B = cr.other;
    const bStart = cr.side === 'a' ? cf.bStart : cf.aStart;
    const bEnd = cr.side === 'a' ? cf.bEnd : cf.aEnd;
    const sim = this.cfg.sim;
    this.blocker = -1;
    if (dStart < (veh.v * veh.v) / (2 * B_MAX) + 0.3) return false;
    if (cf.same) {
      // траектории из одной полосы: уступаем только тем, кто въехал раньше. Ехавшие сзади ждут нас
      for (const o of this.connLists[B]) {
        if (o === veh || o.crashed || o.s >= bEnd + o.len) continue;
        if (veh.phase === 'conn' && o.tStop > veh.tStop) continue;
        this.blocker = o.id;
        return true;
      }
      return false;
    }
    // давно стоит в перекрёстке: правила очерёдности уже не помогают, водитель выезжает,
    // но не въезжает в машину, которая физически в зоне конфликта или вот-вот в неё въедет
    const brk = this.cfg.sim.deadlockBreak;
    const stuck = brk > 0 && veh.phase === 'conn' && veh.stuckSince >= 0 && this.st.t - veh.stuckSince > brk;
    // стоящий водитель тронется только через своё время реакции
    const lag = veh.v < 0.3 ? veh.reaction : 0;
    const myClear = this.timeToCover(dEnd + veh.len, veh.v, Math.max(1.2, veh.amax), 9) + lag;
    const myArrive = this.timeToCover(dStart, veh.v, Math.max(1.2, veh.amax), 9) + lag;
    const crit = this.isTurnLeft(A) ? sim.criticalGapLeft : sim.criticalGapOther;
    const obstr = this.obstructed(veh, A);
    const fromB = this.net.conns[B].conn.from;
    const oncoming = fromB.arm === this.rel.opposite[this.net.conns[A].conn.from.arm];
    const occl = this.occluded(veh, A, B);
    const vis = sim.obstructedVisibility;
    const sees = (dB: number) => (occl ? dStart <= vis && dB <= vis : dB <= sim.normalVisibility);

    if (stuck) {
      for (const o of this.connLists[B]) {
        if (o === veh || o.s >= bEnd + o.len) continue;
        // в зоне конфликта или у её края стоит другая машина: проверяем по габаритам, хватит ли места проехать мимо неё
        if (o.s > bStart - 6 && this.pathHits(veh, A, dEnd + veh.len, o)) { this.blocker = o.id; return true; }
        if (o.s > bStart) continue;
        const moving = o.v > 0.5;
        if (moving && this.timeToCover(bStart - o.s, o.v, 1.5, Math.max(o.v, 9)) < myClear + 0.5) { this.blocker = o.id; return true; }
      }
      return false;
    }
    if (obstr && oncoming && !veh.risky) {
      const pB = this.permit[B];
      if (pB !== 'none' || this.st.t - this.st.permitEnd[B] < 3) {
        if (this.yieldsToMovement(veh, A, B)) { this.blocker = -2; return true; }
      }
    }
    for (const o of this.connLists[B]) {
      if (o.s >= bEnd + o.len) continue;
      if (o.crashed) continue;
      const dB = bStart - o.s;
      if (!sees(Math.max(0, dB))) continue;
      if (o.s > bStart) {
        if (occl) this.lateSight = true;
        this.blocker = o.id;
        return true;
      }
      if (o.yieldingAt === cf.id && o.v < 0.5 && veh.yieldingAt !== cf.id) continue;
      if (o.yieldingAt === cf.id && veh.yieldingAt === cf.id && o.v < 0.5 && veh.v < 0.5 && veh.id < o.id) continue;
      // ПДД 13.8: тем, кто завершает манёвр после смены сигнала, уступаем, даже если они сейчас стоят.
      // Иначе въехавшие на новый сигнал перекрывают им путь и перекрёсток запирается целиком
      if (o.phase === 'conn' && this.permit[B] === 'none' && !(veh.phase === 'conn' && this.permit[A] === 'none') && this.yieldsTo(veh, A, o, B)) {
        this.blocker = o.id;
        return true;
      }
      // стоит в перекрёстке за другой стоящей машиной и до зоны ещё не доехал: пока впереди не тронутся, помехи нет.
      // Иначе два встречных поворота налево ждут машины, которые сами стоят за ними
      const queued = o.v < 0.3 && (o.why === 'leader' || o.why === 'merge') && this.vehStopped(o.whyId);
      if (queued && o.s < bStart - 1 && !(o.s > bStart - 4 && this.sweepHits(veh, A, cr.start, cr.end + veh.len, o))) continue;
      const held = o.v < 0.3 && o.a < 0.2;
      // стоящая у самой зоны машина может задевать траекторию кузовом: проверяем по габаритам
      if (held && o.s > bStart - 4 && this.sweepHits(veh, A, cr.start, cr.end + veh.len, o)) { this.blocker = o.id; return true; }
      const eta = held ? Infinity : this.timeToCover(dB, o.v, 1.5, Math.max(o.v, 9));
      if (this.yieldsTo(veh, A, o, B)) {
        if (eta < Math.max(crit, myClear + 1.0)) { this.blocker = o.id; return true; }
      } else if (eta < myArrive + 0.8 && o.phase === 'conn' && o.v > 2) {
        if (occl) this.lateSight = true;
        this.blocker = o.id;
        return true;
      }
    }
    const lane = this.laneLists[fromB.arm]?.[fromB.lane] ?? [];
    const L = this.net.arms[fromB.arm].cfg.approachLength;
    for (let i = lane.length - 1; i >= 0; i--) {
      const o = lane[i];
      if (o.conn !== B && !(o.conn < 0 && this.net.connFor[fromB.arm][fromB.lane]?.[o.dest]?.includes(B))) continue;
      const pB = this.permit[B];
      const goesOnYellow = this.yellowMain[B] && o.yellowDecision === 1;
      if (pB === 'none' && !goesOnYellow) continue;
      const dB = L - o.s + bStart;
      if (dB > 150) break;
      if (!sees(dB)) continue;
      // машина стоит за другой, которая тоже стоит: пока они не тронутся, помехи нет
      if (o.v < 0.3 && (o.why === 'leader' || o.why === 'merge') && this.vehStopped(o.whyId)) continue;
      if (!this.yieldsTo(veh, A, o, B)) {
        // очередь за нами, но машина на подходе уже не успевает остановиться у стоп-линии: наперерез не выезжаем, ПДД 10.1
        if (o.v > 3 && L - o.s < (o.v * o.v) / (2 * 4.0) + 1 && this.timeToCover(dB, o.v, 1.5, Math.max(o.v, 9)) < myClear + 1.0) { this.blocker = o.id; return true; }
        continue;
      }
      const eta = this.timeToCover(dB, o.v, 1.5, Math.max(o.v, 9));
      if (eta < Math.max(crit, myClear + 1.0)) { this.blocker = o.id; return true; }
    }
    return false;
  }

  /**
   * Не въезжать в зону конфликта, если в перекрёстке есть машины встречного по этой зоне манёвра,
   * а сразу за зоной придётся остановиться и уступить: иначе машина встанет у них на пути, ПДД 13.2
   */
  private wouldStopInside(veh: Vehicle, ci: number, cr: ConflictRef, offset: number): boolean {
    // слияние траекторий из одной полосы — обычное следование, встать в нём поперёк чужого пути нельзя
    if (this.net.conflicts[cr.conflict].same) return false;
    if (!this.connLists[cr.other].some((o) => o !== veh && !o.crashed)) return false;
    const brk = this.cfg.sim.deadlockBreak;
    if (brk > 0 && veh.phase === 'conn' && veh.stuckSince >= 0 && this.st.t - veh.stuckSince > brk) return false;
    for (const c2 of this.net.conns[ci].conflicts) {
      if (c2 === cr || c2.start <= cr.start || c2.start > cr.end + veh.len + 0.5) continue;
      if (veh.committed.includes(c2.conflict)) continue;
      if (this.mustWait(veh, ci, c2, offset + c2.start, offset + c2.end)) return true;
    }
    return false;
  }

  private vehStopped(id: number): boolean {
    if (id < 0) return false;
    const o = this.st.vehicles.find((x) => x.id === id);
    return !!o && o.v < 0.5 && o.why !== 'free';
  }

  /** В зону конфликта уже въезжает или вот-вот въедет машина другого манёвра */
  private othersEntering(veh: Vehicle, cr: ConflictRef): boolean {
    const cf = this.net.conflicts[cr.conflict];
    const bStart = cr.side === 'a' ? cf.bStart : cf.aStart;
    const bEnd = cr.side === 'a' ? cf.bEnd : cf.aEnd;
    const myClear = this.timeToCover(cr.end + veh.len - veh.s, veh.v, Math.max(1.2, veh.amax), 9);
    for (const o of this.connLists[cr.other]) {
      if (o === veh || o.crashed || o.s >= bEnd + o.len) continue;
      if (cf.same && o.tStop > veh.tStop) continue;
      if (o.s > bStart) {
        if (o.v > 0.5 || this.firstHit(veh, veh.conn, veh.s + 0.3, cr.end + veh.len, o) < Infinity) return true;
        continue;
      }
      if (o.v > 0.5 && this.timeToCover(bStart - o.s, o.v, 1.5, Math.max(o.v, 9)) < myClear + 0.5) return true;
    }
    return false;
  }

  /** В зоне конфликта на другом манёвре стоит или едва ползёт машина */
  private zoneHeld(veh: Vehicle, cr: ConflictRef): boolean {
    const cf = this.net.conflicts[cr.conflict];
    const bStart = cr.side === 'a' ? cf.bStart : cf.aStart;
    const bEnd = cr.side === 'a' ? cf.bEnd : cf.aEnd;
    for (const o of this.connLists[cr.other]) {
      if (o === veh || o.v > 2) continue;
      if (o.s > bStart && o.s - o.len < bEnd) return true;
    }
    return false;
  }

  /** Заденет ли машина габаритом другую, если продвинется по своему манёвру ещё на ahead метров */
  private pathHits(veh: Vehicle, ci: number, ahead: number, o: Vehicle): boolean {
    return this.sweepHits(veh, ci, veh.s + 0.5, veh.s + ahead, o);
  }

  /** Заденет ли машина другую, если её передок пройдёт по манёвру ci от f0 до f1 (координаты манёвра) */
  private sweepHits(veh: Vehicle, ci: number, f0: number, f1: number, o: Vehicle): boolean {
    return this.firstHit(veh, ci, f0, f1, o) < Infinity;
  }

  /** Первое положение передка на манёвре ci между f0 и f1, при котором машина задевает другую */
  private firstHit(veh: Vehicle, ci: number, f0: number, f1: number, o: Vehicle): number {
    const path = this.net.conns[ci].path;
    const ob = this.obbOf(o);
    ob.hw += 0.3;
    ob.hl += 0.3;
    for (let f = Math.max(0, f0); f <= Math.min(f1, path.length + veh.len * 0.85); f += 0.75) {
      const a = pointAt(path, Math.min(path.length, Math.max(0, f - veh.len * 0.15)));
      const b = pointAt(path, Math.min(path.length, Math.max(0, f - veh.len * 0.85)));
      const hx = a.p.x - b.p.x, hy = a.p.y - b.p.y;
      const h = hx * hx + hy * hy > 1e-4 ? Math.atan2(hy, hx) : a.h;
      if (obbOverlap({ cx: (a.p.x + b.p.x) / 2, cy: (a.p.y + b.p.y) / 2, hl: veh.len / 2, hw: veh.wid / 2, h }, ob)) return f;
    }
    return Infinity;
  }

  private yieldsToMovement(veh: Vehicle, A: number, B: number): boolean {
    const pa = veh.phase === 'conn' ? veh.entryPermit : this.permit[A];
    if (pa === 'arrow') return true;
    return this.isTurnLeft(A) && !this.isTurnLeft(B);
  }

  private crashBlock(ci: number): number {
    let best = Infinity;
    for (const c of this.st.crashes) for (const b of c.blocks) if (b.conn === ci) best = Math.min(best, b.s);
    return best;
  }

  private v0Ahead(veh: Vehicle, ci: number, offset: number, v0: number): number {
    let lim = v0;
    for (const p of this.curveLimits[ci]) {
      const d = p.s + offset;
      if (d < -2) continue;
      if (d > 60) break;
      lim = Math.min(lim, Math.sqrt(p.v * p.v + 2 * veh.bcomf * Math.max(0, d)));
    }
    return Math.max(2, lim);
  }

  /** Ограничения от пешеходов на манёвре ci: offset — расстояние от передка машины до начала манёвра */
  private pedConstraint(veh: Vehicle, ci: number, offset: number, take: (gap: number, v: number, why: Why, who?: number) => void) {
    for (const x of this.net.conns[ci].crossings) {
      const w = this.net.pedEdges[x.edge].width;
      const front = offset + x.s;
      if (front < -(w / 2 + 0.5)) continue;
      if (front - w / 2 > 50) break;
      const d = front - (w / 2 + 1.2);
      // уже не успевает остановиться перед переходом — проезжает
      if (d > 0 && d < (veh.v * veh.v) / (2 * B_MAX)) continue;
      if (this.pedBlocks(x.edge, x.u, (Math.max(0, d) + 3) / Math.max(veh.v, 3))) take(Math.max(0.2, d), 0, 'ped');
    }
  }

  /** Пешеход на проезжей части: между бордюрами или островками своего перехода */
  private pedOnRoad(p: PedAgent): boolean {
    const e = this.net.pedEdges[p.route[p.leg].edge];
    const pu = this.pedU(p);
    return pu > e.roadS0 + 0.05 && pu < e.roadS1 - 0.05;
  }

  /** Пешеходы прямо перед машиной или рядом с её передком: машина не трогается и тормозит, ПДД 14.1 и 10.1 */
  private pedFront(veh: Vehicle, take: (gap: number, v: number, why: Why, who?: number) => void) {
    if (veh.crashed || !this.st.peds.length) return;
    const c = Math.cos(veh.h), sn = Math.sin(veh.h);
    const reach = veh.len / 2 + 2.5 + veh.v * 1.2;
    for (const p of this.st.peds) {
      const dx = p.x - veh.x, dy = p.y - veh.y;
      if (Math.abs(dx) > reach + 2 || Math.abs(dy) > reach + 2) continue;
      const lon = dx * c + dy * sn, lat = -dx * sn + dy * c;
      const half = 0.28 + 0.32 * (p.size - 1);
      if (lon + half < -veh.len / 2 + 0.5 || lon - half > reach) continue;
      if (Math.abs(lat) > veh.wid / 2 + half + 0.4) continue;
      if (!p.hit && !this.pedOnRoad(p)) continue;
      take(Math.max(0, lon - half - veh.len / 2 - 0.8), 0, 'ped', -1);
    }
  }

  /** Пешеход не шагает под движущуюся машину и не идёт сквозь стоящую: смотрим чуть вперёд по ходу */
  private vehicleAhead(p: PedAgent, step: number): 'moving' | 'stopped' | null {
    const ahead = step + 0.8;
    const box: OBB = { ...this.pedObb(p), cx: p.x + Math.cos(p.h) * ahead, cy: p.y + Math.sin(p.h) * ahead };
    let res: 'stopped' | null = null;
    for (const v of this.st.vehicles) {
      if (Math.abs(v.x - p.x) > 12 || Math.abs(v.y - p.y) > 12) continue;
      const moving = v.v >= 0.8 && !v.crashed;
      const vb = this.obbOf(v, moving ? 0.6 : 0);
      vb.hw += moving ? 0.3 : 0.15;
      if (obbOverlap(vb, box)) {
        if (moving) return 'moving';
        res = 'stopped';
      }
    }
    return res;
  }

  /** Остановка автобуса впереди на текущем участке: позиция передка для остановки */
  private busStopAhead(veh: Vehicle): { stop: BusStop; s: number } | null {
    if (!veh.route || !veh.stopsLeft.length) return null;
    const stop = this.stopById(veh.stopsLeft[0]);
    if (!stop) return null;
    let s = -1;
    if (veh.phase === 'approach' && stop.side === 'approach' && stop.arm === veh.origin) {
      if (veh.lane !== this.net.arms[veh.origin].cfg.inLanes - 1) return null;
      s = this.net.arms[veh.origin].cfg.approachLength - stop.dist;
    } else if (veh.phase === 'exit' && stop.side === 'exit' && stop.arm === veh.dest) s = stop.dist + veh.len;
    else return null;
    // если на остановке уже стоит автобус, встаём за ним
    for (const o of this.st.vehicles) {
      if (o === veh || !o.route || o.dwellUntil < 0 || o.stopsLeft[0] !== stop.id || o.phase !== veh.phase) continue;
      if (o.s > veh.s - 0.5 && o.s - o.len - 1 < s) s = o.s - o.len - 1;
    }
    return { stop, s };
  }

  /** Не успел занять нужную полосу до сплошной: по ПДД едет по направлению, разрешённому из своей полосы */
  private resolveMissedLane(veh: Vehicle, allowSolid: boolean) {
    const st = this.st;
    const reach = this.net.reachable[veh.origin][veh.lane] ?? [];
    if (!reach.length) return;
    if (allowSolid && veh.viol.solid && !veh.solidCross && this.net.reachable[veh.origin][veh.targetLane]?.includes(veh.dest)) {
      veh.solidCross = true;
      return;
    }
    const ill = this.net.illegalFor[veh.origin]?.[veh.lane]?.[veh.dest];
    if (veh.viol.turn && ill !== undefined) {
      veh.illegal = true;
      veh.conn = ill;
      return;
    }
    const want = this.cfg.arms.find((a) => a.id === veh.dest);
    let best = reach[0], bd = Infinity;
    for (const r of reach) {
      const a = this.cfg.arms.find((x) => x.id === r);
      if (!a || !want) continue;
      const d = Math.abs(((a.angle - want.angle + 540) % 360) - 180);
      if (d < bd) { bd = d; best = r; }
    }
    veh.origDest = veh.origDest ?? veh.dest;
    veh.dest = best;
    veh.targetLane = veh.lane;
    veh.wrongLane = false;
    veh.solidCross = false;
    veh.conn = -1;
    st.counters.missedTurns++;
    this.addLog('info', 'missed-turn', `Машина #${veh.id} не успела занять полосу на «${this.armName(veh.origDest)}» до сплошной и поехала на «${this.armName(best)}», как разрешено из её полосы`, undefined, veh.id);
  }

  private accel(veh: Vehicle): number {
    veh.why = 'free';
    veh.whyId = -1;
    if (veh.crashed) { veh.why = 'crash'; return 0; }
    const st = this.st;
    const sim = this.cfg.sim;
    // рейсовый автобус стоит на остановке
    if (veh.dwellUntil >= 0) {
      veh.why = 'bus';
      if (st.t < veh.dwellUntil) return 0;
      if (veh.inBay && !this.canLeaveBay(veh)) return 0;
      veh.dwellUntil = -1;
      veh.inBay = false;
      veh.bayShift = 0;
      veh.stopsLeft.shift();
      if (veh.phase === 'approach') {
        const lanes = this.net.reachableBus[veh.origin].map((r, i) => (r.includes(veh.dest) ? i : -1)).filter((i) => i >= 0);
        if (lanes.length && !lanes.includes(veh.lane)) veh.targetLane = lanes[lanes.length - 1];
      }
    }
    const arm = this.net.arms[veh.origin];
    let v0 = (arm.cfg.speedLimit / 3.6) * veh.v0f;
    let a = Infinity;
    const take = (gap: number, vLead: number, why: Why = 'leader', who = -1) => {
      const acc = this.idm(veh, v0, gap, vLead);
      if (acc < a) { a = acc; veh.why = why; veh.whyId = who; }
    };
    veh.yieldingAt = -1;
    veh.yieldTo = -1;
    this.pedFront(veh, take);

    if (veh.phase === 'approach') {
      const L = arm.cfg.approachLength;
      const dStop = L - veh.s;
      const rmap = veh.route ? this.net.reachableBus : this.net.reachable;
      let canReach = !!rmap[veh.origin][veh.lane]?.includes(veh.dest);
      const reachTarget = !!rmap[veh.origin][veh.targetLane]?.includes(veh.dest);
      // начало сплошной: перестраиваться дальше нельзя (разметка 1.1)
      if (!canReach && veh.lcT < 0 && !veh.illegal && !(veh.route && this.busStopAhead(veh))) {
        const atSolid = veh.s >= arm.lcS - 3.5;
        const waited = veh.lcWaitSince >= 0 ? st.t - veh.lcWaitSince : 0;
        // если водитель сзади в нужной полосе уже пропускает и впереди в ней есть место, стоит пару секунд подождать
        const patience = Math.max(sim.missedTurn === 'wait' ? sim.lcPatience : 0, this.helped(veh) ? 3 : 0);
        if (veh.solidCross) {
          if (dStop < 8) { veh.solidCross = false; this.resolveMissedLane(veh, false); }
        } else if ((atSolid && waited >= patience) || veh.s > arm.lcS + 0.5 || !reachTarget) this.resolveMissedLane(veh, true);
        canReach = !!rmap[veh.origin][veh.lane]?.includes(veh.dest);
      }
      if (veh.conn < 0 && veh.lcT < 0 && dStop < 70 && canReach) veh.conn = this.connOfLane(veh);
      if (veh.conn >= 0) v0 = Math.min(v0, this.v0Ahead(veh, veh.conn, dStop, v0));
      const lead = this.leaderIn(this.laneLists[veh.origin][veh.lane], veh);
      if (lead) take(lead.s - lead.len - veh.s, lead.v, 'leader', lead.id);
      this.yieldToBay(veh, `a${veh.origin}:${veh.lane}`, take);
      // пропускаем машину из соседней полосы: держимся позади её задней части, пока она не перестроится
      if (veh.lcYield >= 0) {
        const m = st.vehicles.find((o) => o.id === veh.lcYield);
        if (!m || st.t > veh.lcYieldUntil || m.phase !== 'approach' || m.lane === veh.lane || m.lcT >= 0 || m.s < veh.s + 0.5 || m.s - m.len - veh.s > 10) veh.lcYield = -1;
        else {
          // держать место есть смысл, только если впереди перестраивающейся машины в этой полосе уже есть место или очередь тронулась
          let ahead: Vehicle | null = null;
          for (const o of this.laneLists[veh.origin][veh.lane] ?? []) if (o !== veh && o.s - o.len > m.s - 0.5 && (!ahead || o.s < ahead.s)) ahead = o;
          if (!ahead || ahead.s - ahead.len - m.s > m.s0 || ahead.v > 1) take(m.s - m.len - veh.s - 0.8, 0, 'lc', m.id);
        }
      }
      if (veh.lcT >= 0 && veh.lcFrom !== veh.lane) {
        const lead2 = this.leaderIn(this.laneLists[veh.origin][veh.lcFrom], veh);
        if (lead2) take(lead2.s - lead2.len - veh.s, lead2.v, 'leader', lead2.id);
      }
      if (!lead && veh.conn >= 0 && dStop < 80) {
        let best: { gap: number; v: number; id: number } | null = null;
        const own = this.connLists[veh.conn][0];
        if (own) best = { gap: dStop + own.s - own.len, v: own.v, id: own.id };
        for (const sb of this.net.conns[veh.conn].siblings) {
          for (const o of this.connLists[sb.conn]) {
            if (o.s - o.len > sb.until) break;
            const g = dStop + o.s - o.len;
            if (!best || g < best.gap) best = { gap: g, v: o.v, id: o.id };
            break;
          }
        }
        if (!best && this.connLists[veh.conn].length === 0) {
          const c = this.net.conns[veh.conn];
          const ex = this.exitLists[c.conn.to.arm]?.[c.conn.to.lane]?.[0];
          if (ex) best = { gap: dStop + c.path.length + ex.s - ex.len, v: ex.v, id: ex.id };
        }
        if (best) {
          take(best.gap, best.v, 'merge', best.id);
          // ПДД 13.2: не выезжать на перекрёсток, если впереди затор и придётся встать в зоне пересечения траекторий
          if (best.v < 1.5 && dStop < 25 && this.permit[veh.conn] !== 'none') {
            const f = best.gap - dStop - veh.s0;
            if (f < this.net.conns[veh.conn].path.length + 2 && this.net.conns[veh.conn].conflicts.some((cr) => cr.start < f && cr.end > f - veh.len)) {
              take(dStop - 0.8, 0, 'leader', best.id);
            }
          }
        }
      }
      // нужной полосе мешает очередь: водитель не обгоняет её хвост по соседней полосе, а встаёт за ним и перестраивается
      if (!canReach && reachTarget && veh.lcT < 0 && veh.s < arm.lcS) {
        const tl = veh.lane + Math.sign(veh.targetLane - veh.lane);
        let tail: Vehicle | null = null, beside = false;
        for (const o of this.laneLists[veh.origin][tl] ?? []) {
          if (o === veh) continue;
          if (o.s > veh.s - veh.len && o.s - o.len < veh.s) beside = true;
          if (o.s - o.len > veh.s - 0.5 && o.v < 1 && (!tail || o.s < tail.s)) tail = o;
        }
        if (tail && !beside && tail.s - tail.len - veh.s < 25 && arm.lcS - veh.s < 45) take(tail.s - tail.len - veh.s - 2.5, tail.v, 'lc', tail.id);
        // рядом в нужной полосе едет машина, которая чуть впереди: пропускаем её и встаём за ней
        if (arm.lcS - veh.s < 60) {
          for (const o of this.laneLists[veh.origin][tl] ?? []) {
            if (o === veh || o.s < veh.s || o.s - o.len > veh.s + 4 || o.v < 1) continue;
            take(o.s - o.len - veh.s - 2.2, 0, 'lc', o.id);
          }
        }
      }
      // рейсовый автобус ждёт окна перед сплошной, чтобы попасть в полосу к своей остановке, но не дольше BUS_LC_PATIENCE
      if (canReach && veh.route && veh.lcT < 0 && veh.s < arm.lcS && veh.lane !== veh.targetLane && !this.busLaneOk(veh, veh.lane)) {
        const waited = veh.lcWaitSince >= 0 ? st.t - veh.lcWaitSince : 0;
        if (waited < BUS_LC_PATIENCE) {
          take(arm.lcS - veh.s - 0.5, 0, 'lc');
          if (veh.v < 0.3 && arm.lcS - veh.s < 3 && veh.lcWaitSince < 0) veh.lcWaitSince = st.t;
        }
      }
      // ожидание окна перед сплошной: разрешено ПДД, но не дольше заданного терпения
      if (!canReach && reachTarget && veh.lcT < 0 && veh.s < arm.lcS && (sim.missedTurn === 'wait' || this.helped(veh))) {
        take(arm.lcS - veh.s - 0.5, 0, 'lc');
        if (veh.v < 0.3 && arm.lcS - veh.s < 3 && veh.lcWaitSince < 0) {
          veh.lcWaitSince = st.t;
          st.counters.forcedLC++;
        }
      }
      const bs = this.busStopAhead(veh);
      if (bs && bs.s > veh.s - 0.5) take(bs.s - veh.s + veh.s0, 0, 'bus');
      if (veh.conn >= 0) {
        const pm = this.permit[veh.conn];
        if (pm === 'none') {
          let stop = true;
          if (this.yellowMain[veh.conn]) {
            if (veh.yellowDecision === 0) {
              // на жёлтый останавливается тот, кому до стоп-линии больше полутора секунд и хватает торможения не резче 3 м/с².
              // Едущие плотно за проезжающей машиной обычно тоже проезжают
              const close = !!lead && lead.v > 3 && lead.s - lead.len - veh.s < veh.v * 1.5;
              const canStop = dStop - 1 > (veh.v * veh.v) / (2 * 3.0) && dStop > veh.v * (close ? 2.0 : 1.5);
              veh.yellowDecision = !canStop || (veh.viol.red && dStop < veh.v * 3) ? 1 : 2;
            }
            stop = veh.yellowDecision === 2;
          } else if (veh.yellowDecision === 1 && dStop < 2) stop = false;
          else if (dStop < (veh.v * veh.v) / (2 * B_MAX)) stop = false;
          else if (veh.viol.red && st.t - st.permitEnd[veh.conn] < 2.5 && veh.v > 4 && dStop < veh.v * 2.5) stop = false;
          if (stop) take(dStop - 0.8 + veh.overStopDist, 0, 'signal');
        } else {
          veh.yellowDecision = 0;
          if (dStop < 25 && this.exitBlocked(veh.conn, veh)) {
            const c = this.net.conns[veh.conn];
            take(dStop - 0.8, 0, 'exit', this.exitLists[c.conn.to.arm]?.[c.conn.to.lane]?.[0]?.id ?? -1);
          }
        }
        if (dStop < 70 && (pm !== 'none' || veh.yellowDecision === 1)) {
          for (const cr of this.net.conns[veh.conn].conflicts) {
            if (veh.committed.includes(cr.conflict)) {
              // даже после решения проехать не въезжаем в стоящую в зоне машину
              if (this.zoneHeld(veh, cr)) { take(dStop + cr.start - 0.8, 0, 'yield', cr.conflict); break; }
              continue;
            }
            const ds = dStop + cr.start, de = dStop + cr.end;
            this.lateSight = false;
            if (this.mustWait(veh, veh.conn, cr, ds, de) || this.wouldStopInside(veh, veh.conn, cr, dStop)) {
              veh.yieldingAt = cr.conflict;
              veh.yieldTo = this.blocker;
              take(ds - 1.0 - (this.lateSight ? veh.v * REACTION : 0), 0, 'yield', cr.conflict);
              break;
            } else if (ds < (veh.v * veh.v) / (2 * veh.bcomf) + 2) veh.committed.push(cr.conflict);
          }
        }
        this.pedConstraint(veh, veh.conn, dStop, take);
        const cb = this.crashBlock(veh.conn);
        if (cb < Infinity) take(dStop + cb, 0, 'crash');
      } else if (!canReach && dStop < 30) {
        // направление ещё не выбрано — не выезжать за стоп-линию
        take(dStop - 0.8, 0, 'lc');
      }
    } else if (veh.phase === 'conn') {
      const c = this.net.conns[veh.conn];
      v0 = Math.min(v0, this.v0Ahead(veh, veh.conn, -veh.s, v0));
      // нарушитель остановился за стоп-линией и ждёт разрешающего сигнала
      if (veh.overStop) {
        if (this.permit[veh.conn] === 'none') take(veh.overStopDist - 0.8 - veh.s, 0, 'signal');
        else { veh.overStop = false; veh.entryPermit = this.permit[veh.conn]; }
      }
      const lead = this.leaderIn(this.connLists[veh.conn], veh);
      if (lead) take(lead.s - lead.len - veh.s, lead.v, 'leader', lead.id);
      else {
        const ex = this.exitLists[c.conn.to.arm]?.[c.conn.to.lane]?.[0];
        if (ex) take(c.path.length - veh.s + ex.s - ex.len, ex.v, 'exit', ex.id);
      }
      if (veh.s < Math.max(0, ...c.siblings.map((x) => x.until))) {
        for (const sb of c.siblings) {
          if (veh.s > sb.until) continue;
          for (const o of this.connLists[sb.conn]) {
            if (o.s <= veh.s) continue;
            if (o.s - o.len > sb.until) break;
            take(o.s - o.len - veh.s, o.v, 'merge', o.id);
            break;
          }
        }
      }
      // слияние в одну полосу выезда: кто ближе к концу манёвра, тот впереди
      const myRem = c.path.length - veh.s;
      for (const cr of c.conflicts) {
        const cf = this.net.conflicts[cr.conflict];
        if (cf.kind !== 'merge') continue;
        const bStart = cr.side === 'a' ? cf.bStart : cf.aStart;
        const lenB = this.net.conns[cr.other].path.length;
        for (const o of this.connLists[cr.other]) {
          if (o === veh || o.s < bStart) continue;
          const oRem = lenB - o.s;
          if (oRem < myRem) take(myRem - oRem - o.len, o.v, 'merge', o.id);
        }
      }
      // выбирается из неразрешимой блокировки: в модели водители разъезжаются вручную
      const ghost = veh.ghostUntil > st.t;
      for (const cr of ghost ? [] : c.conflicts) {
        if (cr.end + veh.len < veh.s) continue;
        if (veh.committed.includes(cr.conflict)) {
          if (cr.start - veh.s > 0.5 && this.zoneHeld(veh, cr)) { take(cr.start - veh.s - 0.8, 0, 'yield', cr.conflict); break; }
          // уже в зоне: стоящую впереди поперёк пути машину объезжать некуда, ждём
          let hit = Infinity;
          for (const o of this.connLists[cr.other]) {
            if (o === veh || o.v > 2 || o.crashed) continue;
            hit = Math.min(hit, this.firstHit(veh, veh.conn, veh.s + 0.3, Math.min(veh.s + 8, cr.end + veh.len), o));
          }
          if (hit < Infinity) { take(Math.max(0, hit - veh.s - 0.6), 0, 'yield', cr.conflict); break; }
          // стоит у края зоны и собирается тронуться: пропускает тех, кто уже въезжает в зону
          if (veh.v < 1 && cr.start - veh.s > -0.5 && this.othersEntering(veh, cr)) { take(Math.max(0, cr.start - veh.s - 0.3), 0, 'yield', cr.conflict); break; }
          continue;
        }
        const ds = cr.start - veh.s, de = cr.end - veh.s;
        if (ds <= 0.2) { veh.committed.push(cr.conflict); continue; }
        this.lateSight = false;
        if (this.mustWait(veh, veh.conn, cr, ds, de) || this.wouldStopInside(veh, veh.conn, cr, -veh.s)) {
          veh.yieldingAt = cr.conflict;
          veh.yieldTo = this.blocker;
          take(ds - 1.0 - (this.lateSight ? veh.v * REACTION : 0), 0, 'yield', cr.conflict);
          break;
        } else if (ds < (veh.v * veh.v) / (2 * veh.bcomf) + 1.5) veh.committed.push(cr.conflict);
      }
      this.pedConstraint(veh, veh.conn, -veh.s, take);
      const cb = this.crashBlock(veh.conn);
      if (cb < Infinity && cb > veh.s) take(cb - veh.s, 0, 'crash');
      // заехавший за стоп-линию и ждущий сигнала не застрял в перекрёстке
      if (veh.v < 0.1 && (veh.why as Why) !== 'signal') {
        if (veh.stuckSince < 0) veh.stuckSince = st.t;
        if (!veh.gridlockLogged && st.t - veh.stuckSince > 45) {
          veh.gridlockLogged = true;
          st.counters.gridlock++;
          this.addLog('warn', 'gridlock', `Машина #${veh.id}, ${this.armName(veh.origin)} → ${this.armName(veh.dest)}, стоит в перекрёстке больше 45 с`, undefined, veh.id);
        }
      } else veh.stuckSince = -1;
    } else {
      const xarm = this.net.arms[veh.dest];
      v0 = (xarm.cfg.speedLimit / 3.6) * veh.v0f;
      const lead = this.leaderIn(this.exitLists[veh.dest][veh.outLane], veh);
      if (lead) take(lead.s - lead.len - veh.s, lead.v, 'leader', lead.id);
      this.yieldToBay(veh, `x${veh.dest}:${veh.outLane}`, take);
      const bs = this.busStopAhead(veh);
      if (bs && bs.s > veh.s - 0.5) take(bs.s - veh.s + veh.s0, 0, 'bus');
    }
    if (a === Infinity) a = this.idm(veh, v0, 1e6, v0);
    // реакция: стоявший водитель трогается не сразу, а через своё время реакции
    // только после настоящей остановки: короткая заминка в ползущей очереди реакции не требует
    if (veh.v < 0.3) { if (veh.haltT < 0) veh.haltT = st.t; } else veh.haltT = -1;
    if (veh.v < 0.3 && a > 0.2 && st.t - veh.haltT >= 1) {
      if (veh.goSince < 0) veh.goSince = st.t;
      if (st.t - veh.goSince < veh.reaction) return 0;
    } else if (veh.v >= 0.3 || a <= 0) veh.goSince = -1;
    return Math.max(-B_MAX, Math.min(veh.amax, a));
  }

  // ---------------- Положение на экране ----------------

  pose(veh: Vehicle) {
    const net = this.net;
    const back = veh.len / 2;
    let p: { p: { x: number; y: number }; h: number };
    if (veh.phase === 'approach') {
      const g = net.arms[veh.origin];
      const sc = veh.s - back;
      p = pointAt(g.inLanes[veh.lane], sc);
      if (veh.lcT >= 0 && veh.lcFrom !== veh.lane) {
        const q = pointAt(g.inLanes[veh.lcFrom], sc);
        const k = veh.lcT * veh.lcT * (3 - 2 * veh.lcT);
        p = { p: { x: q.p.x + (p.p.x - q.p.x) * k, y: q.p.y + (p.p.y - q.p.y) * k }, h: p.h - Math.sin(Math.PI * veh.lcT) * 0.12 * Math.sign(veh.lane - veh.lcFrom) };
      }
      // ряд на широкой полосе: сдвиг поперёк полосы, плюс — влево по ходу
      if (veh.shiftNow) p = { p: { x: p.p.x - Math.sin(p.h) * veh.shiftNow, y: p.p.y + Math.cos(p.h) * veh.shiftNow }, h: p.h };
    } else {
      // на кривой кузов — хорда между передней и задней частью, а не касательная в середине:
      // так длинная машина на повороте не выходит габаритом в соседнюю полосу
      const sf = veh.s - veh.len * 0.15, sr = veh.s - veh.len * 0.85;
      const f = this.routePt(veh, sf), r = this.routePt(veh, sr);
      if (veh.phase === 'conn' && this.cfg.sim.pathSpread) { this.spread(veh, f, sf); this.spread(veh, r, sr); }
      const hx = f.p.x - r.p.x, hy = f.p.y - r.p.y;
      p = { p: { x: (f.p.x + r.p.x) / 2, y: (f.p.y + r.p.y) / 2 }, h: hx * hx + hy * hy > 1e-4 ? Math.atan2(hy, hx) : f.h };
    }
    veh.x = p.p.x;
    veh.y = p.p.y;
    veh.h = p.h;
    if (veh.bayT > 0 || veh.bayShift) {
      // заезд в карман: сдвиг к бордюру. Заехавший из соседней полосы сначала стоит на одну полосу левее
      const g = net.arms[veh.phase === 'exit' ? veh.dest : veh.origin];
      const sign = veh.phase === 'exit' ? -1 : 1;
      const e = veh.bayT * veh.bayT * (3 - 2 * veh.bayT);
      const k = (e * 0.85 - (1 - e) * veh.bayShift) * g.cfg.laneWidth * sign;
      veh.x += g.rIn.x * k;
      veh.y += g.rIn.y * k;
    }
  }

  /**
   * Сдвиг точки кузова поперёк траектории манёвра: плавно от нуля на стоп-линии до наибольшего в середине
   * и снова до нуля на выезде. На поворотах водитель чаще срезает к внутренней стороне
   */
  private spread(veh: Vehicle, q: { p: { x: number; y: number }; h: number }, sc: number) {
    const c = this.net.conns[veh.conn];
    const L = c.path.length;
    if (!(sc > 0 && sc < L)) return;
    const { sh, bd } = this.implicit(veh, veh.conn);
    if (!sh && !bd) return;
    const t = sc / L, sm = t * t * (3 - 2 * t);
    const d = sh * (1 - sm) + bd * Math.sin(Math.PI * t);
    q.p = { x: q.p.x - Math.sin(q.h) * d, y: q.p.y + Math.cos(q.h) * d };
  }

  /**
   * Неявная траектория водителя: сдвиг у стоп-линии и изгиб в середине в границах из настроек, но не больше запаса полосы,
   * чтобы соседние ряды не задевали друг друга. На поворотах чаще срезают к внутренней стороне. Только для основной траектории
   */
  private implicit(veh: Vehicle, ci: number): { sh: number; bd: number } {
    const sim = this.cfg.sim;
    const c = this.net.conns[ci];
    if (!sim.pathSpread || !c || c.variant > 0 || c.kind === 'uturn' || veh.route) return { sh: 0, bd: 0 };
    const lw = this.net.arms[c.conn.from.arm].cfg.laneWidth;
    // сдвиг и изгиб вместе не больше запаса полосы, иначе соседние ряды на параллельных поворотах сходятся
    const margin = Math.max(0, (lw - veh.wid) / 2) * 0.6;
    const inside = c.kind === 'left' ? 1 : c.kind === 'right' ? -1 : 0;
    const u2 = Math.max(-1, Math.min(1, veh.lat2 * 0.65 + inside * 0.35));
    let sh = Math.max(0, sim.implicitShift) * veh.lat, bd = Math.max(0, sim.implicitBend) * u2;
    const sum = Math.abs(sh) + Math.abs(bd);
    if (sum > margin) { sh *= margin / sum; bd *= margin / sum; }
    return { sh, bd };
  }

  /** Точка на пути машины в манёвре или на выезде: sc — координата вдоль текущего участка */
  private routePt(veh: Vehicle, sc: number): { p: { x: number; y: number }; h: number } {
    const net = this.net;
    if (veh.phase === 'conn') {
      const c = net.conns[veh.conn];
      if (sc < 0) {
        const g = net.arms[c.conn.from.arm];
        const q = pointAt(g.inLanes[c.conn.from.lane], g.cfg.approachLength + sc);
        // задняя часть кузова ещё на подходе: в том же ряду, что и начало траектории
        const sh = c.shiftIn || this.implicit(veh, veh.conn).sh;
        return sh ? { p: { x: q.p.x - Math.sin(q.h) * sh, y: q.p.y + Math.cos(q.h) * sh }, h: q.h } : q;
      }
      return pointAt(c.path, sc);
    }
    const g = net.arms[veh.dest];
    if (sc < 0 && veh.conn >= 0) {
      const c = net.conns[veh.conn];
      return pointAt(c.path, c.path.length + sc);
    }
    return pointAt(g.outLanes[veh.outLane], sc);
  }

  /**
   * Автобус может выехать из кармана: рядом в полосе никого, а едущий сзади стоит или успевает затормозить (ПДД 18.3).
   * Условие то же, что у едущих сзади при решении пропустить автобус, поэтому они не могут ждать друг друга
   */
  private canLeaveBay(veh: Vehicle): boolean {
    const list = veh.phase === 'approach' ? this.laneLists[veh.origin]?.[veh.lane] : veh.phase === 'exit' ? this.exitLists[veh.dest]?.[veh.outLane] : null;
    if (!list) return true;
    const rear = veh.s - veh.len;
    for (const o of list) {
      if (o === veh || o.inBay) continue;
      if (o.s > rear) {
        if (o.s - o.len < veh.s + 2) { veh.whyId = o.id; return false; }
      } else if (!this.canStopBefore(o, rear - o.s)) { veh.whyId = o.id; return false; }
    }
    return true;
  }

  /**
   * Автобус остановился у кармана в соседней с бордюром полосе выезда: когда полоса у бордюра рядом свободна,
   * а едущий по ней сзади успевает затормозить, он перестраивается и заезжает в карман
   */
  private bayFromNextLane(veh: Vehicle) {
    const stop = this.stopById(veh.stopsLeft[0]);
    const n = this.net.arms[veh.dest].cfg.outLanes;
    if (!stop?.bay || stop.side !== 'exit' || veh.outLane !== n - 2) return;
    const rear = veh.s - veh.len;
    for (const o of this.exitLists[veh.dest]?.[n - 1] ?? []) {
      if (o === veh || o.inBay) continue;
      if (o.s > rear) { if (o.s - o.len < veh.s + 2) return; }
      else if (!this.canStopBefore(o, rear - o.s)) return;
    }
    veh.outLane = n - 1;
    veh.bayShift = 1;
    veh.inBay = true;
  }

  /** Машина стоит или успевает спокойно остановиться на этом расстоянии */
  private canStopBefore(o: Vehicle, gap: number): boolean {
    return o.v < 0.5 || (o.v * o.v) / (2 * 4) + 0.5 <= gap;
  }

  /** Пропустить автобус, который готов выехать из кармана впереди в этой полосе (ПДД 18.3) */
  private yieldToBay(veh: Vehicle, key: string, take: (gap: number, vLead: number, why?: Why, who?: number) => void) {
    const ready = this.bayReady[key];
    if (!ready) return;
    for (const b of ready) {
      if (b === veh) continue;
      const gap = b.s - b.len - veh.s;
      if (gap < 0 || !this.canStopBefore(veh, gap)) continue;
      take(gap, 0, 'bus', b.id);
    }
  }

  private pushSample(arr: Sample[], a: string, v: number) {
    if (this.headless) return;
    arr.push({ t: this.st.t, a, v });
    if (arr.length > 60000) arr.splice(0, 20000);
  }

  obbOf(veh: Vehicle, ahead = 0): OBB {
    const ext = veh.v * ahead;
    return { cx: veh.x + (Math.cos(veh.h) * ext) / 2, cy: veh.y + (Math.sin(veh.h) * ext) / 2, hl: veh.len / 2 + ext / 2, hw: veh.wid / 2, h: veh.h };
  }

  pedObb(p: PedAgent): OBB {
    return { cx: p.x, cy: p.y, hl: 0.3, hw: 0.28 + 0.32 * (p.size - 1), h: p.h };
  }

  // ---------------- Перестроения ----------------

  private laneChanges() {
    for (const veh of this.st.vehicles) {
      if (veh.phase !== 'approach' || veh.crashed) continue;
      if (veh.lcT >= 0) {
        veh.lcT += this.dt / LC_TIME;
        if (veh.lcT >= 1) { veh.lcT = -1; veh.lcFrom = veh.lane; }
        continue;
      }
      const arm = this.net.arms[veh.origin];
      if (veh.lane === veh.targetLane || veh.dwellUntil >= 0) continue;
      const afterSolid = veh.s >= arm.lcS;
      if (afterSolid && !(veh.solidCross && veh.s < arm.cfg.approachLength - 6)) continue;
      const urgent = !(veh.route ? this.net.reachableBus : this.net.reachable)[veh.origin][veh.lane]?.includes(veh.dest) || !this.busLaneOk(veh, veh.lane);
      const nl = veh.lane + Math.sign(veh.targetLane - veh.lane);
      const list = this.laneLists[veh.origin][nl] ?? [];
      let lead: Vehicle | null = null, foll: Vehicle | null = null;
      for (const o of list) {
        if (o === veh) continue;
        if (o.s >= veh.s) { if (!lead || o.s < lead.s) lead = o; }
        else if (!foll || o.s > foll.s) foll = o;
      }
      const k = urgent && arm.lcS - veh.s < 40 ? 0.35 : 0.7;
      // впереди в новой полосе должно хватить места и затормозить до скорости лидера не резче 3 м/с²
      const leadGap = lead ? lead.s - lead.len - veh.s : Infinity;
      const okLead = !lead || (leadGap > veh.s0 + veh.v * k * 0.8 && veh.v * veh.v - lead.v * lead.v <= 2 * 3.0 * Math.max(0, leadGap - veh.s0));
      // в плотной медленной очереди соседней полосы водитель сзади пропускает того, кому нужно перестроиться
      const letIn = !!foll && foll.lcYield === veh.id && foll.v < 1.5 && veh.s - veh.len - foll.s > 0.8;
      const okFoll = !foll || letIn || veh.s - veh.len - foll.s > foll.s0 + foll.v * k + Math.max(0, foll.v - veh.v) * 0.8;
      // просить пропустить имеет смысл, только если впереди в нужной полосе есть место, водитель сзади едет медленно
      // и стоит сразу за задней частью машины. Один водитель пропускает одну машину, после этого какое-то время никого
      // пропускает тот, кто стоит рядом чуть позади или сразу за задней частью машины
      const nearFoll = !!foll && foll.s > veh.s - veh.len - 6 && foll.s < veh.s - 0.5;
      if (urgent && !okFoll && foll && nearFoll && foll.v < 3 && !foll.route && foll.lcT < 0 &&
          (foll.lcYield === veh.id || (foll.lcYield < 0 && this.st.t > foll.lcYieldUntil + LC_COURTESY))) {
        if (foll.lcYield !== veh.id) { foll.lcYield = veh.id; foll.lcYieldUntil = this.st.t + LC_COURTESY; }
        veh.lcHelper = foll.id;
      }
      if (okLead && okFoll) {
        if (foll && foll.lcYield === veh.id) foll.lcYield = -1;
        veh.lcHelper = -1;
        veh.lcFrom = veh.lane;
        veh.lane = nl;
        veh.lcT = 0;
        veh.conn = -1;
        veh.stuckSince = -1;
        veh.lcWaitSince = -1;
        if (afterSolid) {
          this.st.counters.violSolid++;
          this.addLog('warn', 'viol-solid', `Машина #${veh.id} на подходе «${this.armName(veh.origin)}» перестроилась через сплошную линию разметки, нарушение ПДД`, undefined, veh.id);
        }
        if (veh.lane === veh.targetLane) veh.solidCross = false;
      }
    }
  }

  // ---------------- Главный шаг ----------------

  step(): void {
    const st = this.st;
    const dt = this.dt;
    st.t = +(st.t + dt).toFixed(6);
    st.tick++;
    this.updateSignals();
    this.index();
    this.spawnAll();
    this.spawnPeds();
    this.updatePeds();
    this.index();

    const acc = new Map<Vehicle, number>();
    for (const veh of st.vehicles) acc.set(veh, this.accel(veh));

    const removed = new Set<Vehicle>();
    for (const veh of st.vehicles) {
      veh.px = veh.x; veh.py = veh.y; veh.ph = veh.h;
      veh.ps = veh.s;
      if (veh.crashed) { veh.v = 0; continue; }
      const a = acc.get(veh) ?? 0;
      veh.a = a;
      let ds = veh.v * dt + 0.5 * a * dt * dt;
      if (ds < 0) ds = (veh.v * veh.v) / (2 * Math.max(0.1, -a));
      veh.v = Math.max(0, veh.v + a * dt);
      veh.s += Math.max(0, ds);
      if (veh.phase === 'approach') {
        const tgt = this.shiftTarget(veh);
        const step = ROW_SPEED * dt;
        if (veh.shiftNow !== tgt) veh.shiftNow += Math.max(-step, Math.min(step, tgt - veh.shiftNow));
      } else veh.shiftNow = 0;
      if (veh.v < 0.5 && veh.phase === 'approach') veh.stopTime += dt;
      // автобус подъехал к остановке
      if (veh.route && veh.dwellUntil < 0 && veh.v < 0.4) {
        const bs = this.busStopAhead(veh);
        if (bs && Math.abs(bs.s - veh.s) < 1.5) {
          const tr = this.cfg.transit;
          const dwell = tr.dwellMin + (tr.dwellMax - tr.dwellMin) * rngNext(veh.rng);
          veh.dwellUntil = st.t + dwell;
          // в карман заезжают только из полосы у бордюра, иначе автобус стоит в своей полосе
          const curbLane = veh.phase === 'exit' ? veh.outLane === this.net.arms[veh.dest].cfg.outLanes - 1 : veh.lane === this.net.arms[veh.origin].cfg.inLanes - 1;
          veh.inBay = bs.stop.bay && curbLane;
          veh.v = 0;
          st.counters.busServed++;
          st.counters.busDwellSum += dwell;
          this.pushSample(this.samples.dwell, veh.origin, dwell);
        }
      }
      if (veh.dwellUntil >= 0 && st.t < veh.dwellUntil && !veh.inBay && veh.phase === 'exit') this.bayFromNextLane(veh);
      const targetBay = veh.inBay ? 1 : 0;
      if (veh.bayT !== targetBay) veh.bayT = Math.max(0, Math.min(1, veh.bayT + Math.sign(targetBay - veh.bayT) * dt / 2.5));

      if (veh.phase === 'approach') {
        const L = this.net.arms[veh.origin].cfg.approachLength;
        if (veh.s >= L) {
          if (veh.conn < 0) veh.conn = this.connOfLane(veh);
          if (veh.conn < 0) veh.conn = this.rerouteConn(veh);
          if (veh.conn < 0) { veh.s = L; veh.v = 0; continue; }
          const c = this.net.conns[veh.conn];
          if (c.conn.to.arm !== veh.dest) {
            this.addLog('warn', 'reroute', `Машина #${veh.id} не смогла поехать на «${this.armName(veh.dest)}» и уехала на «${this.armName(c.conn.to.arm)}»`, veh.error ?? undefined, veh.id);
          }
          veh.phase = 'conn';
          veh.s -= L;
          veh.ps = veh.s - veh.v * dt;
          veh.entryPermit = this.permit[veh.conn];
          veh.tStop = st.t;
          veh.stuckSince = -1;
          st.counters.crossedStop++;
          st.counters.sumWait += veh.stopTime;
          st.counters.crossedBy[veh.origin] = (st.counters.crossedBy[veh.origin] ?? 0) + 1;
          st.counters.waitBy[veh.origin] = (st.counters.waitBy[veh.origin] ?? 0) + veh.stopTime;
          st.recentStop.push({ t: st.t, wait: veh.stopTime });
          st.diag.lastCross[veh.origin] = st.t;
          st.diag.greenAcc[veh.origin] = 0;
          st.diag.lastAnyCross = st.t;
          st.diag.cycleCount[veh.origin] = (st.diag.cycleCount[veh.origin] ?? 0) + 1;
          this.pushSample(this.samples.wait, veh.origin, veh.stopTime);
          if (veh.illegal) {
            st.counters.violTurn++;
            this.addLog('warn', 'viol-turn', `Машина #${veh.id} поехала на «${this.armName(c.conn.to.arm)}» из полосы ${veh.lane}, откуда это направление разметкой не разрешено, нарушение ПДД`, undefined, veh.id);
          }
          if (veh.entryPermit === 'none') {
            if (veh.viol.stop && veh.v < 3.5 && veh.yellowDecision !== 1) {
              veh.overStop = true;
              st.counters.violStop++;
              this.addLog('warn', 'viol-stop', `Машина #${veh.id} на подходе «${this.armName(veh.origin)}» остановилась за стоп-линией на запрещающий сигнал, нарушение ПДД`, undefined, veh.id);
            } else if (this.yellowMain[veh.conn]) {
              this.addLog('info', 'amber', `Машина #${veh.id} въехала на перекрёсток на жёлтый, остановиться без экстренного торможения было нельзя`, undefined, veh.id);
            } else {
              st.counters.violRed++;
              this.addLog('warn', 'viol-red', `Машина #${veh.id} с подхода «${this.armName(veh.origin)}» въехала на перекрёсток на красный, нарушение ПДД`, undefined, veh.id);
            }
          }
        }
      } else if (veh.phase === 'conn') {
        const c = this.net.conns[veh.conn];
        if (veh.s >= c.path.length) {
          veh.phase = 'exit';
          veh.s -= c.path.length;
          veh.ps = veh.s - veh.v * dt;
          veh.outLane = c.conn.to.lane;
          veh.dest = c.conn.to.arm;
          veh.stuckSince = -1;
        }
      } else {
        const xarm = this.net.arms[veh.dest];
        if (veh.s >= xarm.cfg.exitLength) {
          const fn = this.exitFns[veh.dest];
          let ok = true;
          if (fn) {
            try {
              ok = !!fn({ t: st.t, dt, arm: veh.dest, lane: veh.outLane, memory: st.memory.exits[veh.dest] });
            } catch (e) {
              this.addLog('error', 'code', `Ошибка в canExit(), подход «${this.armName(veh.dest)}»`, e instanceof Error ? e.message : String(e));
              this.codeFailed('canExit', veh.dest);
            }
          }
          if (ok) {
            removed.add(veh);
            st.counters.exited++;
            const free = (this.net.arms[veh.origin].cfg.approachLength + (veh.conn >= 0 ? this.net.conns[veh.conn].path.length : 30) + xarm.cfg.exitLength) / Math.max(5, (xarm.cfg.speedLimit / 3.6) * 0.9);
            const delay = Math.max(0, st.t - veh.tWanted - free);
            st.counters.sumDelay += delay;
            this.pushSample(this.samples.delay, veh.origin, delay);
          } else {
            veh.s = xarm.cfg.exitLength;
            veh.v = 0;
          }
        }
      }
    }
    if (removed.size) st.vehicles = st.vehicles.filter((v) => !removed.has(v));

    this.index();
    this.laneChanges();
    for (const veh of st.vehicles) this.pose(veh);
    this.trackConflicts();
    this.detectCollisions();
    this.detectPedCollisions();
    this.expireCrashes();
    this.metrics();
  }

  private trackConflicts() {
    const st = this.st;
    const sim = this.cfg.sim;
    for (const veh of st.vehicles) {
      if (veh.phase !== 'conn' || veh.crashed) continue;
      const c = this.net.conns[veh.conn];
      for (const cr of c.conflicts) {
        const last = st.confLast[cr.conflict];
        const mySide = cr.side;
        const other = mySide === 'a' ? 'b' : 'a';
        if (veh.ps < cr.start && veh.s >= cr.start && !this.net.conflicts[cr.conflict].same) {
          let pet = st.t - last[other];
          const cf = this.net.conflicts[cr.conflict];
          const oStart = other === 'a' ? cf.aStart : cf.bStart;
          const oEnd = other === 'a' ? cf.aEnd : cf.bEnd;
          for (const o of this.connLists[cr.other]) {
            if (o.s > oStart && o.s - o.len < oEnd) { pet = 0; break; }
          }
          if (pet < sim.petWindow) {
            st.counters.crossings++;
            if (pet < sim.petDanger) {
              st.counters.dangers++;
              veh.danger = st.t;
              this.addLog('warn', 'pet', `Опасный момент: машина #${veh.id} въехала в зону конфликта через ${pet.toFixed(1)} с после другой машины, порог PET ${sim.petDanger} с`, `${this.connLabel(veh.conn)} × ${this.connLabel(cr.other)}`, veh.id);
            }
          }
        }
        if (veh.ps - veh.len < cr.end && veh.s - veh.len >= cr.end) last[mySide] = st.t;
      }
    }
  }

  connLabel(ci: number): string {
    const c = this.net.conns[ci];
    if (!c) return '?';
    const k = { straight: 'прямо', left: 'налево', right: 'направо', uturn: 'разворот' }[c.kind];
    return `${this.armName(c.conn.from.arm)}, полоса ${c.conn.from.lane} → ${this.armName(c.conn.to.arm)}, полоса ${c.conn.to.lane}, ${k}`;
  }

  private detectCollisions() {
    const st = this.st;
    const sim = this.cfg.sim;
    const cand: Vehicle[] = [];
    for (const v of st.vehicles) {
      if (v.phase === 'conn') cand.push(v);
      else if (v.phase === 'approach' && this.net.arms[v.origin].cfg.approachLength - v.s < 6) cand.push(v);
      else if (v.phase === 'exit' && v.s < v.len + 8) cand.push(v);
    }
    for (let i = 0; i < cand.length; i++) {
      for (let j = i + 1; j < cand.length; j++) {
        const a = cand[i], b = cand[j];
        if (a.phase === b.phase && a.phase === 'conn' && a.conn === b.conn) continue;
        if (a.ghostUntil > st.t || b.ghostUntil > st.t) continue;
        if (a.phase === 'approach' && b.phase === 'approach' && a.origin === b.origin) continue;
        if (a.phase === 'exit' && b.phase === 'exit' && a.dest === b.dest && a.outLane === b.outLane) continue;
        if (Math.abs(a.x - b.x) > 25 || Math.abs(a.y - b.y) > 25) continue;
        const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
        if (obbOverlap(this.obbOf(a), this.obbOf(b))) {
          if (st.crashPairs[key] !== undefined) continue;
          if (a.crashed && b.crashed) continue;
          st.crashPairs[key] = st.t;
          st.counters.collisions++;
          a.danger = b.danger = st.t;
          const det = `#${a.id}: ${a.conn >= 0 ? this.connLabel(a.conn) : this.armName(a.origin)}${a.risky ? ', рискованный водитель' : ''}\n` +
            `#${b.id}: ${b.conn >= 0 ? this.connLabel(b.conn) : this.armName(b.origin)}${b.risky ? ', рискованный водитель' : ''}`;
          this.addLog('error', 'crash', `Столкновение в модели: машины #${a.id} и #${b.id}`, det, a.id);
          if (sim.crashPersist) this.makeCrash([a, b]);
        } else if (sim.ttcDanger > 0 && (a.v > 1 || b.v > 1) && obbOverlap(this.obbOf(a, sim.ttcDanger), this.obbOf(b, sim.ttcDanger))) {
          const lastD = st.dangerPairs[key];
          if (lastD !== undefined && st.t - lastD < 5) continue;
          st.dangerPairs[key] = st.t;
          st.counters.dangers++;
          a.danger = b.danger = st.t;
          this.addLog('warn', 'ttc', `Опасное сближение машин #${a.id} и #${b.id}: габариты пересекутся меньше чем через ${sim.ttcDanger} с`, undefined, a.id);
        }
      }
    }
    if (st.tick % 100 === 0) {
      for (const k of Object.keys(st.dangerPairs)) if (st.t - st.dangerPairs[k] > 10) delete st.dangerPairs[k];
      for (const k of Object.keys(st.crashPairs)) if (st.t - st.crashPairs[k] > 600) delete st.crashPairs[k];
    }
  }

  /** Наезды на пешеходов и опасные сближения машин с пешеходами (по габаритам) */
  private detectPedCollisions() {
    const st = this.st;
    const sim = this.cfg.sim;
    if (!st.peds.length) return;
    for (const p of st.peds) {
      if (p.hit) continue;
      const pb = this.pedObb(p);
      // на тротуаре и островке пешеходов не сбивают: если габарит машины туда заходит, это погрешность геометрии поворота
      if (!this.pedOnRoad(p)) continue;
      for (const v of st.vehicles) {
        // стоящая машина на переходе — помеха, пешеходы её обходят, это не наезд
        if (v.crashed || v.v < 1.0) continue;
        if (Math.abs(v.x - p.x) > 16 || Math.abs(v.y - p.y) > 16) continue;
        const key = `p${p.id}-${v.id}`;
        // наезд — когда пешеходы перед серединой машины по ходу движения, а не сбоку или сзади
        const ahead = (p.x - v.x) * Math.cos(v.h) + (p.y - v.y) * Math.sin(v.h) > 0;
        if (ahead && obbOverlap(this.obbOf(v), pb)) {
          if (st.crashPairs[key] !== undefined) continue;
          st.crashPairs[key] = st.t;
          st.counters.pedHits++;
          p.danger = v.danger = st.t;
          this.addLog('error', 'ped-hit', `Наезд на пешеходов в модели: машина #${v.id}, группа пешеходов #${p.id}, человек в группе ${p.size}`,
            `Машина: ${v.conn >= 0 ? this.connLabel(v.conn) : this.armName(v.origin)}\nПешеходы: ${this.pedNodeName(p.origin)} → ${this.pedNodeName(p.dest)}`, v.id);
          if (sim.crashPersist) {
            p.hit = true;
            p.hitUntil = st.t + sim.crashDuration;
            // машина остаётся на месте и перекрывает проезд, как при столкновении
            this.makeCrash([v]);
          }
        } else if (ahead && sim.ttcDanger > 0 && obbOverlap(this.obbOf(v, sim.ttcDanger), pb)) {
          const lastD = st.dangerPairs[key];
          if (lastD !== undefined && st.t - lastD < 5) continue;
          st.dangerPairs[key] = st.t;
          st.counters.pedDangers++;
          p.danger = v.danger = st.t;
          this.addLog('warn', 'ped-danger', `Опасное сближение машины #${v.id} с пешеходами #${p.id}: до контакта меньше ${sim.ttcDanger} с`, undefined, v.id);
        }
      }
    }
  }

  private makeCrash(vs: Vehicle[]) {
    const st = this.st;
    const sim = this.cfg.sim;
    for (const v of vs) {
      v.crashed = true;
      v.v = 0;
      v.crashUntil = st.t + sim.crashDuration;
    }
    const x = vs.reduce((s, v) => s + v.x, 0) / vs.length;
    const y = vs.reduce((s, v) => s + v.y, 0) / vs.length;
    const r = Math.max(...vs.map((v) => v.len)) / 2 + 1.5;
    const blocks: Crash['blocks'] = [];
    this.net.conns.forEach((c, ci) => {
      let bestS = -1, bestD = Infinity;
      for (let i = 0; i < c.path.pts.length; i++) {
        const d = dist(c.path.pts[i], { x, y });
        if (d < bestD) { bestD = d; bestS = c.path.cum[i]; }
      }
      if (bestD < r + 1.5) blocks.push({ conn: ci, s: Math.max(0, bestS - r - 1) });
    });
    st.crashes.push({ id: st.nextCrash++, x, y, r, until: st.t + sim.crashDuration, vids: vs.map((v) => v.id), blocks });
  }

  private expireCrashes() {
    const st = this.st;
    if (!st.crashes.length && !st.vehicles.some((v) => v.crashed)) return;
    const gone = new Set<number>();
    for (const v of st.vehicles) if (v.crashed && st.t >= v.crashUntil) gone.add(v.id);
    if (gone.size) {
      st.vehicles = st.vehicles.filter((v) => !gone.has(v.id));
      st.counters.removedCrash += gone.size;
      this.addLog('info', 'crash-clear', `Место столкновения освобождено, проезд восстановлен, машины ${[...gone].map((i) => '#' + i).join(', ')}`);
    }
    st.crashes = st.crashes.filter((c) => st.t < c.until);
  }

  armQueue(d: ArmId): number {
    const lists = this.laneLists[d] ?? [];
    let m = 0;
    for (const l of lists) {
      let q = 0;
      for (const v of l) if (v.v < 1) q++;
      m = Math.max(m, q);
    }
    return m + (this.st?.queue[d]?.length ?? 0);
  }

  // ---------------- Диагностика: взаимная блокировка, нет проезда, падение скорости ----------------

  private diagnose() {
    const st = this.st;
    const sim = this.cfg.sim;
    const t = st.t;
    for (const v of st.vehicles) {
      if (v.v < 0.3) { if (v.stopSince < 0) v.stopSince = t; } else if (v.v > 0.8) v.stopSince = -1;
    }
    // граф ожидания: кто кого ждёт среди давно стоящих машин
    const edges = new Map<number, number[]>();
    const byId = new Map<number, Vehicle>();
    for (const v of st.vehicles) byId.set(v.id, v);
    for (const v of st.vehicles) {
      if (v.stopSince < 0 || t - v.stopSince < 3 || v.crashed || (v.dwellUntil >= 0 && t < v.dwellUntil)) continue;
      const out: number[] = [];
      if ((v.why === 'leader' || v.why === 'merge' || v.why === 'exit' || v.why === 'bus') && v.whyId >= 0) out.push(v.whyId);
      else if (v.why === 'yield' && v.yieldTo >= 0) out.push(v.yieldTo);
      // ждёт окончания разрешающего сигнала встречным: светофор сменится, это не взаимная блокировка
      else if (v.why === 'yield' && v.yieldTo === -2) continue;
      else if (v.why === 'yield' && v.whyId >= 0 && v.conn >= 0) {
        const cf = this.net.conflicts[v.whyId];
        const mineA = cf.a === v.conn;
        const B = mineA ? cf.b : cf.a;
        const bEnd = mineA ? cf.bEnd : cf.aEnd;
        for (const o of this.connLists[B] ?? []) if (o.s < bEnd + o.len) out.push(o.id);
        const f = this.net.conns[B].conn.from;
        const lane = this.laneLists[f.arm]?.[f.lane] ?? [];
        const first = lane[lane.length - 1];
        if (first && first.conn === B && this.permit[B] !== 'none' && this.net.arms[f.arm].cfg.approachLength - first.s < 6) out.push(first.id);
      }
      if (out.length) edges.set(v.id, out);
    }
    // сильно связные компоненты (Тарьян)
    const idx = new Map<number, number>(), low = new Map<number, number>(), onStack = new Set<number>();
    const stack: number[] = [];
    const sccs: number[][] = [];
    let counter = 0;
    const strong = (u: number) => {
      idx.set(u, counter); low.set(u, counter); counter++;
      stack.push(u); onStack.add(u);
      for (const w of edges.get(u) ?? []) {
        if (!edges.has(w)) continue;
        if (!idx.has(w)) { strong(w); low.set(u, Math.min(low.get(u)!, low.get(w)!)); }
        else if (onStack.has(w)) low.set(u, Math.min(low.get(u)!, idx.get(w)!));
      }
      if (low.get(u) === idx.get(u)) {
        const comp: number[] = [];
        let w: number;
        do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== u);
        if (comp.length > 1) sccs.push(comp);
      }
    };
    for (const u of edges.keys()) if (!idx.has(u)) strong(u);
    const locked = sccs.filter((c) => c.every((id) => { const v = byId.get(id); return v && v.stopSince >= 0 && t - v.stopSince >= sim.deadlockSeconds; }));
    const ph = this.cfg.signals.phases[st.sig.phaseIdx];
    if (locked.length) {
      const vids = locked.flat();
      const movements = [...new Set(vids.map((id) => { const v = byId.get(id)!; return v.conn >= 0 ? this.connLabel(v.conn) : `${this.armName(v.origin)} → ${this.armName(v.dest)}`; }))];
      const since = Math.min(...vids.map((id) => byId.get(id)!.stopSince));
      if (!st.status.deadlock) {
        st.status.deadlock = { since, detected: t, phase: ph?.name ?? '', segment: st.sig.segment === 'main' ? 'основной такт' : 'промтакт', movements, vids, lastSeen: t };
        st.counters.deadlocks++;
        this.addLog('error', 'deadlock', `Взаимная блокировка с ${since.toFixed(0)} с, фаза «${ph?.name ?? ''}». Машины ждут друг друга и не могут проехать`, movements.join('\n'), vids[0]);
      } else {
        st.status.deadlock.vids = vids;
        st.status.deadlock.movements = movements;
        st.status.deadlock.lastSeen = t;
      }
    }
    // блокировка, которую не разрешили ни правила, ни выход водителей с нарушением очерёдности: обычно это машины,
    // вставшие поперёк друг друга, пока проезд перекрывало столкновение. В жизни водители разъезжаются вручную,
    // в модели одна из машин проезжает, а касание кузовами при этом не считается столкновением
    if (sim.deadlockBreak > 0) for (const comp of locked) {
      const vs = comp.map((id) => byId.get(id)!).filter((v) => v.phase === 'conn' && !v.crashed);
      const since = Math.min(...comp.map((id) => byId.get(id)!.stopSince));
      if (!vs.length || t - since < Math.max(60, 3 * sim.deadlockBreak) || vs.some((v) => v.ghostUntil > t - 20)) continue;
      const progress = (v: Vehicle) => v.s / Math.max(1, this.net.conns[v.conn].path.length);
      const pick = vs.reduce((b, v) => (progress(v) > progress(b) ? v : b), vs[0]);
      pick.ghostUntil = t + GHOST_TIME;
      this.addLog('warn', 'deadlock-manual', `Машина #${pick.id} выехала из взаимной блокировки, которая не разрешалась ${(t - since).toFixed(0)} с. В модели водители в таком случае разъезжаются вручную`, this.connLabel(pick.conn), pick.id);
    }
    if (!locked.length && st.status.deadlock && t - st.status.deadlock.lastSeen >= 10) {
      this.addLog('info', 'deadlock-end', `Взаимная блокировка закончилась, она длилась ${(t - st.status.deadlock.since).toFixed(0)} с`);
      st.status.deadlock = null;
    }

    // нет проезда при разрешающем сигнале
    const stall: StatusInfo[] = [];
    const armThreshold = Math.max(20, sim.noProgressSeconds / 3);
    for (const arm of this.armList) {
      const green = (this.net.connsFromLane[arm] ?? []).some((l) => l.some((ci) => this.permit[ci] !== 'none'));
      const q = this.armQueue(arm) - (st.queue[arm]?.length ?? 0);
      if (green && q > 0) st.diag.greenAcc[arm] = (st.diag.greenAcc[arm] ?? 0) + 1;
      if (q === 0) st.diag.greenAcc[arm] = 0;
      if ((st.diag.greenAcc[arm] ?? 0) >= armThreshold) {
        stall.push({ key: arm, label: this.armName(arm), since: st.diag.lastCross[arm] ?? 0, detail: `разрешающий сигнал горел ${st.diag.greenAcc[arm].toFixed(0)} с, а стоп-линию никто не проехал` });
      }
    }
    if (st.vehicles.length > 0 && t - st.diag.lastAnyCross >= sim.noProgressSeconds && t > sim.noProgressSeconds) {
      stall.push({ key: 'all', label: 'весь перекрёсток', since: st.diag.lastAnyCross, detail: `стоп-линию никто не проезжает ${(t - st.diag.lastAnyCross).toFixed(0)} с` });
    }
    for (const x of stall) if (!st.status.stall.some((y) => y.key === x.key)) {
      st.counters.stalls++;
      this.addLog('warn', 'stall', `Нет проезда: ${x.label}, ${x.detail}`);
    }
    for (const y of st.status.stall) if (!stall.some((x) => x.key === y.key)) this.addLog('info', 'stall-end', `Движение возобновилось: ${y.label}`);
    st.status.stall = stall.map((x) => ({ ...x, since: st.status.stall.find((y) => y.key === x.key)?.since ?? x.since }));

    // падение средней скорости в скользящем окне
    const W = Math.max(30, Math.round(sim.slowdownWindow));
    // пока модель заполняется машинами, скорость падает естественно: обычную скорость считаем после разгона
    const warm = Math.max(2 * W, cycleLength(this.cfg.signals) + W);
    const sum: Record<string, number> = {}, cnt: Record<string, number> = {};
    for (const v of st.vehicles) {
      if (v.phase === 'exit' || v.dwellUntil >= 0) continue;
      sum[v.origin] = (sum[v.origin] ?? 0) + v.v; cnt[v.origin] = (cnt[v.origin] ?? 0) + 1;
      sum.all = (sum.all ?? 0) + v.v; cnt.all = (cnt.all ?? 0) + 1;
    }
    const slow: StatusInfo[] = [];
    for (const key of [...this.armList, 'all']) {
      const win = (st.diag.speedWin[key] ??= []);
      win.push(cnt[key] ? sum[key] / cnt[key] : NaN);
      if (win.length > W) win.shift();
      const vals = win.filter((x) => !Number.isNaN(x));
      if (vals.length < W / 2 || t < warm) continue;
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const n = (st.diag.speedN[key] = (st.diag.speedN[key] ?? 0) + 1);
      const ref = st.diag.speedRef[key];
      if (ref === undefined) { st.diag.speedRef[key] = avg; continue; }
      const k = 1 / Math.min(n, 900);
      st.diag.speedRef[key] = ref + (avg - ref) * k;
      const was = st.status.slow.some((y) => y.key === key);
      const below = avg < ref * sim.slowdownRatio * (was ? 1.15 : 1);
      if (!below) delete st.diag.slowCand[key];
      else st.diag.slowCand[key] ??= t;
      if (n > W && ref > 1.5 && below && t - st.diag.slowCand[key] >= 30) {
        slow.push({ key, label: key === 'all' ? 'все подходы' : this.armName(key), since: t, detail: `средняя скорость за ${W} с ${(avg * 3.6).toFixed(0)} км/ч при обычной ${(ref * 3.6).toFixed(0)} км/ч` });
      }
    }
    for (const x of slow) if (!st.status.slow.some((y) => y.key === x.key)) this.addLog('warn', 'slow', `Скорость падает: ${x.label}, ${x.detail}`);
    for (const y of st.status.slow) if (!slow.some((x) => x.key === y.key)) this.addLog('info', 'slow-end', `Скорость восстановилась: ${y.label}`);
    st.status.slow = slow.map((x) => ({ ...x, since: st.status.slow.find((y) => y.key === x.key)?.since ?? x.since }));

    // проезды за цикл
    if (st.sig.cycleCount !== st.diag.lastCycle) {
      st.diag.lastCycle = st.sig.cycleCount;
      let total = 0;
      for (const arm of this.armList) { this.pushSample(this.samples.cycle, arm, st.diag.cycleCount[arm] ?? 0); total += st.diag.cycleCount[arm] ?? 0; st.diag.cycleCount[arm] = 0; }
      this.pushSample(this.samples.cycle, 'all', total);
    }
  }

  private metrics() {
    const st = this.st;
    while (st.recentStop.length && st.t - st.recentStop[0].t > RECENT_WINDOW) st.recentStop.shift();
    while (st.recentPed.length && st.t - st.recentPed[0].t > RECENT_WINDOW) st.recentPed.shift();
    const qs = this.armList.map((d) => this.armQueue(d));
    const mq = qs.length ? Math.max(...qs) : 0;
    st.maxQueue = Math.max(st.maxQueue, mq);
    const whole = Math.round(st.t / this.dt) % Math.max(1, Math.round(1 / this.dt)) === 0;
    if (!whole) return;
    this.diagnose();
    if (this.headless) return;
    const s = this.series;
    const win = Math.min(RECENT_WINDOW, st.t) || 1;
    const nWin = st.recentStop.length;
    s.t.push(+st.t.toFixed(1));
    s.inSystem.push(st.vehicles.length + this.armList.reduce((a, d) => a + st.queue[d].length, 0));
    s.throughput.push(Math.round((nWin / win) * 3600));
    s.avgWait.push(nWin ? +(st.recentStop.reduce((a, r) => a + r.wait, 0) / nWin).toFixed(1) : 0);
    s.maxQueue.push(mq);
    s.passed.push(st.counters.crossedStop);
    s.errors.push(st.counters.errors);
    s.dangers.push(st.counters.dangers);
    s.crossings.push(st.counters.crossings);
    s.collisions.push(st.counters.collisions);
    s.pedActive.push(st.peds.reduce((a, p) => a + p.size, 0));
    s.pedDone.push(st.counters.pedDone);
    s.pedWait.push(st.recentPed.length ? +(st.recentPed.reduce((a, r) => a + r.wait, 0) / st.recentPed.length).toFixed(1) : 0);
    s.pedDangers.push(st.counters.pedDangers);
    s.pedHits.push(st.counters.pedHits);
    s.violations.push(st.counters.violSolid + st.counters.violStop + st.counters.violRed + st.counters.violTurn);
    s.missed.push(st.counters.missedTurns);
    const moving = st.vehicles.filter((v) => v.phase !== 'exit');
    s.meanSpeed.push(moving.length ? +((moving.reduce((a, v) => a + v.v, 0) / moving.length) * 3.6).toFixed(1) : 0);
    this.armList.forEach((d, i) => (s.queues[d] ??= []).push(qs[i]));
    if (s.t.length > MAX_SERIES) {
      const half = Math.floor(s.t.length / 2);
      const thin = (arr: number[]) => arr.slice(0, half).filter((_, i) => i % 2 === 0).concat(arr.slice(half));
      for (const k of Object.keys(s) as Array<keyof Series>) {
        if (k === 'queues') for (const q of Object.keys(s.queues)) s.queues[q] = thin(s.queues[q]);
        else (s[k] as number[]) = thin(s[k] as number[]);
      }
    }
    if (Math.round(st.t) % SNAPSHOT_EVERY === 0) {
      this.history.push(structuredClone(st));
      const keep = Math.max(2, Math.ceil(this.cfg.sim.historySeconds / SNAPSHOT_EVERY));
      if (this.history.length > keep) this.history.splice(0, this.history.length - keep);
    }
    if (this.lampChanges.length > 2000) this.lampChanges.splice(0, 1000);
  }

  // ---------------- Управление временем ----------------

  runUntil(t: number, budgetMs = Infinity): boolean {
    const t0 = performance.now();
    while (this.st.t + 1e-9 < t) {
      this.step();
      if (performance.now() - t0 > budgetMs) return false;
    }
    return true;
  }

  runToNextLampChange(maxSeconds = 300): void {
    const sig = this.st.lampSig;
    const limit = this.st.t + maxSeconds;
    while (this.st.t < limit) {
      this.step();
      if (this.st.lampSig !== sig) break;
    }
  }

  restore(snap: SimState) {
    this.st = structuredClone(snap);
    const t = this.st.t;
    const s = this.series;
    let n = s.t.length;
    while (n > 0 && s.t[n - 1] > t + 1e-6) n--;
    for (const arr of seriesArrays(s)) arr.length = Math.min(arr.length, n);
    this.log = this.log.filter((e) => e.t <= t + 1e-6);
    this.history = this.history.filter((h) => h.t <= t + 1e-6);
    if (!this.history.length) this.history.push(structuredClone(this.st));
    this.lampChanges = this.lampChanges.filter((x) => x <= t + 1e-6);
    for (const k of Object.keys(this.samples) as Array<keyof Samples>) this.samples[k] = this.samples[k].filter((x) => x.t <= t + 1e-6);
    this.updateSignals(true);
    this.index();
    this.pedsByEdge = this.net.pedEdges.map(() => []);
    for (const p of this.st.peds) this.pedsByEdge[p.route[p.leg].edge].push(p);
  }

  back(seconds: number): boolean {
    const target = this.st.t - seconds;
    if (target < -1e-9) {
      if (this.history.length && this.history[0].t <= 1e-9) { this.restore(this.history[0]); return true; }
      return false;
    }
    let snap: SimState | null = null;
    for (const h of this.history) if (h.t <= target + 1e-6) snap = h;
    if (!snap) return false;
    this.restore(snap);
    this.runUntil(target);
    return true;
  }

  backToPrevLampChange(): boolean {
    const t = this.st.t;
    const prev = [...this.lampChanges].reverse().find((x) => x < t - 1e-6 - this.dt);
    if (prev === undefined) return this.back(t);
    return this.back(t - prev);
  }

  summary(warmup: { counters: Counters; t: number }): Summary {
    const st = this.st;
    const c = st.counters, w = warmup.counters;
    const horizon = Math.max(1, st.t - warmup.t);
    const crossed = c.crossedStop - w.crossedStop;
    let unservedWait = 0, unserved = 0;
    const armWait: Record<string, number> = {}, armN: Record<string, number> = {};
    for (const d of this.armList) {
      armWait[d] = (c.waitBy[d] ?? 0) - (w.waitBy?.[d] ?? 0);
      armN[d] = (c.crossedBy[d] ?? 0) - (w.crossedBy?.[d] ?? 0);
      for (const q of st.queue[d]) { unserved++; unservedWait += st.t - q.t; armWait[d] += st.t - q.t; armN[d]++; }
    }
    for (const v of st.vehicles) if (v.phase === 'approach') { unservedWait += v.stopTime; armWait[v.origin] += v.stopTime; }
    const worstWait = Math.max(0, ...this.armList.map((d) => armWait[d] / Math.max(1, armN[d])));
    const exited = c.exited - w.exited;
    const pedDone = c.pedDone - w.pedDone;
    return {
      horizon, crossed,
      throughputVph: (crossed / horizon) * 3600,
      avgWait: (c.sumWait - w.sumWait + unservedWait) / Math.max(1, crossed + unserved),
      avgDelay: (c.sumDelay - w.sumDelay) / Math.max(1, exited),
      worstWait,
      maxQueue: st.maxQueue,
      dangers: c.dangers - w.dangers,
      collisions: c.collisions - w.collisions,
      errors: c.errors - w.errors,
      crossings: c.crossings - w.crossings,
      unserved,
      pedDone,
      pedAvgWait: (c.pedWaitSum - w.pedWaitSum) / Math.max(1, pedDone),
      pedDangers: c.pedDangers - w.pedDangers,
      pedHits: c.pedHits - w.pedHits,
      missedTurns: c.missedTurns - w.missedTurns,
      violations: c.violSolid + c.violStop + c.violRed + c.violTurn - (w.violSolid + w.violStop + w.violRed + w.violTurn),
      deadlocks: c.deadlocks - w.deadlocks,
      busServed: c.busServed - w.busServed,
    };
  }
}
