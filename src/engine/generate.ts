// Автоматическая генерация частей модели по набору подходов: разрешённые направления,
// пешеходный граф (углы, островки, переходы), сигнальные группы и фазы, узлы с кодом.
// Нужна редактору схемы: можно описать только подходы, а остальное достроить и поправить руками.

import type {
  ArmConfig, ArmId, CodeNode, Connection, ExitParams, LaneChooserParams, ModelConfig, PedConfig, PedEdge,
  PedNode, PedSource, Phase, SignalGroup, SignalProgram, SimSettings, SpawnerParams, TransitConfig, VehicleTypeParams,
} from './types';
import { angleDeg, armRelations, buildNetwork, turnKindByAngle } from './network';
import { genControllerCode, genExitCode, genLaneChooserCode, genSpawnerCode } from './codegen';

export const ARM_COLORS = ['#22a387', '#4f8cff', '#d4455f', '#f2a33a', '#a970ff', '#3fc1d9', '#e86fb0', '#9bc53d'];
export const PED_COLOR = '#9aa3b2';

export const VEHICLE_TYPES: VehicleTypeParams[] = [
  { kind: 'car', share: 0.85, lengthMin: 4.2, lengthMax: 4.9 },
  { kind: 'van', share: 0.08, lengthMin: 5.4, lengthMax: 6.6 },
  { kind: 'truck', share: 0.04, lengthMin: 9, lengthMax: 12 },
  { kind: 'bus', share: 0.03, lengthMin: 11.5, lengthMax: 12.5 },
];

export const PED_GROUPS_DEFAULT = [
  { size: 1, share: 0.7 },
  { size: 2, share: 0.22 },
  { size: 3, share: 0.06 },
  { size: 4, share: 0.02 },
];

export const TIMING_DEFAULT = { yellow: 3, redYellow: 2, flashGreen: 3, allRed: 0, pedClearance: 3 };

export const SIM_DEFAULT: SimSettings = {
  dt: 0.1,
  seed: 42,
  riskyShare: 0.15,
  obstructedVisibility: 20,
  normalVisibility: 150,
  criticalGapLeft: 5,
  criticalGapOther: 4,
  petDanger: 1.5,
  petWindow: 5,
  ttcDanger: 1.0,
  crashPersist: true,
  crashDuration: 1200,
  missedTurn: 'reroute',
  lcPatience: 6,
  violations: { solidLine: 0.25, stopLine: 0.3, redLight: 0.15, illegalTurn: 0.1 },
  deadlockSeconds: 15,
  deadlockBreak: 30,
  slowdownWindow: 120,
  slowdownRatio: 0.5,
  noProgressSeconds: 90,
  historySeconds: 300,
};

export const TRANSIT_EMPTY = (): TransitConfig => ({ enabled: false, stops: [], routes: [], dwellMin: 60, dwellMax: 90 });

const SIDE_NAMES: Array<[number, string]> = [
  [0, 'восток'], [45, 'северо-восток'], [90, 'север'], [135, 'северо-запад'],
  [180, 'запад'], [225, 'юго-запад'], [270, 'юг'], [315, 'юго-восток'], [360, 'восток'],
];

/** Название стороны света по углу */
export function sideName(angle: number): string {
  const a = angleDeg(angle);
  let best = SIDE_NAMES[0];
  for (const s of SIDE_NAMES) if (Math.abs(s[0] - a) < Math.abs(best[0] - a)) best = s;
  return best[1];
}

export function newArm(id: ArmId, angle: number, i = 0): ArmConfig {
  return {
    id, name: `Дорога ${id}`, short: sideName(angle), angle,
    inLanes: 2, outLanes: 2, laneWidth: 3.5, medianWidth: 0, axisShift: 0,
    crosswalkOffset: 16, crosswalkWidth: 4, stopLineGap: 1.5,
    approachLength: 150, solidLength: 30, exitLength: 100, speedLimit: 60,
    hasCrosswalk: true, refuge: false, color: ARM_COLORS[i % ARM_COLORS.length],
  };
}

export const connId = (fa: ArmId, fl: number, ta: ArmId, tl: number) => `${fa}${fl}-${ta}${tl}`;

