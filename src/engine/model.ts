// Загрузка модели из JSON: проверка структуры, заполнение пропущенных полей значениями по умолчанию
// и перевод файлов первой версии формата с четырьмя фиксированными подходами N, E, S, W во вторую.

import type { ArmConfig, CodeNode, ExitParams, LaneChooserParams, ModelConfig, PedConfig, SignalGroup, SpawnerParams, VehicleKind } from './types';
import { ARM_COLORS, SIM_DEFAULT, TIMING_DEFAULT, TRANSIT_EMPTY, genNodes, genPedGraph, pedEdgesAcross, reconcile, sideName } from './generate';
import { KOLPINO_PEDS, KOLPINO_TRANSIT } from './presets';
import { genControllerCode } from './codegen';
import { ModelFormatError } from './modelError';
import { LIMITS, clampInt, clampNum, limitedArray, limitedCode, safeColor, safeId, safeStr } from './limits';

export { ModelFormatError };

type Raw = Record<string, unknown>;
const isObj = (x: unknown): x is Raw => !!x && typeof x === 'object' && !Array.isArray(x);

const V1_ANGLES: Record<string, number> = { E: 0, N: 90, W: 180, S: 270 };
const V1_SHORT: Record<string, string> = { E: 'восток', N: 'север', W: 'запад', S: 'юг' };
const V1_COLORS: Record<string, string> = { N: '#4f8cff', S: '#d4455f', W: '#e8b10e', E: '#22a387' };

const ARM_DEFAULTS: Omit<ArmConfig, 'id' | 'name' | 'short' | 'angle' | 'color'> = {
  inLanes: 2, outLanes: 2, laneWidth: 3.5, medianWidth: 0, axisShift: 0, crosswalkOffset: 16, crosswalkWidth: 4,
  stopLineGap: 1.5, approachLength: 150, solidLength: 30, exitLength: 100, speedLimit: 60, hasCrosswalk: true, refuge: false,
};

/** Пределы чисел подхода: [минимум, максимум] */
const ARM_RANGE: Partial<Record<keyof typeof ARM_DEFAULTS, [number, number]>> = {
  inLanes: [0, LIMITS.lanesPerDirection], outLanes: [0, LIMITS.lanesPerDirection], laneWidth: [2.5, 6], medianWidth: [0, 40],
  axisShift: [-30, 30], crosswalkOffset: [0, 120], crosswalkWidth: [2, 12], stopLineGap: [0, 20], approachLength: [20, 800],
  solidLength: [0, 300], exitLength: [20, 800], speedLimit: [5, 130],
};

function fixArm(a: Raw, i: number): ArmConfig {
  if (!isObj(a)) throw new ModelFormatError(`Подход № ${i + 1} описан не объектом.`);
  const id = safeId(a.id ?? a.dir, `A${i + 1}`);
  const rawAngle = clampNum(a.angle, V1_ANGLES[id] ?? i * 90, -720, 720);
  const angle = rawAngle >= 0 && rawAngle < 360 ? rawAngle : ((rawAngle % 360) + 360) % 360;
  const merged = { ...ARM_DEFAULTS, ...a } as Raw;
  const num = (k: keyof typeof ARM_DEFAULTS) => {
    const [lo, hi] = ARM_RANGE[k] ?? [-1e6, 1e6];
    return clampNum(merged[k], ARM_DEFAULTS[k] as number, lo, hi);
  };
  const medianWidth = num('medianWidth');
  return {
    id,
    name: safeStr(a.name, `Дорога ${id}`),
    short: safeStr(a.short, V1_SHORT[id] ?? sideName(angle), 60),
    angle,
    inLanes: Math.round(num('inLanes')),
    outLanes: Math.round(num('outLanes')),
    laneWidth: num('laneWidth'),
    medianWidth,
    axisShift: num('axisShift'),
    crosswalkOffset: num('crosswalkOffset'),
    crosswalkWidth: num('crosswalkWidth'),
    stopLineGap: num('stopLineGap'),
    approachLength: num('approachLength'),
    solidLength: num('solidLength'),
    exitLength: num('exitLength'),
    speedLimit: num('speedLimit'),
    hasCrosswalk: merged.hasCrosswalk !== false,
    refuge: typeof a.refuge === 'boolean' ? a.refuge : id === 'W' && medianWidth >= 2,
    color: safeColor(a.color, V1_COLORS[id] ?? ARM_COLORS[i % ARM_COLORS.length]),
    ...(a.twoRows === false ? { twoRows: false } : {}),
  };
}

