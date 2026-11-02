// Геометрия перекрёстка из модели: подходы под любыми углами, полосы, траектории манёвров,
// точки конфликтов, пешеходный граф (углы, островки, переходы) и его пересечения с траекториями машин.

import type { ArmConfig, ArmId, Connection, ConnVariant, ModelConfig, PedNode, TurnKind } from './types';
import {
  add, cubic, dist, makePolyline, mul, pointAt, polylineIntersections, right, sub, v,
  type Polyline, type V2,
} from './geometry';

const DEG = Math.PI / 180;

export function angleDeg(a: number): number {
  return ((a % 360) + 360) % 360;
}

function angDiff(a: number, b: number): number {
  const d = angleDeg(a - b);
  return d > 180 ? d - 360 : d;
}

export function outward(cfg: ArmConfig): V2 {
  return v(Math.cos(cfg.angle * DEG), Math.sin(cfg.angle * DEG));
}

export interface ArmGeom {
  id: ArmId;
  cfg: ArmConfig;
  u: V2;
  /** вправо по ходу движения к перекрёстку */
  rIn: V2;
  /** вправо по ходу движения от перекрёстка */
  rOut: V2;
  axis: V2;
  stopLine: number;
  exitStart: number;
  /** позиция (по длине подхода от точки появления) точки перестроения */
  lcS: number;
  inLanes: Polyline[];
  outLanes: Polyline[];
  inEdge: number;
  outEdge: number;
  /** концы оси пешеходного перехода: a — сторона въезда, b — сторона выезда */
  crosswalk: { a: V2; b: V2; length: number } | null;
}

export interface Crossing {
  /** индекс пешеходного ребра */
  edge: number;
  /** позиция на траектории машины */
  s: number;
  /** позиция на пути ребра */
  u: number;
}

export interface ConnGeom {
  idx: number;
  conn: Connection;
  kind: TurnKind;
  /** манёвр, запрещённый разметкой (используется только нарушителями) */
  illegal: boolean;
  /** направление только для рейсовых автобусов */
  busOnly: boolean;
  path: Polyline;
  conflicts: ConflictRef[];
  crossings: Crossing[];
  siblings: { conn: number; until: number }[];
  /** 0 — основная траектория направления, 1, 2… — дополнительные */
  variant: number;
  /** сдвиг траектории на стоп-линии, м, плюс — влево по ходу */
  shiftIn: number;
  /** траектория ряда на широкой полосе: её выбирают в первую очередь */
  row: boolean;
}

export interface Conflict {
  id: number;
  a: number;
  b: number;
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  p: V2;
  kind: 'cross' | 'merge';
}

export interface ConflictRef {
  conflict: number;
  other: number;
  start: number;
  end: number;
  side: 'a' | 'b';
}

export interface PedNodeGeom {
  idx: number;
  node: PedNode;
  p: V2;
}

export interface PedEdgeGeom {
  idx: number;
  id: string;
  from: number;
  to: number;
  path: Polyline;
  /** участок пути по проезжей части (между бордюрами или до островка) */
  roadS0: number;
  roadS1: number;
  width: number;
  /** подход, через который переход (для обычных переходов) */
  arm: ArmId | null;
  kind: 'cross' | 'half' | 'free';
}

