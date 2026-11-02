// Статическая векторная отрисовка перекрёстка по модели: проезжая часть, разделители и островки,
// разметка, стрелки на полосах, пешеходные переходы по рёбрам пешеходного графа, узлы и светофоры.

import type { ArmId, ModelConfig, TurnKind } from '../engine/types';
import { armPoint, inLanePoint, outLanePoint, type ArmGeom, type Network, type PedEdgeGeom } from '../engine/network';
import { add, mul, norm, sub, type V2 } from '../engine/geometry';

export const P = (p: V2) => `${p.x.toFixed(2)},${(-p.y).toFixed(2)}`;

export function polyPath(pts: V2[], close = true): string {
  if (!pts.length) return '';
  return 'M' + pts.map(P).join('L') + (close ? 'Z' : '');
}

export interface LineSeg {
  d: string;
  dashed: boolean;
  width: number;
}

export interface ArrowGlyph {
  d: string;
  heads: string;
}

export interface Zebra {
  edge: string;
  stripes: string;
  diagonal: boolean;
}

export interface StaticMap {
  road: string;
  medians: string[];
  lines: LineSeg[];
  stopLines: string[];
  zebras: Zebra[];
  arrows: ArrowGlyph[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

function rect(g: ArmGeom, s0: number, s1: number, lat0: number, lat1: number): string {
  return polyPath([armPoint(g, s0, lat0), armPoint(g, s1, lat0), armPoint(g, s1, lat1), armPoint(g, s0, lat1)]);
}

function line(g: ArmGeom, s0: number, s1: number, lat: number): string {
  return 'M' + P(armPoint(g, s0, lat)) + 'L' + P(armPoint(g, s1, lat));
}

/** Стрелка разметки 1.18 для набора манёвров. base — точка у основания, d — направление движения */
export function arrowGlyph(base: V2, d: V2, kinds: TurnKind[]): ArrowGlyph {
  const left = { x: -d.y, y: d.x };
  const W = (f: number, l: number) => add(add(base, mul(d, f)), mul(left, l));
  const L = 5.2;
  let path = `M${P(W(0, 0))}L${P(W(L * 0.55, 0))}`;
  const heads: string[] = [];
  const head = (tip: V2, dir: V2) => {
    const n = { x: -dir.y, y: dir.x };
    const b = add(tip, mul(dir, -1.1));
    heads.push(polyPath([tip, add(b, mul(n, 0.55)), add(b, mul(n, -0.55))]));
  };
  const has = (k: TurnKind) => kinds.includes(k);
  if (has('straight') || kinds.length === 0) {
    path += `M${P(W(L * 0.55, 0))}L${P(W(L - 1.0, 0))}`;
    head(W(L, 0), d);
  }
  if (has('left')) {
    path += `M${P(W(L * 0.4, 0))}Q${P(W(L * 0.72, 0))} ${P(W(L * 0.72, 1.0))}`;
    head(W(L * 0.72, 1.9), left);
  }
  if (has('right')) {
    path += `M${P(W(L * 0.4, 0))}Q${P(W(L * 0.72, 0))} ${P(W(L * 0.72, -1.0))}`;
    head(W(L * 0.72, -1.9), mul(left, -1));
  }
  if (has('uturn')) {
    path += `M${P(W(L * 0.45, 0))}Q${P(W(L * 0.95, 0))} ${P(W(L * 0.95, 0.8))}Q${P(W(L * 0.95, 1.6))} ${P(W(L * 0.6, 1.6))}`;
    head(W(L * 0.25, 1.6), mul(d, -1));
  }
  return { d: path, heads: heads.join('') };
}

export function pointOnPath(e: PedEdgeGeom, s: number): { p: V2; dir: V2 } {
  const pl = e.path;
  let i = 0;
  while (i < pl.cum.length - 2 && pl.cum[i + 1] < s) i++;
  const a = pl.pts[i], b = pl.pts[i + 1] ?? a;
  const L = pl.cum[i + 1] - pl.cum[i] || 1;
  const t = Math.max(0, Math.min(1, (s - pl.cum[i]) / L));
  const dir = norm(sub(b, a));
  return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dir };
}

/** «Зебра» (разметка 1.14.1): полосы поперёк направления движения пешеходов на участке проезжей части */
function zebraFor(e: PedEdgeGeom): string {
  const L = e.roadS1 - e.roadS0;
  if (L < 0.5) return '';
  const hw = e.width / 2;
  let d = '';
  for (let k = 0.25; k < L - 0.2; k += 1.0) {
    const s0 = e.roadS0 + k, s1 = e.roadS0 + Math.min(L, k + 0.5);
    const a = pointOnPath(e, s0), b = pointOnPath(e, s1);
    const n = { x: -a.dir.y, y: a.dir.x };
    d += polyPath([add(a.p, mul(n, -hw)), add(b.p, mul(n, -hw)), add(b.p, mul(n, hw)), add(a.p, mul(n, hw))]);
  }
  return d;
}

export function buildStatic(net: Network): StaticMap {
  const road = polyPath(net.outline);
  const medians: string[] = [];
  const lines: LineSeg[] = [];
  const stopLines: string[] = [];
  const zebras: Zebra[] = [];
  const arrows: ArrowGlyph[] = [];

  for (const id of net.order) {
    const g = net.arms[id];
    const c = g.cfg;
    const far = g.stopLine + c.approachLength + 4;
    const farOut = g.exitStart + c.exitLength + 4;
    const solidEnd = g.stopLine + c.solidLength;
    const mh = c.medianWidth / 2;
    const cwNear = c.crosswalkOffset - c.crosswalkWidth / 2;
    const cwFar = c.crosswalkOffset + c.crosswalkWidth / 2;
    if (c.medianWidth > 0.2) {
      // островок безопасности выходит за переход в сторону перекрёстка, обычный разделитель прерывается перед переходом
      const from = c.refuge && c.hasCrosswalk ? cwNear - 1.5 : c.hasCrosswalk ? cwFar + 0.6 : g.stopLine - 2;
      medians.push(rect(g, from, Math.max(far, farOut), mh, -mh));
      if (c.refuge && c.hasCrosswalk) medians.push(rect(g, cwNear, cwFar, mh, -mh));
    } else {
      lines.push({ d: line(g, g.stopLine, solidEnd, 0.12), dashed: false, width: 0.15 });
      lines.push({ d: line(g, g.stopLine, solidEnd, -0.12), dashed: false, width: 0.15 });
      lines.push({ d: line(g, solidEnd, Math.max(far, farOut), 0), dashed: true, width: 0.15 });
      if (g.exitStart < g.stopLine) lines.push({ d: line(g, g.exitStart, g.stopLine, -0.12), dashed: false, width: 0.15 });
    }
    for (let i = 1; i < c.inLanes; i++) {
      const lat = mh + i * c.laneWidth;
      lines.push({ d: line(g, g.stopLine, solidEnd, lat), dashed: false, width: 0.15 });
      lines.push({ d: line(g, solidEnd, far, lat), dashed: true, width: 0.15 });
    }
    for (let j = 1; j < c.outLanes; j++) {
      const lat = -(mh + j * c.laneWidth);
      lines.push({ d: line(g, g.exitStart, farOut, lat), dashed: true, width: 0.15 });
    }
    if (c.inLanes > 0) stopLines.push(rect(g, g.stopLine, g.stopLine + 0.4, mh + 0.1, mh + c.inLanes * c.laneWidth));
    for (let i = 0; i < c.inLanes; i++) {
      const kinds = Array.from(new Set((net.connsFromLane[id][i] ?? []).filter((ci) => !net.conns[ci].busOnly).map((ci) => net.conns[ci].kind)));
      const dir = mul(g.u, -1);
      for (const s of [g.stopLine + 9, g.stopLine + Math.min(c.solidLength, c.approachLength) * 0.85 + 4]) {
        if (s > g.stopLine + c.approachLength - 6) continue;
        arrows.push(arrowGlyph(inLanePoint(g, i, s), dir, kinds));
      }
    }
  }
  for (const e of net.pedEdges) {
    const stripes = zebraFor(e);
    if (stripes) zebras.push({ edge: e.id, stripes, diagonal: e.kind === 'free' });
  }
  return { road, medians, lines, stopLines, zebras, arrows, bounds: net.bounds };
}

// ---------- Узлы графа ----------

export interface MapNode {
  key: string;
  kind: 'in' | 'out' | 'spawn' | 'lanes' | 'exit';
  arm: ArmId;
  lane: number;
  p: V2;
}

export function buildNodes(net: Network): MapNode[] {
  const nodes: MapNode[] = [];
  for (const d of net.order) {
    const g = net.arms[d];
    const c = g.cfg;
    for (let i = 0; i < c.inLanes; i++) nodes.push({ key: `in-${d}-${i}`, kind: 'in', arm: d, lane: i, p: inLanePoint(g, i, g.stopLine) });
    for (let j = 0; j < c.outLanes; j++) nodes.push({ key: `out-${d}-${j}`, kind: 'out', arm: d, lane: j, p: outLanePoint(g, j, g.exitStart) });
    const midIn = c.medianWidth / 2 + (c.inLanes * c.laneWidth) / 2;
    const midOut = -(c.medianWidth / 2 + (c.outLanes * c.laneWidth) / 2);
    if (c.inLanes > 0) {
      nodes.push({ key: `spawn-${d}`, kind: 'spawn', arm: d, lane: -1, p: armPoint(g, g.stopLine + c.approachLength, midIn) });
      nodes.push({ key: `lanes-${d}`, kind: 'lanes', arm: d, lane: -1, p: armPoint(g, g.stopLine + c.solidLength, midIn) });
    }
    if (c.outLanes > 0) nodes.push({ key: `exit-${d}`, kind: 'exit', arm: d, lane: -1, p: armPoint(g, g.exitStart + c.exitLength, midOut) });
  }
  return nodes;
}

// ---------- Светофоры ----------

export type ArrowDir = 'left' | 'right' | 'straight' | 'uturn';

export interface HeadPos {
  key: string;
  group: string;
  kind: 'vehicle' | 'arrow' | 'pedestrian';
  /** центр корпуса в координатах модели */
  p: V2;
  arrow?: ArrowDir;
  color: string;
  name: string;
}

/** Направление стрелки допсекции по её манёврам */
function arrowDirOf(net: Network, movements: string[]): ArrowDir {
  const kinds = movements.map((m) => net.connById.get(m)).filter((x): x is number => x !== undefined).map((ci) => net.conns[ci].kind);
  if (kinds.length && kinds.every((k) => k === 'right')) return 'right';
  if (kinds.length && kinds.every((k) => k === 'uturn')) return 'uturn';
  if (kinds.length && kinds.every((k) => k === 'left' || k === 'uturn')) return 'left';
  return kinds.includes('right') ? 'right' : kinds.includes('left') ? 'left' : 'straight';
}

/** Размеры корпусов (м): основной светофор 2 × 5,8, секция 2 × 2, пешеходный 1,6 × 3 */
export const HEAD = { w: 2, h: 5.8, aw: 2, gap: 0.15, pw: 1.6, ph: 3.0 };

/**
 * Раскладка светофоров. Основные светофоры подхода стоят в ряд справа от подхода за стоп-линией,
 * допсекции примыкают к своему основному светофору на уровне зелёного сигнала: секция «слева» — слева, «справа» — справа
 * (как видит водитель, подъезжая к светофору). Пешеходные светофоры — у концов переходов со стороны перекрёстка.
 */
export function headLayout(net: Network, cfg: ModelConfig): HeadPos[] {
  const out: HeadPos[] = [];
  const groups = cfg.signals.groups;
  for (const id of net.order) {
    const g = net.arms[id];
    const mains = groups.filter((x) => x.kind === 'vehicle' && x.arm === id);
    const arrows = groups.filter((x) => x.kind === 'arrow' && (x.parent ? mains.some((m) => m.id === x.parent) : x.arm === id));
    if (!mains.length && !arrows.length) continue;
    // ряд идёт по горизонтали экрана, в сторону от проезжей части
    const base = armPoint(g, g.stopLine + 2.2, g.inEdge + 4.2);
    let dirX = Math.abs(g.rIn.x) > 0.5 ? Math.sign(g.rIn.x) : Math.sign(g.u.x);
    if (!dirX) dirX = 1;
    type Unit = { main: typeof mains[number] | null; left: typeof arrows; right: typeof arrows };
    const units: Unit[] = mains.map((m) => ({ main: m, left: [], right: [] }));
    const loose: Unit = { main: null, left: [], right: [] };
    for (const a of arrows) {
      const dir = arrowDirOf(net, a.movements);
      const side = a.side ?? (dir === 'left' || dir === 'uturn' ? 'left' : 'right');
      let u = a.parent ? units.find((x) => x.main?.id === a.parent) : undefined;
      if (!u) {
        const lanes = new Set(a.movements.map((m) => net.connById.get(m)).filter((x): x is number => x !== undefined).map((ci) => net.conns[ci].conn.from.lane));
        u = units.find((x) => x.main && x.main.movements.some((m) => { const ci = net.connById.get(m); return ci !== undefined && lanes.has(net.conns[ci].conn.from.lane); })) ?? units[0];
      }
      (u ?? loose)[side === 'left' ? 'left' : 'right'].push(a);
    }
    if (loose.left.length || loose.right.length) units.push(loose);
    let cursor = 0;
    for (const u of units) {
      const widthL = u.left.length * (HEAD.aw + HEAD.gap);
      const widthR = u.right.length * (HEAD.aw + HEAD.gap);
      const total = widthL + HEAD.w + widthR;
      const start = cursor;
      cursor += total + 1.4;
      const leftEdge = dirX > 0 ? start : -(start + total);
      const cx = leftEdge + widthL + HEAD.w / 2;
      const center = { x: base.x + cx, y: base.y };
      if (u.main) out.push({ key: `h-${u.main.id}`, group: u.main.id, kind: 'vehicle', p: center, color: u.main.color, name: u.main.name });
      // уровень зелёного сигнала: нижняя лампа корпуса
      const gy = u.main ? center.y - 1.8 : center.y;
      u.left.forEach((a, i) => {
        out.push({ key: `h-${a.id}`, group: a.id, kind: 'arrow', arrow: arrowDirOf(net, a.movements), p: { x: center.x - HEAD.w / 2 - HEAD.gap - HEAD.aw / 2 - i * (HEAD.aw + HEAD.gap), y: gy }, color: a.color, name: a.name });
      });
      u.right.forEach((a, i) => {
        out.push({ key: `h-${a.id}`, group: a.id, kind: 'arrow', arrow: arrowDirOf(net, a.movements), p: { x: center.x + HEAD.w / 2 + HEAD.gap + HEAD.aw / 2 + i * (HEAD.aw + HEAD.gap), y: gy }, color: a.color, name: a.name });
      });
    }
  }
  // пешеходные светофоры — у концов переходов, со стороны центра перекрёстка
  for (const gr of groups) {
    if (gr.kind !== 'pedestrian') continue;
    const placed: V2[] = [];
    for (const m of gr.movements) {
      const ei = net.pedEdgeById.get(m);
      if (ei === undefined) continue;
      const e = net.pedEdges[ei];
      if (e.roadS1 - e.roadS0 < 0.5) continue;
      for (const s of [e.roadS0 - 1.0, e.roadS1 + 1.0]) {
        const q = pointOnPath(e, Math.max(0, Math.min(e.path.length, s)));
        const n = { x: -q.dir.y, y: q.dir.x };
        const side = n.x * q.p.x + n.y * q.p.y >= 0 ? -1 : 1;
        const p = add(q.p, mul(n, side * (e.width / 2 + 1.3)));
        if (placed.some((x) => Math.hypot(x.x - p.x, x.y - p.y) < 2.4)) continue;
        placed.push(p);
        out.push({ key: `h-${gr.id}-${m}-${s.toFixed(0)}`, group: gr.id, kind: 'pedestrian', p, color: gr.color, name: gr.name });
      }
    }
  }
  return out;
}

/** Глиф стрелки в лампе допсекции (в координатах экрана, центр 0,0, радиус ~0,6) */
export function arrowLampPath(dir: ArrowDir): string {
  switch (dir) {
    case 'right': return 'M-0.45,0 L0.15,0 M-0.05,-0.32 L0.4,0 L-0.05,0.32';
    case 'left': return 'M0.45,0 L-0.15,0 M0.05,-0.32 L-0.4,0 L0.05,0.32';
    case 'uturn': return 'M0.3,0.45 L0.3,-0.1 Q0.3,-0.45 0,-0.45 Q-0.3,-0.45 -0.3,-0.1 L-0.3,0.15 M-0.55,-0.05 L-0.3,0.3 L-0.05,-0.05';
    default: return 'M0,0.45 L0,-0.15 M-0.32,0.05 L0,-0.4 L0.32,0.05';
  }
}

/** Боковое смещение членов группы пешеходов (идут рядом, а не гуськом). Последний в группе от трёх человек — ребёнок */
export function pedOffsets(id: number, size: number): Array<{ lat: number; r: number }> {
  const base = (((id * 7) % 5) - 2) * 0.32;
  const out: Array<{ lat: number; r: number }> = [];
  for (let j = 0; j < size; j++) {
    const child = size >= 3 && j === size - 1;
    out.push({ lat: Math.max(-1.6, Math.min(1.6, base + (j - (size - 1) / 2) * 0.62)), r: child ? 0.26 : 0.36 });
  }
  return out;
}