/** Перевод первой версии формата во вторую */
function migrateV1(raw: Raw): Raw {
  const armsRaw = raw.arms as Record<string, Raw>;
  const order = ['E', 'N', 'W', 'S'].filter((d) => armsRaw[d]);
  const arms = order.map((d, i) => fixArm({ ...armsRaw[d], id: d }, i));
  const isKolpino = order.join('') === 'ENWS' && armsRaw.W?.medianWidth !== undefined;
  const peds: PedConfig = isKolpino ? structuredClone(KOLPINO_PEDS) : genPedGraph(arms);
  const sim = { ...(raw.sim as Raw) };
  const oldPed = sim.pedestrians as { rate?: number; speedMin?: number; speedMax?: number } | undefined;
  delete sim.pedestrians;
  if (oldPed) {
    const total = peds.sources.reduce((a, s) => a + s.rate, 0) || 1;
    for (const s of peds.sources) {
      if (typeof oldPed.rate === 'number') s.rate = Math.round((s.rate / total) * oldPed.rate);
      if (typeof oldPed.speedMin === 'number') s.speedMin = oldPed.speedMin;
      if (typeof oldPed.speedMax === 'number') s.speedMax = oldPed.speedMax;
    }
  }
  const signals = structuredClone(raw.signals) as Raw;
  const tmp = { arms, peds, connections: raw.connections, signals } as unknown as ModelConfig;
  for (const g of (signals.groups as SignalGroup[]) ?? []) {
    if (g.kind === 'pedestrian' && (!g.movements || g.movements.length === 0)) g.movements = pedEdgesAcross(tmp, g.arm);
  }
  return { ...raw, format: 'crossroad-model', version: 2, description: raw.description ?? '', arms, peds, signals, sim, transit: isKolpino ? KOLPINO_TRANSIT() : TRANSIT_EMPTY() };
}

/** Проверка и нормализация модели из JSON. Бросает ModelFormatError, если файл не похож на модель. */
// ---------- узлы ----------
// Узел без ручных правок хранит только параметры, код для показа пересоздаётся при загрузке.
// Узел с ручными правками хранит код TypeScript, он запускается в песочнице.

const finite = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** Словарь «ключ → неотрицательное число» с ограничением числа ключей */
const numRecord = (v: unknown, maxKeys = 64, max = 1e6): Record<string, number> => {
  const out: Record<string, number> = {};
  if (!isObj(v)) return out;
  const entries = Object.entries(v);
  if (entries.length > maxKeys) throw new ModelFormatError(`В файле слишком много направлений: ${entries.length}, допустимо не больше ${maxKeys}.`);
  for (const [k, x] of entries) out[safeId(k, k.slice(0, LIMITS.id))] = clampNum(x, 0, 0, max);
  return out;
};
const KINDS = ['car', 'van', 'truck', 'bus'];

/** Наибольшая интенсивность, авт/ч на подход */
const MAX_RATE = 10000;

function fixSpawner(p: Raw): SpawnerParams | null {
  const types = limitedArray(p.types, LIMITS.vehicleTypes, 'типы машин').filter(isObj).map((t) => {
    const lengthMin = clampNum(t.lengthMin, 4.2, 2, 25);
    return {
      kind: (KINDS.includes(String(t.kind)) ? t.kind : 'car') as VehicleKind,
      share: clampNum(t.share, 0, 0, 1e6),
      lengthMin,
      lengthMax: clampNum(t.lengthMax, Math.max(lengthMin, 4.9), lengthMin, 25),
    };
  });
  return {
    arrival: p.arrival === 'uniform' || p.arrival === 'platoon' ? p.arrival : 'poisson',
    rate: clampNum(p.rate, 300, 0, MAX_RATE),
    profile: limitedArray(p.profile, LIMITS.profilePoints, 'точки профиля').filter(isObj).map((x) => ({ from: clampNum(x.from, 0, 0, 1e7), rate: clampNum(x.rate, 0, 0, MAX_RATE) })),
    platoonSize: clampInt(p.platoonSize, 4, 1, 50),
    destinations: numRecord(p.destinations, LIMITS.arms),
    types: types.length ? types : [{ kind: 'car', share: 1, lengthMin: 4.2, lengthMax: 4.9 }],
    ...(isObj(p.drivers) ? { drivers: fixSpawnDrivers(p.drivers) } : {}),
  };
}