export interface Network {
  arms: Record<ArmId, ArmGeom>;
  /** подходы, отсортированные по углу против часовой */
  order: ArmId[];
  /** манёвры модели, затем запрещённые разметкой (с индекса legalCount) */
  conns: ConnGeom[];
  legalCount: number;
  connById: Map<string, number>;
  /** все траектории направления: основная и дополнительные */
  connsById: Map<string, number[]>;
  conflicts: Conflict[];
  /** для каждой полосы: подход выезда → манёвры (вместе с направлениями только для автобусов) */
  connFor: Record<ArmId, Array<Record<ArmId, number[]>>>;
  /** куда можно доехать из полосы с учётом направлений только для автобусов */
  reachableBus: Record<ArmId, ArmId[][]>;
  /** запрещённый манёвр из полосы на подход */
  illegalFor: Record<ArmId, Array<Record<ArmId, number>>>;
  reachable: Record<ArmId, ArmId[][]>;
  connsFromLane: Record<ArmId, number[][]>;
  connsToLane: Record<ArmId, number[][]>;
  pedNodes: PedNodeGeom[];
  pedNodeById: Map<string, number>;
  pedEdges: PedEdgeGeom[];
  pedEdgeById: Map<string, number>;
  outline: V2[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

export interface ArmRelations {
  opposite: Record<ArmId, ArmId | null>;
  onRight: Record<ArmId, ArmId | null>;
}

/** Противоположный подход и подход справа — по углам */
export function armRelations(arms: ArmConfig[]): ArmRelations {
  const opposite: Record<ArmId, ArmId | null> = {};
  const onRight: Record<ArmId, ArmId | null> = {};
  for (const a of arms) {
    let best: ArmId | null = null, bd = 40;
    for (const b of arms) {
      if (b === a) continue;
      const d = Math.abs(Math.abs(angDiff(b.angle, a.angle)) - 180);
      if (d < bd) { bd = d; best = b.id; }
    }
    opposite[a.id] = best;
    // для въезжающего с подхода a направление движения — angle+180, справа — angle+90
    let r: ArmId | null = null, rd = 55;
    for (const b of arms) {
      if (b === a) continue;
      const d = Math.abs(angDiff(b.angle, a.angle + 90));
      if (d < rd) { rd = d; r = b.id; }
    }
    onRight[a.id] = r;
  }
  return { opposite, onRight };
}

export function turnKindByAngle(from: ArmConfig, to: ArmConfig): TurnKind {
  if (from.id === to.id) return 'uturn';
  // направление въезда = from.angle + 180, выезда = to.angle
  const rel = angDiff(to.angle, from.angle + 180);
  if (Math.abs(rel) < 35) return 'straight';
  return rel > 0 ? 'left' : 'right';
}

function laneOffset(cfg: ArmConfig, i: number): number {
  return cfg.medianWidth / 2 + (i + 0.5) * cfg.laneWidth;
}

export function armPoint(g: ArmGeom, s: number, lateralIn: number): V2 {
  return add(add(g.axis, mul(g.u, s)), mul(g.rIn, lateralIn));
}

export function inLanePoint(g: ArmGeom, lane: number, sFromCenter: number): V2 {
  return armPoint(g, sFromCenter, laneOffset(g.cfg, lane));
}

export function outLanePoint(g: ArmGeom, lane: number, sFromCenter: number): V2 {
  return armPoint(g, sFromCenter, -laneOffset(g.cfg, lane));
}

export const SHOULDER = 0.6;

function buildArm(cfg: ArmConfig): ArmGeom {
  const u = outward(cfg);
  const din = mul(u, -1);
  const rIn = right(din);
  const rOut = right(u);
  const axis = mul(rOut, cfg.axisShift);
  const stopLine = cfg.crosswalkOffset + cfg.crosswalkWidth / 2 + cfg.stopLineGap;
  const exitStart = cfg.crosswalkOffset + cfg.crosswalkWidth / 2 + 0.3;
  const g: ArmGeom = {
    id: cfg.id, cfg, u, rIn, rOut, axis, stopLine, exitStart,
    lcS: Math.max(0, cfg.approachLength - cfg.solidLength),
    inLanes: [], outLanes: [],
    inEdge: cfg.medianWidth / 2 + cfg.inLanes * cfg.laneWidth + SHOULDER,
    outEdge: cfg.medianWidth / 2 + cfg.outLanes * cfg.laneWidth + SHOULDER,
    crosswalk: null,
  };
  for (let i = 0; i < cfg.inLanes; i++) {
    g.inLanes.push(makePolyline([inLanePoint(g, i, stopLine + cfg.approachLength), inLanePoint(g, i, stopLine)]));
  }
  for (let j = 0; j < cfg.outLanes; j++) {
    g.outLanes.push(makePolyline([outLanePoint(g, j, exitStart), outLanePoint(g, j, exitStart + cfg.exitLength)]));
  }
  const a = armPoint(g, cfg.crosswalkOffset, g.inEdge - SHOULDER + 0.3);
  const b = armPoint(g, cfg.crosswalkOffset, -(g.outEdge - SHOULDER + 0.3));
  g.crosswalk = { a, b, length: dist(a, b) };
  return g;
}

function connectionPath(arms: Record<ArmId, ArmGeom>, c: Connection, kind: TurnKind): Polyline {
  const ga = arms[c.from.arm];
  const gb = arms[c.to.arm];
  const A = inLanePoint(ga, c.from.lane, ga.stopLine);
  const B = outLanePoint(gb, c.to.lane, gb.exitStart);
  const dIn = mul(ga.u, -1);
  const dOut = gb.u;
  const d = dist(A, B);
  let k: number;
  if (kind === 'straight') k = d / 3;
  else if (kind === 'uturn') k = Math.max(10, d * 1.4);
  else k = d * 0.48;
  const P1 = add(A, mul(dIn, k));
  const P2 = sub(B, mul(dOut, k));
  const n = kind === 'straight' ? 12 : 36;
  const pts: V2[] = [];
  for (let i = 0; i <= n; i++) pts.push(cubic(A, P1, P2, B, i / n));
  return makePolyline(pts);
}

/** Полоса считается широкой и может работать как два ряда */
export const TWO_ROW_WIDTH = 4.2;
/** Насколько ряд смещён от оси полосы, м */
export const rowShift = (laneWidth: number) => Math.min(1.4, Math.max(0, (laneWidth - 2.1) / 2));

/**
 * Ряды на широкой полосе: на подходе налево встают слева, прямо и направо — справа,
 * на широком выезде поворачивающие идут ближе к своей стороне и сливаются у перехода
 */
function autoRows(arms: Record<ArmId, ArmGeom>, c: Connection, kind: TurnKind): Array<ConnVariant & { row: boolean }> {
  const a = arms[c.from.arm].cfg, b = arms[c.to.arm].cfg;
  const inWide = a.twoRows !== false && a.laneWidth >= TWO_ROW_WIDTH;
  if (kind === 'uturn') return [];
  void b;
  // на широком выезде отдельная траектория не нужна: потоки идут рядом, пока между ними есть место, и сливаются у перехода
  if (!inWide) return [];
  const rIn = rowShift(a.laneWidth);
  return [{ shiftIn: kind === 'left' ? rIn : -rIn, bend: 0, row: true }];
}

/** Траектория, сдвинутая вбок от основной: shiftIn на старте плавно уходит в ноль, bend — изгиб к середине */
function offsetPath(base: Polyline, v: ConnVariant): Polyline {
  const L = base.length || 1;
  const pts = base.pts.map((p, i) => {
    const t = base.cum[i] / L;
    const sm = t * t * (3 - 2 * t);
    const d = v.shiftIn * (1 - sm) + v.bend * Math.sin(Math.PI * t);
    const h = base.hdg[i];
    return { x: p.x - Math.sin(h) * d, y: p.y + Math.cos(h) * d };
  });
  return makePolyline(pts);
}

function closestApproach(a: Polyline, b: Polyline): { d: number; sa: number; sb: number } {
  let best = { d: Infinity, sa: 0, sb: 0 };
  for (let i = 0; i < a.pts.length; i++) {
    for (let j = 0; j < b.pts.length; j++) {
      const dd = dist(a.pts[i], b.pts[j]);
      if (dd < best.d) best = { d: dd, sa: a.cum[i], sb: b.cum[j] };
    }
  }
  return best;
}

/** Ширина, при которой габариты машин на соседних траекториях задевают друг друга, м */
const W_ZONE = 2.5;

/** Участок траектории a вокруг точки s, где она ближе thr к траектории b */
function zoneAround(a: Polyline, s: number, b: Polyline, thr: number): [number, number] {
  const step = 0.5;
  let lo = s, hi = s;
  while (lo - step >= 0 && distToPolyline(pointAt(a, lo - step).p, b) < thr) lo -= step;
  while (hi + step <= a.length && distToPolyline(pointAt(a, hi + step).p, b) < thr) hi += step;
  return [lo, hi];
}

function mergeStart(a: Polyline, b: Polyline, thr: number): number {
  for (let i = a.pts.length - 1; i >= 0; i--) {
    if (distToPolyline(a.pts[i], b) > thr) return a.cum[Math.min(a.pts.length - 1, i + 1)];
  }
  return 0;
}

export function distToPolyline(p: V2, pl: Polyline): number {
  let best = Infinity;
  for (let i = 0; i < pl.pts.length - 1; i++) {
    const a = pl.pts[i], b = pl.pts[i + 1];
    const ab = sub(b, a);
    const l2 = ab.x * ab.x + ab.y * ab.y || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2));
    best = Math.min(best, dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t }));
  }
  return best;
}