export const conn = (fa: ArmId, fl: number, ta: ArmId, tl: number): Connection => ({
  id: connId(fa, fl, ta, tl),
  from: { arm: fa, lane: fl },
  to: { arm: ta, lane: tl },
});

/**
 * Разрешённые направления по типовой схеме: левые повороты — из левых полос, правые — из правых,
 * прямо — из средних. Если полос меньше, чем направлений, крайние полосы совмещают направления.
 * Левый поворот — в левую полосу выезда, правый — в правую (ПДД 8.6).
 */
export function genConnections(arms: ArmConfig[]): Connection[] {
  const out: Connection[] = [];
  for (const a of arms) {
    const n = a.inLanes;
    if (n <= 0) continue;
    const targets = arms
      .filter((b) => b.id !== a.id && b.outLanes > 0)
      .map((b) => {
        const rel = ((angleDeg(b.angle - (a.angle + 180)) + 540) % 360) - 180;
        return { b, rel, kind: turnKindByAngle(a, b) };
      })
      .sort((x, y) => y.rel - x.rel);
    const m = targets.length;
    if (!m) continue;
    const lanesFor: number[][] = targets.map(() => []);
    if (n >= m) {
      // каждому направлению хотя бы по полосе, лишние — прямому (или среднему) направлению
      const counts = targets.map(() => 1);
      const extraTo = Math.max(0, targets.findIndex((t) => t.kind === 'straight'));
      const mid = targets.some((t) => t.kind === 'straight') ? extraTo : Math.floor(m / 2);
      counts[mid] += n - m;
      let lane = 0;
      counts.forEach((c, ti) => { for (let k = 0; k < c; k++) lanesFor[ti].push(lane++); });
    } else {
      for (let i = 0; i < n; i++) {
        const lo = Math.floor((i * m) / n);
        const hi = Math.max(lo, Math.ceil(((i + 1) * m) / n) - 1);
        for (let ti = lo; ti <= hi; ti++) lanesFor[ti].push(i);
      }
    }
    targets.forEach((t, ti) => {
      const lanes = lanesFor[ti];
      const k = lanes.length;
      const nOut = t.b.outLanes;
      lanes.forEach((lane, j) => {
        let to: number;
        if (t.kind === 'left' || t.kind === 'uturn') to = Math.min(nOut - 1, j);
        else if (t.kind === 'right') to = Math.max(0, nOut - k + j);
        else to = k <= 1 ? Math.min(nOut - 1, Math.round(((lane + 0.5) / n) * nOut - 0.5)) : Math.round((j * (nOut - 1)) / (k - 1));
        out.push(conn(a.id, lane, t.b.id, Math.max(0, Math.min(nOut - 1, to))));
      });
    });
  }
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

export const cornerId = (a: ArmId, b: ArmId) => `C-${a}-${b}`;
export const islandId = (a: ArmId) => `I-${a}`;
export const pedEdgeId = (from: string, to: string) => `${from}~${to}`;

/** Пешеходный граф: углы между соседними подходами, островки на разделителях, переходы через каждый подход */
export function genPedGraph(arms: ArmConfig[], ratePerCorner = 60): PedConfig {
  const order = [...arms].sort((a, b) => angleDeg(a.angle) - angleDeg(b.angle));
  const nodes: PedNode[] = [];
  const edges: PedEdge[] = [];
  if (order.length < 2) return { nodes, edges, sources: [] };
  const corners: string[] = [];
  for (let k = 0; k < order.length; k++) {
    const g = order[k], h = order[(k + 1) % order.length];
    const id = cornerId(g.id, h.id);
    corners.push(id);
    nodes.push({ id, kind: 'corner', arms: [g.id, h.id], label: `угол ${g.short}–${h.short}`, dx: 0, dy: 0 });
  }
  for (let k = 0; k < order.length; k++) {
    const a = order[k];
    if (!a.hasCrosswalk) continue;
    // переход через подход a — между углами (пред., a) и (a, след.)
    const before = corners[(k - 1 + order.length) % order.length];
    const after = corners[k];
    if (before === after) continue;
    if (a.refuge && a.medianWidth >= 1.5) {
      const iid = islandId(a.id);
      nodes.push({ id: iid, kind: 'island', arms: [a.id], label: `островок ${a.short}`, dx: 0, dy: 0 });
      edges.push({ id: pedEdgeId(after, iid), from: after, to: iid, width: a.crosswalkWidth });
      edges.push({ id: pedEdgeId(iid, before), from: iid, to: before, width: a.crosswalkWidth });
    } else edges.push({ id: pedEdgeId(after, before), from: after, to: before, width: a.crosswalkWidth });
  }
  const sources: PedSource[] = corners.map((c) => ({
    node: c,
    rate: ratePerCorner,
    groups: PED_GROUPS_DEFAULT.map((g) => ({ ...g })),
    speedMin: 1.0,
    speedMax: 1.6,
    destinations: Object.fromEntries(corners.filter((x) => x !== c).map((x) => [x, 1])),
  }));
  return { nodes, edges, sources };
}

/** Рёбра пешеходного графа, которые идут через подход arm (включая половины до островка) */
export function pedEdgesAcross(cfg: Pick<ModelConfig, 'arms' | 'peds' | 'connections' | 'signals'> & Partial<ModelConfig>, arm: ArmId): string[] {
  const nodes = new Map(cfg.peds.nodes.map((n) => [n.id, n]));
  return cfg.peds.edges
    .filter((e) => {
      const a = nodes.get(e.from), b = nodes.get(e.to);
      if (!a || !b) return false;
      return a.arms.includes(arm) && b.arms.includes(arm);
    })
    .map((e) => e.id);
}

/**
 * Сигнальная программа по типовой схеме: по одной транспортной группе на подход,
 * по одной пешеходной группе на переход, фазы — пары встречных подходов по очереди,
 * в конце — единая пешеходная фаза (ЕПФ).
 */
export function genSignals(arms: ArmConfig[], connections: Connection[], peds: PedConfig): SignalProgram {
  const groups: SignalGroup[] = [];
  for (const a of arms) {
    const mv = connections.filter((c) => c.from.arm === a.id).map((c) => c.id);
    if (!mv.length) continue;
    groups.push({ id: a.id, name: `${a.name}`, kind: 'vehicle', arm: a.id, movements: mv, color: a.color });
  }
  const tmp = { arms, peds, connections, signals: { groups: [], phases: [], timing: TIMING_DEFAULT, offset: 0, controller: 'fixed', code: '' } } as unknown as ModelConfig;
  const pedIds: string[] = [];
  for (const a of arms) {
    const edges = pedEdgesAcross(tmp, a.id);
    if (!edges.length) continue;
    const id = `P${a.id}`;
    pedIds.push(id);
    groups.push({ id, name: `Пешеходы через ${a.short}`, kind: 'pedestrian', arm: a.id, movements: edges, color: PED_COLOR });
  }
  const rel = armRelations(arms);
  const used = new Set<ArmId>();
  const phases: Phase[] = [];
  const order = [...arms].sort((a, b) => angleDeg(a.angle) - angleDeg(b.angle));
  for (const a of order) {
    if (used.has(a.id) || !groups.some((g) => g.id === a.id)) continue;
    const o = rel.opposite[a.id];
    const pair = o && !used.has(o) && groups.some((g) => g.id === o) ? [a.id, o] : [a.id];
    pair.forEach((x) => used.add(x));
    const names = pair.map((x) => arms.find((q) => q.id === x)!.short).join(' и ');
    phases.push({ id: `F${phases.length + 1}`, name: `${phases.length + 1}: ${names}`, duration: 25, green: pair });
  }
  if (pedIds.length) {
    const prog = { groups, phases, timing: TIMING_DEFAULT } as SignalProgram;
    const cfgTmp = { ...tmp, signals: prog } as ModelConfig;
    const need = pedMinGreen(cfgTmp, pedIds);
    phases.push({ id: 'EPF', name: `${phases.length + 1}: единая пешеходная фаза`, duration: Math.max(12, Math.ceil(need)), green: pedIds });
  }
  const p: SignalProgram = { groups, phases, timing: { ...TIMING_DEFAULT }, offset: 0, controller: 'fixed', code: '' };
  p.code = genControllerCode(p);
  return p;
}

/**
 * Минимальная длительность разрешающего сигнала для пешеходных групп, с.
 * По проекту нового стандарта: t = B / V + 5, где B — длина перехода (до островка, если он есть), V = 1,2 м/с.
 */
export function pedMinGreen(cfg: ModelConfig, groupIds: string[]): number {
  let need = 0;
  const net = buildNetwork(cfg);
  for (const g of cfg.signals.groups) {
    if (g.kind !== 'pedestrian' || !groupIds.includes(g.id)) continue;
    for (const eid of g.movements) {
      const ei = net.pedEdgeById.get(eid);
      if (ei === undefined) continue;
      const e = net.pedEdges[ei];
      need = Math.max(need, (e.roadS1 - e.roadS0) / 1.2 + 5);
    }
  }
  return need;
}

/** Доли направлений по умолчанию: прямо больше, повороты меньше */
export function defaultDestinations(arms: ArmConfig[], connections: Connection[], from: ArmId): Record<ArmId, number> {
  const a = arms.find((x) => x.id === from);
  const out: Record<ArmId, number> = {};
  if (!a) return out;
  const targets = [...new Set(connections.filter((c) => c.from.arm === from).map((c) => c.to.arm))];
  for (const t of targets) {
    const b = arms.find((x) => x.id === t);
    if (!b) continue;
    const k = turnKindByAngle(a, b);
    out[t] = k === 'straight' ? 0.6 : k === 'uturn' ? 0.02 : 0.2;
  }
  const sum = Object.values(out).reduce((x, y) => x + y, 0) || 1;
  for (const k of Object.keys(out)) out[k] = +(out[k] / sum).toFixed(3);
  return out;
}

export function laneWeights(arm: ArmConfig, connections: Connection[]): Record<ArmId, number[]> {
  const out: Record<ArmId, number[]> = {};
  for (const c of connections) {
    if (c.from.arm !== arm.id) continue;
    (out[c.to.arm] ??= Array.from({ length: arm.inLanes }, () => 0))[c.from.lane] = 1;
  }
  return out;
}

export function makeSpawner(arm: ArmConfig, p: SpawnerParams): CodeNode<SpawnerParams> {
  return { id: `spawn-${arm.id}`, params: p, code: genSpawnerCode(armLabel(arm), p), manual: false };
}

export function makeChooser(arm: ArmConfig, p: LaneChooserParams): CodeNode<LaneChooserParams> {
  return { id: `lanes-${arm.id}`, params: p, code: genLaneChooserCode(armLabel(arm), p, arm.inLanes), manual: false };
}

export function makeExit(arm: ArmConfig, p: ExitParams): CodeNode<ExitParams> {
  return { id: `exit-${arm.id}`, params: p, code: genExitCode(armLabel(arm), p), manual: false };
}

export const armLabel = (a: ArmConfig) => `${a.name} [${a.id}]`;

/** Узлы с кодом для всех подходов. Существующие узлы сохраняются, недостающие создаются. */
export function genNodes(cfg: Pick<ModelConfig, 'arms' | 'connections'> & Partial<Pick<ModelConfig, 'spawners' | 'laneChoosers' | 'exits'>>, rate = 300) {
  const spawners: ModelConfig['spawners'] = {};
  const laneChoosers: ModelConfig['laneChoosers'] = {};
  const exits: ModelConfig['exits'] = {};
  for (const a of cfg.arms) {
    const sp = cfg.spawners?.[a.id];
    spawners[a.id] = sp ?? makeSpawner(a, {
      arrival: 'poisson', rate, profile: [], platoonSize: 4,
      destinations: defaultDestinations(cfg.arms, cfg.connections, a.id),
      types: VEHICLE_TYPES.map((t) => ({ ...t })),
    });
    const ch = cfg.laneChoosers?.[a.id];
    laneChoosers[a.id] = ch ?? makeChooser(a, { strategy: 'weights', preLaned: 0.7, weights: laneWeights(a, cfg.connections) });
    const ex = cfg.exits?.[a.id];
    exits[a.id] = ex ?? makeExit(a, { capacityPerLane: 0, blocked: [] });
  }
  return { spawners, laneChoosers, exits };
}

/** Модель «с нуля» по набору подходов */
export function modelFromArms(name: string, arms: ArmConfig[], opts: { rate?: number; pedRate?: number; description?: string } = {}): ModelConfig {
  const connections = genConnections(arms);
  const peds = genPedGraph(arms, opts.pedRate ?? 60);
  const signals = genSignals(arms, connections, peds);
  const base = { arms, connections };
  return {
    format: 'crossroad-model', version: 2, name, description: opts.description ?? '',
    arms, connections, peds, signals,
    transit: TRANSIT_EMPTY(),
    ...genNodes(base, opts.rate ?? 300),
    sim: structuredClone(SIM_DEFAULT),
    basemap: null,
  };
}

/**
 * Привести модель к согласованному виду после правок схемы:
 * узлы для новых подходов, удаление ссылок на исчезнувшие подходы, полосы и переходы.
 */
export function reconcile(cfg: ModelConfig): ModelConfig {
  const ids = new Set(cfg.arms.map((a) => a.id));
  const armOf = new Map(cfg.arms.map((a) => [a.id, a]));
  cfg.connections = cfg.connections.filter((c) => {
    const a = armOf.get(c.from.arm), b = armOf.get(c.to.arm);
    return !!a && !!b && c.from.lane < a.inLanes && c.to.lane < b.outLanes;
  });
  cfg.peds.nodes = cfg.peds.nodes.filter((n) => n.kind === 'point' || n.arms.every((a) => ids.has(a)));
  const nodeIds = new Set(cfg.peds.nodes.map((n) => n.id));
  cfg.peds.edges = cfg.peds.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to) && e.from !== e.to);
  cfg.peds.sources = cfg.peds.sources.filter((s) => nodeIds.has(s.node));
  for (const s of cfg.peds.sources) for (const k of Object.keys(s.destinations)) if (!nodeIds.has(k)) delete s.destinations[k];
  const connIds = new Set(cfg.connections.map((c) => c.id));
  const edgeIds = new Set(cfg.peds.edges.map((e) => e.id));
  for (const g of cfg.signals.groups) {
    g.movements = g.movements.filter((m) => (g.kind === 'pedestrian' ? edgeIds.has(m) : connIds.has(m)));
    if (!ids.has(g.arm)) g.arm = cfg.arms[0]?.id ?? g.arm;
  }
  for (const key of ['spawners', 'laneChoosers', 'exits'] as const) {
    for (const k of Object.keys(cfg[key])) if (!ids.has(k)) delete (cfg[key] as Record<string, unknown>)[k];
  }
  cfg.transit ??= TRANSIT_EMPTY();
  cfg.transit.stops = cfg.transit.stops.filter((st) => ids.has(st.arm));
  const stopIds = new Set(cfg.transit.stops.map((st) => st.id));
  cfg.transit.routes = cfg.transit.routes.filter((r) => ids.has(r.from) && ids.has(r.to));
  for (const r of cfg.transit.routes) r.stops = r.stops.filter((x) => stopIds.has(x));
  for (const g of cfg.signals.groups) if (g.parent && !cfg.signals.groups.some((x) => x.id === g.parent && x.kind === 'vehicle')) delete g.parent;
  const nodes = genNodes(cfg);
  cfg.spawners = nodes.spawners;
  cfg.laneChoosers = nodes.laneChoosers;
  cfg.exits = nodes.exits;
  for (const a of cfg.arms) {
    const sp = cfg.spawners[a.id].params;
    for (const k of Object.keys(sp.destinations)) if (!ids.has(k)) delete sp.destinations[k];
    const ch = cfg.laneChoosers[a.id].params;
    for (const k of Object.keys(ch.weights)) {
      if (!ids.has(k)) delete ch.weights[k];
      else ch.weights[k] = Array.from({ length: a.inLanes }, (_, i) => ch.weights[k][i] ?? 0);
    }
    if (!cfg.spawners[a.id].manual) cfg.spawners[a.id].code = genSpawnerCode(armLabel(a), sp);
    if (!cfg.laneChoosers[a.id].manual) cfg.laneChoosers[a.id].code = genLaneChooserCode(armLabel(a), ch, a.inLanes);
    if (!cfg.exits[a.id].manual) cfg.exits[a.id].code = genExitCode(armLabel(a), cfg.exits[a.id].params);
  }
  return cfg;
}