/** Диапазоны параметров водителей узла появления */
function fixSpawnDrivers(d: Raw): NonNullable<SpawnerParams['drivers']> {
  const r = (x: unknown, dmin: number, dmax: number, lo: number, hi: number) => {
    const o = isObj(x) ? x : {};
    const min = clampNum(o.min, dmin, lo, hi);
    return { min, max: clampNum(o.max, Math.max(min, dmax), min, hi), dist: (o.dist === 'normal' || o.dist === 'triangular' ? o.dist : 'uniform') as 'uniform' | 'normal' | 'triangular' };
  };
  const D = SIM_DEFAULT.drivers;
  return {
    accel: r(d.accel, D.accelMin, D.accelMax, 0.3, 6), speed: r(d.speed, D.speedMin, D.speedMax, 0.3, 1.5),
    headway: r(d.headway, D.headwayMin, D.headwayMax, 0.4, 4), gap: r(d.gap, D.gap, D.gap, 0.5, 5), reaction: r(d.reaction, D.reactionMin, D.reactionMax, 0, 3),
  };
}

/** Параметры водителей по умолчанию для узла появления: из общих настроек */
export function defaultSpawnDrivers(sim: ModelConfig['sim']): NonNullable<SpawnerParams['drivers']> {
  const d = sim.drivers;
  return {
    accel: { min: d.accelMin, max: d.accelMax, dist: 'uniform' }, speed: { min: d.speedMin, max: d.speedMax, dist: 'uniform' },
    headway: { min: d.headwayMin, max: d.headwayMax, dist: 'uniform' }, gap: { min: d.gap, max: d.gap, dist: 'uniform' },
    reaction: { min: d.reactionMin, max: d.reactionMax, dist: 'uniform' },
  };
}

function fixChooser(p: Raw): LaneChooserParams | null {
  const weights: Record<string, number[]> = {};
  if (isObj(p.weights)) {
    const entries = Object.entries(p.weights);
    if (entries.length > LIMITS.arms) throw new ModelFormatError(`В файле слишком много направлений у выбора полосы: ${entries.length}.`);
    for (const [k, w] of entries) weights[safeId(k, k.slice(0, LIMITS.id))] = limitedArray(w, LIMITS.lanesPerDirection, 'веса полос').map((x) => clampNum(x, 0, 0, 1e6));
  }
  return { strategy: p.strategy === 'shortestQueue' ? 'shortestQueue' : 'weights', preLaned: clampNum(p.preLaned, 0.7, 0, 1), weights };
}

function fixExit(p: Raw): ExitParams | null {
  return {
    capacityPerLane: clampNum(p.capacityPerLane, 0, 0, MAX_RATE),
    blocked: limitedArray(p.blocked, LIMITS.exitBlocks, 'интервалы блокировки выезда').filter(isObj).map((b) => ({ from: clampNum(b.from, 0, 0, 1e7), to: clampNum(b.to, 0, 0, 1e7) })),
  };
}

function normalizeNodes<P>(raw: unknown, arms: ArmConfig[], fix: (p: Raw) => P | null): Record<string, CodeNode<P>> {
  const out: Record<string, CodeNode<P>> = {};
  if (!isObj(raw)) return out;
  for (const a of arms) {
    const n = raw[a.id];
    if (!isObj(n) || !isObj(n.params)) continue;
    const params = fix(n.params);
    if (!params) continue;
    const code = limitedCode(n.code, `узел ${a.id}`);
    const manual = n.manual === true && code.trim() !== '';
    out[a.id] = { id: safeId(n.id, a.id), params, code: manual ? code : '', manual };
  }
  return out;
}

const BASEMAP_KINDS = ['building', 'road', 'path', 'water', 'green', 'rail', 'parking', 'area'];
/** Встроенные в приложение подложки */
const BUILTIN_BASEMAPS = ['kolpino'];