function angleAt(pl: Polyline, s: number): number {
  let i = 0;
  while (i < pl.cum.length - 2 && pl.cum[i + 1] < s) i++;
  return pl.hdg[i];
}

function lineIntersect(p: V2, d: V2, q: V2, e: V2): V2 | null {
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / den;
  return add(p, mul(d, t));
}

/** Скругление бордюра между подходом g и следующим против часовой стрелки подходом h (квадратичная кривая) */
export function cornerCurve(g: ArmGeom, h: ArmGeom): { p0: V2; ctrl: V2; p3: V2 } {
  const cornerA = g.cfg.crosswalkOffset - g.cfg.crosswalkWidth / 2 - 0.5;
  const cornerB = h.cfg.crosswalkOffset - h.cfg.crosswalkWidth / 2 - 0.5;
  const p0 = armPoint(g, cornerA, g.inEdge);
  const p3 = armPoint(h, cornerB, -h.outEdge);
  let ctrl = lineIntersect(p0, g.u, p3, h.u);
  if (!ctrl || dist(ctrl, p0) > 80) ctrl = mul(add(p0, p3), 0.5);
  return { p0, ctrl, p3 };
}

/** Контур проезжей части: подходы и скруглённые углы между соседними по углу подходами */
export function buildOutline(arms: Record<ArmId, ArmGeom>, order: ArmId[]): V2[] {
  const pts: V2[] = [];
  for (let k = 0; k < order.length; k++) {
    const g = arms[order[k]];
    const h = arms[order[(k + 1) % order.length]];
    const far = Math.max(g.stopLine + g.cfg.approachLength, g.exitStart + g.cfg.exitLength) + 4;
    pts.push(armPoint(g, far, -g.outEdge));
    pts.push(armPoint(g, far, g.inEdge));
    if (order.length === 1) break;
    const { p0, ctrl, p3 } = cornerCurve(g, h);
    pts.push(p0);
    for (let i = 1; i < 12; i++) {
      const t = i / 12;
      pts.push(add(mul(p0, (1 - t) * (1 - t)), add(mul(ctrl, 2 * (1 - t) * t), mul(p3, t * t))));
    }
    pts.push(p3);
  }
  return pts;
}

/** Отступ угла пешеходного графа от бордюра вглубь тротуара, м */
export const CORNER_SETBACK = 3;

/** Положение узла пешеходного графа */
export function pedNodePos(node: PedNode, arms: Record<ArmId, ArmGeom>, order: ArmId[]): V2 {
  let p: V2 = v(node.x ?? 0, node.y ?? 0);
  if (node.kind === 'corner' && node.arms.length === 2 && arms[node.arms[0]] && arms[node.arms[1]]) {
    // угол тротуара у скругления бордюра
    const { p0, ctrl, p3 } = cornerCurve(arms[node.arms[0]], arms[node.arms[1]]);
    const mid = add(add(mul(p0, 0.25), mul(ctrl, 0.5)), mul(p3, 0.25));
    let out = sub(mid, ctrl);
    let L = Math.hypot(out.x, out.y);
    if (L < 0.3) { out = mid; L = Math.hypot(mid.x, mid.y) || 1; }
    p = add(mid, mul(out, CORNER_SETBACK / L));
  } else if (node.kind === 'island' && node.arms[0] && arms[node.arms[0]]) {
    const g = arms[node.arms[0]];
    p = armPoint(g, g.cfg.crosswalkOffset, 0);
  }
  void order;
  return add(p, v(node.dx || 0, node.dy || 0));
}

function polylineHits(line: Polyline, outline: V2[]): number[] {
  const ring = makePolyline([...outline, outline[0]]);
  return polylineIntersections(line, ring).map((x) => x.sa).sort((a, b) => a - b);
}