/** Подложка: объекты из файла или ссылка на встроенную подложку приложения. Координаты только числами */
export function normalizeBasemap(raw: unknown): ModelConfig['basemap'] {
  if (!isObj(raw)) return null;
  const r = raw as Raw;
  const builtin = typeof r.builtin === 'string' && BUILTIN_BASEMAPS.includes(r.builtin) ? r.builtin : undefined;
  if (!builtin && !Array.isArray(r.features)) return null;
  const o = isObj(r.origin) ? (r.origin as Raw) : {};
  const features: NonNullable<ModelConfig['basemap']>['features'] = [];
  if (!builtin) {
    let numbers = 0;
    for (const x of limitedArray(r.features, LIMITS.basemapFeatures, 'объекты подложки')) {
      if (!isObj(x) || !BASEMAP_KINDS.includes(String(x.k)) || !Array.isArray(x.g)) continue;
      const g = x.g as unknown[];
      if (g.length < 4 || g.length % 2 !== 0 || !g.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e5)) continue;
      numbers += g.length;
      if (numbers > LIMITS.basemapNumbers) throw new ModelFormatError(`В подложке слишком много точек, допустимо не больше ${LIMITS.basemapNumbers / 2}.`);
      const f: (typeof features)[number] = { k: x.k as (typeof features)[number]['k'], g: g as number[], closed: x.closed === true };
      if (x.name !== undefined) f.name = safeStr(x.name, '', 120);
      if (x.hw !== undefined) f.hw = safeStr(x.hw, '', 32);
      features.push(f);
    }
  }
  return {
    ...(builtin ? { builtin } : {}),
    origin: { lat: clampNum(o.lat, 0, -90, 90), lon: clampNum(o.lon, 0, -180, 180) },
    rotation: clampNum(r.rotation, 0, -360, 360),
    dx: clampNum(r.dx, 0, -2000, 2000),
    dy: clampNum(r.dy, 0, -2000, 2000),
    features,
    attribution: safeStr(r.attribution, '© участники OpenStreetMap, лицензия ODbL', 300),
  };
}

/** Настройки симуляции: каждое число в своём диапазоне */
const SIM_RANGE: Partial<Record<keyof ModelConfig['sim'], [number, number]>> = {
  dt: [0.02, 0.5], seed: [0, 2147483647], riskyShare: [0, 1], obstructedVisibility: [1, 500], normalVisibility: [1, 2000],
  criticalGapLeft: [0.5, 20], criticalGapOther: [0.5, 20], petDanger: [0, 10], petWindow: [0, 30], ttcDanger: [0, 10],
  crashDuration: [0, 36000], lcPatience: [0, 120], deadlockSeconds: [3, 600], deadlockBreak: [0, 3600],
  slowdownWindow: [30, 1800], slowdownRatio: [0.05, 1], noProgressSeconds: [10, 3600], historySeconds: [0, 1800],
};

function normalizeSim(raw: unknown): ModelConfig['sim'] {
  const r = isObj(raw) ? raw : {};
  const sim = structuredClone(SIM_DEFAULT);
  const out = sim as unknown as Raw;
  for (const [k, range] of Object.entries(SIM_RANGE) as Array<[keyof ModelConfig['sim'], [number, number]]>) {
    out[k] = clampNum(r[k], SIM_DEFAULT[k] as number, range[0], range[1]);
  }
  sim.seed = Math.round(sim.seed);
  sim.crashPersist = typeof r.crashPersist === 'boolean' ? r.crashPersist : SIM_DEFAULT.crashPersist;
  sim.missedTurn = r.missedTurn === 'wait' ? 'wait' : 'reroute';
  sim.pathSpread = typeof r.pathSpread === 'boolean' ? r.pathSpread : SIM_DEFAULT.pathSpread;
  const dr = isObj(r.drivers) ? r.drivers : {};
  const D = SIM_DEFAULT.drivers;
  const accelMin = clampNum(dr.accelMin, D.accelMin, 0.5, 6), speedMin = clampNum(dr.speedMin, D.speedMin, 0.3, 1.5), headwayMin = clampNum(dr.headwayMin, D.headwayMin, 0.4, 4);
  sim.drivers = {
    accelMin, accelMax: clampNum(dr.accelMax, D.accelMax, accelMin, 6), heavyAccel: clampNum(dr.heavyAccel, D.heavyAccel, 0.3, 4),
    speedMin, speedMax: clampNum(dr.speedMax, D.speedMax, speedMin, 1.5),
    headwayMin, headwayMax: clampNum(dr.headwayMax, D.headwayMax, headwayMin, 4),
    gap: clampNum(dr.gap, D.gap, 0.5, 5), riskyFactor: clampNum(dr.riskyFactor, D.riskyFactor, 0.3, 1),
    reactionMin: clampNum(dr.reactionMin, D.reactionMin, 0, 3), reactionMax: 0,
  };
  sim.drivers.reactionMax = clampNum(dr.reactionMax, D.reactionMax, sim.drivers.reactionMin, 3);
  sim.implicitShift = clampNum(r.implicitShift, SIM_DEFAULT.implicitShift, 0, 3);
  sim.implicitBend = clampNum(r.implicitBend, SIM_DEFAULT.implicitBend, 0, 3);
  sim.trajectoryChoice = r.trajectoryChoice === 'free' ? 'free' : 'random';
  const v = isObj(r.violations) ? r.violations : {};
  for (const k of Object.keys(sim.violations) as Array<keyof ModelConfig['sim']['violations']>) sim.violations[k] = clampNum(v[k], SIM_DEFAULT.violations[k], 0, 1);
  return sim;
}

/** Ссылка на полосу: подход и номер полосы */
const laneRef = (x: unknown): { arm: string; lane: number } => {
  const o = isObj(x) ? x : {};
  return { arm: safeId(o.arm, ''), lane: clampInt(o.lane, 0, 0, LIMITS.lanesPerDirection - 1) };
};

function normalizeSignals(raw: Raw): ModelConfig['signals'] {
  const tm = isObj(raw.timing) ? raw.timing : {};
  const timing = {
    yellow: clampNum(tm.yellow, TIMING_DEFAULT.yellow, 0, 10),
    redYellow: clampNum(tm.redYellow, TIMING_DEFAULT.redYellow, 0, 5),
    flashGreen: clampNum(tm.flashGreen, TIMING_DEFAULT.flashGreen, 0, 10),
    allRed: clampNum(tm.allRed, TIMING_DEFAULT.allRed, 0, 30),
    pedClearance: clampNum(tm.pedClearance, TIMING_DEFAULT.pedClearance, 0, 30),
  };
  const groups = limitedArray(raw.groups, LIMITS.groups, 'сигнальные группы').filter(isObj).map((x, i) => {
    const g = { ...x } as Raw;
    g.id = safeId(x.id, `G${i + 1}`);
    g.name = safeStr(x.name, '') || String(g.id);
    g.kind = x.kind === 'arrow' || x.kind === 'pedestrian' ? x.kind : 'vehicle';
    g.arm = safeId(x.arm, '');
    g.movements = limitedArray(x.movements, LIMITS.connections, 'направления группы').map((m) => safeId(m, ''));
    g.color = safeColor(x.color, '#9aa3b2');
    if (g.kind === 'vehicle' && x.pedInfo === true) g.pedInfo = true;
    else delete g.pedInfo;
    if (g.kind !== 'arrow') { delete g.parent; delete g.side; }
    else {
      if (x.parent !== undefined) g.parent = safeId(x.parent, '');
      if (x.side !== 'left' && x.side !== 'right') delete g.side;
    }
    for (const k of Object.keys(g)) if (!['id', 'name', 'kind', 'arm', 'movements', 'color', 'parent', 'side', 'pedInfo'].includes(k)) delete g[k];
    return g as unknown as SignalGroup;
  });
  const phases = limitedArray(raw.phases, LIMITS.phases, 'фазы').filter(isObj).map((x, i) => {
    const p = { ...x } as Raw;
    p.id = safeId(x.id, `P${i + 1}`);
    p.name = safeStr(x.name, '') || String(p.id);
    p.duration = clampInt(x.duration, 1, 1, 600);
    p.green = limitedArray(x.green, LIMITS.groups, 'группы фазы').map((m) => safeId(m, ''));
    for (const k of Object.keys(p)) if (!['id', 'name', 'duration', 'green'].includes(k)) delete p[k];
    return p as unknown as ModelConfig['signals']['phases'][number];
  });
  return {
    groups, phases, timing,
    offset: clampNum(raw.offset, 0, -3600, 3600),
    controller: raw.controller === 'code' ? 'code' : 'fixed',
    code: limitedCode(raw.code, 'контроллер светофора'),
  };
}