export function buildNetwork(cfg: ModelConfig): Network {
  const arms: Record<ArmId, ArmGeom> = {};
  for (const a of cfg.arms) arms[a.id] = buildArm(a);
  const order = [...cfg.arms].sort((a, b) => angleDeg(a.angle) - angleDeg(b.angle)).map((a) => a.id);
  const outline = buildOutline(arms, order);

  const conns: ConnGeom[] = [];
  const connById = new Map<string, number>();
  for (const c of cfg.connections) {
    const ga = arms[c.from.arm], gb = arms[c.to.arm];
    if (!ga || !gb) continue;
    if (c.from.lane >= ga.cfg.inLanes || c.to.lane >= gb.cfg.outLanes) continue;
    const kind = turnKindByAngle(ga.cfg, gb.cfg);
    const idx = conns.length;
    conns.push({ idx, conn: c, kind, illegal: false, busOnly: !!c.busOnly, path: connectionPath(arms, c, kind), conflicts: [], crossings: [], siblings: [], variant: 0, shiftIn: 0, row: false });
    connById.set(c.id, idx);
  }
  // дополнительные траектории: заданные в модели или ряды на широкой полосе
  const baseCount = conns.length;
  for (let i = 0; i < baseCount; i++) {
    const b = conns[i];
    const manual = b.conn.variants ?? [];
    const list: Array<ConnVariant & { row: boolean }> = manual.length ? manual.map((v) => ({ ...v, row: false })) : autoRows(arms, b.conn, b.kind);
    list.forEach((v, k) => {
      if (Math.abs(v.shiftIn) < 0.05 && Math.abs(v.bend) < 0.05) return;
      const idx = conns.length;
      conns.push({ ...b, idx, path: offsetPath(b.path, v), conflicts: [], crossings: [], siblings: [], variant: k + 1, shiftIn: v.shiftIn, row: v.row });
    });
  }
  const connsById = new Map<string, number[]>();
  for (const c of conns) { const l = connsById.get(c.conn.id) ?? []; l.push(c.idx); connsById.set(c.conn.id, l); }
  const legalCount = conns.length;
  // запрещённые разметкой манёвры: из полосы туда, куда из неё ехать нельзя (для нарушителей)
  for (const a of cfg.arms) {
    for (let lane = 0; lane < a.inLanes; lane++) {
      const allowed = new Set(conns.filter((c) => c.conn.from.arm === a.id && c.conn.from.lane === lane).map((c) => c.conn.to.arm));
      for (const c of conns) if (c.busOnly && c.conn.from.arm === a.id && c.conn.from.lane === lane) allowed.delete(c.conn.to.arm);
      if (!allowed.size) continue;
      for (const b of cfg.arms) {
        if (b.id === a.id || allowed.has(b.id) || b.outLanes <= 0) continue;
        if (!cfg.connections.some((c) => c.from.arm === a.id && c.to.arm === b.id)) continue;
        const kind = turnKindByAngle(a, b);
        const toLane = kind === 'left' ? 0 : kind === 'right' ? b.outLanes - 1 : Math.min(lane, b.outLanes - 1);
        const c: Connection = { id: `X:${a.id}${lane}-${b.id}${toLane}`, from: { arm: a.id, lane }, to: { arm: b.id, lane: toLane } };
        const idx = conns.length;
        conns.push({ idx, conn: c, kind, illegal: true, busOnly: false, path: connectionPath(arms, c, kind), conflicts: [], crossings: [], siblings: [], variant: 0, shiftIn: 0, row: false });
        connById.set(c.id, idx);
      }
    }
  }

  const conflicts: Conflict[] = [];
  const W = 2.2;
  for (let i = 0; i < conns.length; i++) {
    for (let j = i + 1; j < conns.length; j++) {
      const A = conns[i], B = conns[j];
      if (A.illegal && B.illegal) continue;
      const sameFrom = A.conn.from.arm === B.conn.from.arm && A.conn.from.lane === B.conn.from.lane;
      const sameTo = A.conn.to.arm === B.conn.to.arm && A.conn.to.lane === B.conn.to.lane;
      // траектории из одной полосы: основные одна за другой, а разные ряды и обходы — только если действительно пересекаются
      const alt = A.variant > 0 || B.variant > 0;
      if (sameFrom && !alt) continue;
      if (sameFrom && A.conn.id === B.conn.id) continue;
      if (sameFrom) {
        // из одного ряда едут друг за другом, конфликт возможен только между разными рядами
        if (Math.abs(A.shiftIn - B.shiftIn) < 1) continue;
        for (const x of polylineIntersections(A.path, B.path)) {
          if (x.sa < 2 && x.sb < 2) continue;
          const [a0, a1] = zoneAround(A.path, x.sa, B.path, W_ZONE);
          const [b0, b1] = zoneAround(B.path, x.sb, A.path, W_ZONE);
          conflicts.push({ id: conflicts.length, a: i, b: j, aStart: Math.max(0, a0 - 0.6), aEnd: Math.min(A.path.length, a1 + 0.6), bStart: Math.max(0, b0 - 0.6), bEnd: Math.min(B.path.length, b1 + 0.6), p: x.p, kind: 'cross' });
        }
        continue;
      }
      if (sameTo && A.conn.id === B.conn.id) continue;
      if (sameTo) {
        // на широком выезде два потока идут рядом и сливаются, только когда между ними не остаётся места
        const toCfg = arms[A.conn.to.arm].cfg;
        const thr = toCfg.twoRows !== false && toCfg.laneWidth >= TWO_ROW_WIDTH ? 2.1 : W * 1.25;
        const aStart = mergeStart(A.path, B.path, thr);
        const bStart = mergeStart(B.path, A.path, thr);
        conflicts.push({ id: conflicts.length, a: i, b: j, aStart: Math.max(0, aStart - 1), aEnd: A.path.length, bStart: Math.max(0, bStart - 1), bEnd: B.path.length, p: A.path.pts[A.path.pts.length - 1], kind: 'merge' });
        continue;
      }
      const xs = polylineIntersections(A.path, B.path);
      if (xs.length > 0) {
        for (const x of xs) {
          const ha = Math.abs(Math.sin(angleAt(A.path, x.sa) - angleAt(B.path, x.sb)));
          const half = Math.min(7, W / Math.max(0.3, ha) / 2 + 1.2);
          // зона — где траектории ближе ширины машины; при остром угле она длиннее
          const [a0, a1] = zoneAround(A.path, x.sa, B.path, W_ZONE);
          const [b0, b1] = zoneAround(B.path, x.sb, A.path, W_ZONE);
          conflicts.push({
            id: conflicts.length, a: i, b: j,
            aStart: Math.max(0, Math.min(x.sa - half, a0 - 0.6)), aEnd: Math.min(A.path.length, Math.max(x.sa + half, a1 + 0.6)),
            bStart: Math.max(0, Math.min(x.sb - half, b0 - 0.6)), bEnd: Math.min(B.path.length, Math.max(x.sb + half, b1 + 0.6)),
            p: x.p, kind: 'cross',
          });
        }
      } else {
        const ca = closestApproach(A.path, B.path);
        if (ca.d < W_ZONE) {
          const [a0, a1] = zoneAround(A.path, ca.sa, B.path, W_ZONE);
          const [b0, b1] = zoneAround(B.path, ca.sb, A.path, W_ZONE);
          conflicts.push({ id: conflicts.length, a: i, b: j, aStart: Math.max(0, Math.min(ca.sa - 3, a0 - 0.6)), aEnd: Math.min(A.path.length, Math.max(ca.sa + 3, a1 + 0.6)), bStart: Math.max(0, Math.min(ca.sb - 3, b0 - 0.6)), bEnd: Math.min(B.path.length, Math.max(ca.sb + 3, b1 + 0.6)), p: pointAt(A.path, ca.sa).p, kind: 'cross' });
        }
      }
    }
  }
  for (const A of conns) {
    for (const B of conns) {
      if (A === B || A.conn.from.arm !== B.conn.from.arm || A.conn.from.lane !== B.conn.from.lane) continue;
      let until = A.path.length;
      for (let i = 0; i < A.path.pts.length; i++) {
        if (distToPolyline(A.path.pts[i], B.path) > W * 0.9) { until = A.path.cum[i]; break; }
      }
      A.siblings.push({ conn: B.idx, until: until + 2 });
    }
  }
  for (const c of conflicts) {
    conns[c.a].conflicts.push({ conflict: c.id, other: c.b, start: c.aStart, end: c.aEnd, side: 'a' });
    conns[c.b].conflicts.push({ conflict: c.id, other: c.a, start: c.bStart, end: c.bEnd, side: 'b' });
  }
  for (const c of conns) c.conflicts.sort((x, y) => x.start - y.start);

  // --- пешеходный граф ---
  const pedNodes: PedNodeGeom[] = [];
  const pedNodeById = new Map<string, number>();
  for (const n of cfg.peds.nodes) {
    if (n.kind !== 'point' && n.arms.some((a) => !arms[a])) continue;
    pedNodeById.set(n.id, pedNodes.length);
    pedNodes.push({ idx: pedNodes.length, node: n, p: pedNodePos(n, arms, order) });
  }
  const pedEdges: PedEdgeGeom[] = [];
  const pedEdgeById = new Map<string, number>();
  for (const e of cfg.peds.edges) {
    const fi = pedNodeById.get(e.from), ti = pedNodeById.get(e.to);
    if (fi === undefined || ti === undefined || fi === ti) continue;
    const A = pedNodes[fi], B = pedNodes[ti];
    const shared = A.node.arms.filter((x) => B.node.arms.includes(x));
    let geom: Omit<PedEdgeGeom, 'idx' | 'id' | 'from' | 'to' | 'width'> | null = null;
    const viaArm = shared.find((x) => arms[x]?.cfg.hasCrosswalk && arms[x].crosswalk);
    if (viaArm && (A.node.kind === 'corner' || A.node.kind === 'island') && (B.node.kind === 'corner' || B.node.kind === 'island')) {
      const g = arms[viaArm];
      const cw = g.crosswalk!;
      const island = A.node.kind === 'island' ? A : B.node.kind === 'island' ? B : null;
      // подход к бордюру — по оси перехода: последние 2 м тротуара перпендикулярно дороге
      const approach = (end: V2, other: V2) => {
        const dx = end.x - other.x, dy = end.y - other.y;
        const L = Math.hypot(dx, dy) || 1;
        return add(end, mul(v(dx / L, dy / L), 2.3));
      };
      if (!island) {
        const aEnd = dist(A.p, cw.a) < dist(A.p, cw.b) ? cw.a : cw.b;
        const bEnd = aEnd === cw.a ? cw.b : cw.a;
        const path = makePolyline([A.p, approach(aEnd, bEnd), aEnd, bEnd, approach(bEnd, aEnd), B.p]);
        geom = { path, roadS0: path.cum[2], roadS1: path.cum[3], arm: viaArm, kind: 'cross' };
      } else {
        const corner = island === A ? B : A;
        const end = dist(corner.p, cw.a) < dist(corner.p, cw.b) ? cw.a : cw.b;
        const sideSign = end === cw.a ? 1 : -1;
        const medianEdge = armPoint(g, g.cfg.crosswalkOffset, sideSign * g.cfg.medianWidth / 2);
        const near = approach(end, medianEdge);
        const pts = island === A ? [island.p, medianEdge, end, near, corner.p] : [corner.p, near, end, medianEdge, island.p];
        const path = makePolyline(pts);
        geom = island === A
          ? { path, roadS0: path.cum[1], roadS1: path.cum[2], arm: viaArm, kind: 'half' }
          : { path, roadS0: path.cum[2], roadS1: path.cum[3], arm: viaArm, kind: 'half' };
      }
    }
    if (!geom) {
      const path = makePolyline([A.p, B.p]);
      const hits = polylineHits(path, outline);
      const s0 = hits.length ? hits[0] : 0;
      const s1 = hits.length ? hits[hits.length - 1] : path.length;
      geom = { path, roadS0: s0, roadS1: Math.max(s0, s1), arm: null, kind: 'free' };
    }
    pedEdgeById.set(e.id, pedEdges.length);
    pedEdges.push({ idx: pedEdges.length, id: e.id, from: fi, to: ti, width: e.width || 4, ...geom });
  }

  // пересечения траекторий машин с пешеходными переходами (по участку проезжей части)
  for (const c of conns) {
    for (const pe of pedEdges) {
      const a = pointOn(pe.path, pe.roadS0), b = pointOn(pe.path, pe.roadS1);
      if (dist(a, b) < 0.5) continue;
      const seg = makePolyline([a, b]);
      for (const x of polylineIntersections(c.path, seg)) c.crossings.push({ edge: pe.idx, s: x.sa, u: pe.roadS0 + x.sb });
    }
    c.crossings.sort((a, b) => a.s - b.s);
  }

  const connFor: Network['connFor'] = {};
  const reachable: Network['reachable'] = {};
  const connsFromLane: Network['connsFromLane'] = {};
  const connsToLane: Network['connsToLane'] = {};
  for (const a of cfg.arms) {
    connFor[a.id] = Array.from({ length: a.inLanes }, () => ({}));
    reachable[a.id] = Array.from({ length: a.inLanes }, () => []);
    connsFromLane[a.id] = Array.from({ length: a.inLanes }, () => []);
    connsToLane[a.id] = Array.from({ length: a.outLanes }, () => []);
  }
  const illegalFor: Network['illegalFor'] = {};
  const reachableBus: Network['reachableBus'] = {};
  for (const a of cfg.arms) {
    illegalFor[a.id] = Array.from({ length: a.inLanes }, () => ({}));
    reachableBus[a.id] = Array.from({ length: a.inLanes }, () => []);
  }
  for (const c of conns) {
    const { from, to } = c.conn;
    if (c.illegal) {
      // запрещённый для всех манёвр, если туда можно только автобусам — тоже запрещённый
      if (illegalFor[from.arm][from.lane][to.arm] === undefined) illegalFor[from.arm][from.lane][to.arm] = c.idx;
      continue;
    }
    const m = connFor[from.arm][from.lane];
    (m[to.arm] ??= []).push(c.idx);
    if (!reachableBus[from.arm][from.lane].includes(to.arm)) reachableBus[from.arm][from.lane].push(to.arm);
    if (c.busOnly) { connsFromLane[from.arm][from.lane].push(c.idx); connsToLane[to.arm][to.lane].push(c.idx); continue; }
    if (!reachable[from.arm][from.lane].includes(to.arm)) reachable[from.arm][from.lane].push(to.arm);
    connsFromLane[from.arm][from.lane].push(c.idx);
    connsToLane[to.arm][to.lane].push(c.idx);
  }

  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const p of outline) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { arms, order, conns, legalCount, connById, connsById, conflicts, connFor, illegalFor, reachable, reachableBus, connsFromLane, connsToLane, pedNodes, pedNodeById, pedEdges, pedEdgeById, outline, bounds: { minX, maxX, minY, maxY } };
}