function normalizePeds(raw: unknown, arms: ArmConfig[]): PedConfig {
  if (!isObj(raw)) return genPedGraph(arms);
  const nodes = limitedArray(raw.nodes, LIMITS.pedNodes, 'пешеходные узлы').filter(isObj).map((x, i) => {
    const n = { ...x } as Raw;
    n.id = safeId(x.id, `P${i + 1}`);
    n.kind = x.kind === 'island' || x.kind === 'point' ? x.kind : 'corner';
    n.arms = limitedArray(x.arms, LIMITS.arms, 'подходы узла').map((a) => safeId(a, ''));
    n.label = safeStr(x.label, '') || String(n.id);
    if (x.x !== undefined) n.x = clampNum(x.x, 0, -3000, 3000);
    if (x.y !== undefined) n.y = clampNum(x.y, 0, -3000, 3000);
    n.dx = clampNum(x.dx, 0, -500, 500);
    n.dy = clampNum(x.dy, 0, -500, 500);
    for (const k of Object.keys(n)) if (!['id', 'kind', 'arms', 'label', 'x', 'y', 'dx', 'dy'].includes(k)) delete n[k];
    return n as unknown as PedConfig['nodes'][number];
  });
  const edges = limitedArray(raw.edges, LIMITS.pedEdges, 'пешеходные переходы').filter(isObj).map((x, i) => {
    const e = { ...x } as Raw;
    e.id = safeId(x.id, `X${i + 1}`);
    e.from = safeId(x.from, '');
    e.to = safeId(x.to, '');
    e.width = clampNum(x.width, 4, 1, 12);
    for (const k of Object.keys(e)) if (!['id', 'from', 'to', 'width'].includes(k)) delete e[k];
    return e as unknown as PedConfig['edges'][number];
  });
  const sources = limitedArray(raw.sources, LIMITS.pedSources, 'источники пешеходов').filter(isObj).map((x) => {
    const s = { ...x } as Raw;
    s.node = safeId(x.node, '');
    s.rate = clampNum(x.rate, 0, 0, 20000);
    const groups = limitedArray(x.groups, LIMITS.pedGroupSizes, 'размеры групп').filter(isObj).map((g) => ({ size: clampInt(g.size, 1, 1, 20), share: clampNum(g.share, 0, 0, 1e6) }));
    s.groups = groups.length ? groups : [{ size: 1, share: 1 }];
    s.speedMin = clampNum(x.speedMin, 1.0, 0.3, 3);
    s.speedMax = clampNum(x.speedMax, 1.6, s.speedMin as number, 3);
    s.destinations = numRecord(x.destinations, LIMITS.pedNodes);
    for (const k of Object.keys(s)) if (!['node', 'rate', 'groups', 'speedMin', 'speedMax', 'destinations'].includes(k)) delete s[k];
    return s as unknown as PedConfig['sources'][number];
  });
  return { nodes, edges, sources };
}

/** Проверка и нормализация модели из JSON. Бросает ModelFormatError, если файл не похож на модель или выходит за пределы */
export function normalizeModel(input: unknown): ModelConfig {
  let raw = input;
  if (isObj(raw) && isObj(raw.cfg)) raw = raw.cfg;
  if (!isObj(raw)) throw new ModelFormatError('Файл не содержит объекта модели.');
  if (!raw.arms || !isObj(raw.signals)) throw new ModelFormatError('В файле нет обязательных разделов «arms» и «signals».');
  if (!Array.isArray(raw.arms) && isObj(raw.arms) && Object.keys(raw.arms).length > LIMITS.arms) throw new ModelFormatError('В файле слишком много подходов.');
  if (raw.version === 1 || (!Array.isArray(raw.arms) && isObj(raw.arms))) raw = migrateV1(raw);
  const r = raw as Raw;
  if (!Array.isArray(r.arms)) throw new ModelFormatError('Раздел «arms» должен быть массивом подходов.');
  const arms = limitedArray(r.arms, LIMITS.arms, 'подходы').map((a, i) => fixArm(a as Raw, i));
  const ids = arms.map((a) => a.id);
  if (new Set(ids).size !== ids.length) throw new ModelFormatError('У подходов повторяются id.');
  if (arms.length < 2) throw new ModelFormatError('Нужно хотя бы два подхода.');
  const sig = normalizeSignals(r.signals as Raw);
  if (!sig.code) sig.code = genControllerCode(sig);
  const connections = limitedArray(r.connections, LIMITS.connections, 'связи полос').filter(isObj).map((x, i) => {
    const c: ModelConfig['connections'][number] = { id: safeId(x.id, `C${i + 1}`), from: laneRef(x.from), to: laneRef(x.to) };
    if (x.busOnly === true) c.busOnly = true;
    const vs = limitedArray(x.variants, 4, 'траектории направления').filter(isObj).map((v) => ({ shiftIn: clampNum(v.shiftIn, 0, -3, 3), bend: clampNum(v.bend, 0, -5, 5) }));
    if (vs.length) c.variants = vs;
    return c;
  });
  const cfg: ModelConfig = {
    format: 'crossroad-model',
    version: 2,
    name: safeStr(r.name, 'Перекрёсток'),
    description: safeStr(r.description, '', LIMITS.description),
    arms,
    connections,
    peds: normalizePeds(r.peds, arms),
    signals: sig,
    transit: normalizeTransit(r.transit),
    spawners: normalizeNodes(r.spawners, arms, fixSpawner) as ModelConfig['spawners'],
    laneChoosers: normalizeNodes(r.laneChoosers, arms, fixChooser) as ModelConfig['laneChoosers'],
    exits: normalizeNodes(r.exits, arms, fixExit) as ModelConfig['exits'],
    sim: normalizeSim(r.sim),
    basemap: normalizeBasemap(r.basemap),
  };
  const nodes = genNodes(cfg);
  cfg.spawners = nodes.spawners;
  cfg.laneChoosers = nodes.laneChoosers;
  cfg.exits = nodes.exits;
  return reconcile(cfg);
}