function pointOn(pl: Polyline, s: number): V2 {
  let i = 0;
  while (i < pl.cum.length - 2 && pl.cum[i + 1] < s) i++;
  const a = pl.pts[i], b = pl.pts[i + 1] ?? a;
  const L = pl.cum[i + 1] - pl.cum[i] || 1;
  const t = Math.max(0, Math.min(1, (s - pl.cum[i]) / L));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export interface PedRoute {
  steps: Array<{ edge: number; dir: 1 | -1 }>;
  length: number;
}

function shortest(net: Network, from: number, to: number, banned: Set<number>): PedRoute | null {
  const n = net.pedNodes.length;
  const d = new Array(n).fill(Infinity);
  const prev: Array<{ node: number; edge: number; dir: 1 | -1 } | null> = new Array(n).fill(null);
  const done = new Array(n).fill(false);
  d[from] = 0;
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || d[i] < d[u])) u = i;
    if (u < 0 || d[u] === Infinity) break;
    if (u === to) break;
    done[u] = true;
    for (const e of net.pedEdges) {
      if (banned.has(e.idx)) continue;
      let w = -1, dir: 1 | -1 = 1;
      if (e.from === u) { w = e.to; dir = 1; } else if (e.to === u) { w = e.from; dir = -1; } else continue;
      const nd = d[u] + e.path.length;
      if (nd < d[w]) { d[w] = nd; prev[w] = { node: u, edge: e.idx, dir }; }
    }
  }
  if (d[to] === Infinity) return null;
  const steps: Array<{ edge: number; dir: 1 | -1 }> = [];
  let c = to;
  while (c !== from && prev[c]) { steps.unshift({ edge: prev[c]!.edge, dir: prev[c]!.dir }); c = prev[c]!.node; }
  return { steps, length: d[to] };
}

/**
 * Маршруты пешеходов между узлами графа: кратчайший и альтернативы не длиннее кратчайшего в 1,5 раза
 * (например, обойти перекрёсток по часовой или против часовой стрелки). Ключ — «from>to».
 */
export function pedRouteOptions(net: Network): Map<string, PedRoute[]> {
  const out = new Map<string, PedRoute[]>();
  const n = net.pedNodes.length;
  for (let s = 0; s < n; s++) {
    for (let t = 0; t < n; t++) {
      if (s === t) continue;
      const best = shortest(net, s, t, new Set());
      if (!best) continue;
      const opts: PedRoute[] = [best];
      const seen = new Set([best.steps.map((x) => x.edge).join(',')]);
      for (const st of best.steps) {
        const alt = shortest(net, s, t, new Set([st.edge]));
        if (!alt || alt.length > best.length * 1.5 + 1) continue;
        const key = alt.steps.map((x) => x.edge).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        opts.push(alt);
      }
      out.set(`${net.pedNodes[s].node.id}>${net.pedNodes[t].node.id}`, opts.sort((a, b) => a.length - b.length).slice(0, 3));
    }
  }
  return out;
}

/** Положение остановки: точка на крайней правой полосе, направление движения и сторона бордюра */
export function busStopPose(net: Network, stop: { arm: ArmId; side: 'approach' | 'exit'; dist: number }): { p: V2; h: number; curb: V2; lane: number } | null {
  const g = net.arms[stop.arm];
  if (!g) return null;
  if (stop.side === 'approach') {
    const lane = g.cfg.inLanes - 1;
    if (lane < 0) return null;
    const pl = g.inLanes[lane];
    const s = Math.max(0, Math.min(pl.length, g.cfg.approachLength - stop.dist));
    const q = pointAtPl(pl, s);
    return { p: q.p, h: q.h, curb: g.rIn, lane };
  }
  const lane = g.cfg.outLanes - 1;
  if (lane < 0) return null;
  const pl = g.outLanes[lane];
  const s = Math.max(0, Math.min(pl.length, stop.dist));
  const q = pointAtPl(pl, s);
  return { p: q.p, h: q.h, curb: mul(g.rIn, -1), lane };
}

function pointAtPl(pl: Polyline, s: number): { p: V2; h: number } {
  let i = 0;
  while (i < pl.cum.length - 2 && pl.cum[i + 1] < s) i++;
  const a = pl.pts[i], b = pl.pts[i + 1] ?? a;
  const L = pl.cum[i + 1] - pl.cum[i] || 1;
  const t = Math.max(0, Math.min(1, (s - pl.cum[i]) / L));
  return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, h: Math.atan2(b.y - a.y, b.x - a.x) };
}