function normalizeTransit(x: unknown): ModelConfig['transit'] {
  const t = TRANSIT_EMPTY();
  if (!isObj(x)) return t;
  t.enabled = x.enabled !== false;
  t.dwellMin = clampNum(x.dwellMin, t.dwellMin, 1, 1800);
  t.dwellMax = clampNum(x.dwellMax, Math.max(t.dwellMin, t.dwellMax), t.dwellMin, 1800);
  t.stops = limitedArray(x.stops, LIMITS.stops, 'остановки').filter(isObj).map((s, i) => ({
    id: safeId(s.id, `ST${i + 1}`), name: safeStr(s.name, `Остановка ${i + 1}`), arm: safeId(s.arm, ''),
    side: s.side === 'approach' ? 'approach' : 'exit', dist: clampNum(s.dist, 20, 0, 800) || 20, bay: s.bay !== false,
  }));
  t.routes = limitedArray(x.routes, LIMITS.routes, 'маршруты').filter(isObj).map((r, i) => {
    const route: ModelConfig['transit']['routes'][number] = {
      id: safeId(r.id, `R${i + 1}`), name: safeStr(r.name, `Маршрут ${i + 1}`), from: safeId(r.from, ''), to: safeId(r.to, ''),
      stops: limitedArray(r.stops, LIMITS.routeStops, 'остановки маршрута').map((s) => safeId(s, '')), perHour: clampNum(r.perHour, 0, 0, 120),
      length: clampNum(r.length, 12, 6, 25), headway: typeof r.headway === 'string' ? safeStr(r.headway, '', 40) : undefined, enabled: r.enabled !== false,
    };
    return route;
  });
  return t;
}

/** Модель для сохранения в файл: тот же объект, но с упорядоченными ключами формата */
export function serializeModel(cfg: ModelConfig): string {
  const { format, version, name, description, arms, connections, peds, transit, sim, basemap } = cfg;
  // узлы по параметрам — без кода, узлы с ручными правками — с кодом TypeScript
  const nodes = <P>(rec: Record<string, CodeNode<P>>) => {
    const out: Record<string, unknown> = {};
    for (const [k, n] of Object.entries(rec)) out[k] = n.manual ? { id: n.id, params: n.params, code: n.code, manual: true } : { id: n.id, params: n.params, manual: false };
    return out;
  };
  const sg = cfg.signals;
  const signals = { groups: sg.groups, phases: sg.phases, timing: sg.timing, offset: sg.offset, controller: sg.controller, ...(sg.controller === 'code' ? { code: sg.code } : {}) };
  const bm = basemap ? (basemap.builtin ? { ...basemap, features: [] } : basemap) : null;
  return JSON.stringify({ format, version, name, description, arms, connections, peds, signals, transit, spawners: nodes(cfg.spawners), laneChoosers: nodes(cfg.laneChoosers), exits: nodes(cfg.exits), sim, basemap: bm }, null, 2);
}
