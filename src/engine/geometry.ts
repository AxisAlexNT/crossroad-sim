// Геометрия: векторы, кривые Безье, полилинии с параметризацией по длине, пересечения, OBB.

export interface V2 {
  x: number;
  y: number;
}

export const v = (x: number, y: number): V2 => ({ x, y });
export const add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: V2, k: number): V2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: V2, b: V2): number => a.x * b.x + a.y * b.y;
export const cross = (a: V2, b: V2): number => a.x * b.y - a.y * b.x;
export const len = (a: V2): number => Math.hypot(a.x, a.y);
export const dist = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: V2): V2 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
/** Перпендикуляр «вправо» от направления (в системе y — вверх) */
export const right = (d: V2): V2 => ({ x: d.y, y: -d.x });

export function cubic(p0: V2, p1: V2, p2: V2, p3: V2, t: number): V2 {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** Полилиния с накопленной длиной, направлением и ограничением скорости по кривизне */
export interface Polyline {
  pts: V2[];
  /** накопленная длина в каждой точке */
  cum: number[];
  /** направление (рад) в каждой точке */
  hdg: number[];
  /** ограничение скорости по кривизне в каждой точке, м/с */
  vmax: number[];
  length: number;
}

export function makePolyline(pts: V2[], lateralAccel = 2.2): Polyline {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const hdg: number[] = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    return Math.atan2(b.y - a.y, b.x - a.x);
  });
  const vmax: number[] = pts.map((_, i) => {
    if (i === 0 || i === pts.length - 1) return 99;
    const da = angleDiff(hdg[i + 1] ?? hdg[i], hdg[i - 1]);
    const ds = cum[Math.min(pts.length - 1, i + 1)] - cum[Math.max(0, i - 1)];
    const k = Math.abs(da) / Math.max(ds, 1e-6);
    if (k < 1e-4) return 99;
    return Math.sqrt(lateralAccel / k);
  });
  // сглаживание ограничений (берём минимум по окрестности)
  const sm = vmax.map((_, i) => Math.min(...vmax.slice(Math.max(0, i - 2), i + 3)));
  return { pts, cum, hdg, vmax: sm, length: cum[cum.length - 1] };
}

export function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Индекс сегмента для расстояния s (бинарный поиск) */
function segIndex(pl: Polyline, s: number): number {
  const c = pl.cum;
  if (s <= 0) return 0;
  if (s >= pl.length) return c.length - 2;
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c[mid] <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function pointAt(pl: Polyline, s: number): { p: V2; h: number } {
  if (pl.pts.length < 2) return { p: pl.pts[0], h: 0 };
  if (s > pl.length) {
    // экстраполяция за конец
    const i = pl.pts.length - 1;
    const h = pl.hdg[i];
    const ex = s - pl.length;
    return { p: { x: pl.pts[i].x + Math.cos(h) * ex, y: pl.pts[i].y + Math.sin(h) * ex }, h };
  }
  const i = segIndex(pl, s);
  const a = pl.pts[i], b = pl.pts[i + 1];
  const segLen = pl.cum[i + 1] - pl.cum[i] || 1;
  const t = Math.max(0, Math.min(1, (s - pl.cum[i]) / segLen));
  return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, h: Math.atan2(b.y - a.y, b.x - a.x) };
}

export function vmaxAt(pl: Polyline, s: number): number {
  const i = segIndex(pl, s);
  return Math.min(pl.vmax[i], pl.vmax[i + 1] ?? 99);
}

/** Пересечение отрезков; возвращает параметры t,u ∈ [0,1] или null */
export function segIntersect(a: V2, b: V2, c: V2, d: V2): { t: number; u: number } | null {
  const r = sub(b, a), s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-9) return null;
  const qp = sub(c, a);
  const t = cross(qp, s) / den;
  const u = cross(qp, r) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

/** Все пересечения двух полилиний: позиции по длине на каждой */
export function polylineIntersections(a: Polyline, b: Polyline): Array<{ sa: number; sb: number; p: V2 }> {
  const out: Array<{ sa: number; sb: number; p: V2 }> = [];
  for (let i = 0; i < a.pts.length - 1; i++) {
    const a0 = a.pts[i], a1 = a.pts[i + 1];
    // быстрая отсечка по AABB
    const minAx = Math.min(a0.x, a1.x), maxAx = Math.max(a0.x, a1.x);
    const minAy = Math.min(a0.y, a1.y), maxAy = Math.max(a0.y, a1.y);
    for (let j = 0; j < b.pts.length - 1; j++) {
      const b0 = b.pts[j], b1 = b.pts[j + 1];
      if (Math.max(b0.x, b1.x) < minAx || Math.min(b0.x, b1.x) > maxAx) continue;
      if (Math.max(b0.y, b1.y) < minAy || Math.min(b0.y, b1.y) > maxAy) continue;
      const r = segIntersect(a0, a1, b0, b1);
      if (r) {
        out.push({
          sa: a.cum[i] + r.t * (a.cum[i + 1] - a.cum[i]),
          sb: b.cum[j] + r.u * (b.cum[j + 1] - b.cum[j]),
          p: { x: a0.x + (a1.x - a0.x) * r.t, y: a0.y + (a1.y - a0.y) * r.t },
        });
      }
    }
  }
  return out;
}

/** Ориентированный прямоугольник (габарит машины) */
export interface OBB {
  cx: number;
  cy: number;
  /** полудлина и полуширина */
  hl: number;
  hw: number;
  /** направление (рад) */
  h: number;
}

function obbAxes(o: OBB): [V2, V2] {
  const c = Math.cos(o.h), s = Math.sin(o.h);
  return [{ x: c, y: s }, { x: -s, y: c }];
}

function projRadius(o: OBB, axis: V2): number {
  const [ax, ay] = obbAxes(o);
  return o.hl * Math.abs(dot(ax, axis)) + o.hw * Math.abs(dot(ay, axis));
}

/** Пересекаются ли два прямоугольника (теорема о разделяющей оси) */
export function obbOverlap(a: OBB, b: OBB): boolean {
  const d = { x: b.cx - a.cx, y: b.cy - a.cy };
  const maxR = a.hl + a.hw + b.hl + b.hw;
  if (Math.abs(d.x) > maxR || Math.abs(d.y) > maxR) return false;
  for (const axis of [...obbAxes(a), ...obbAxes(b)]) {
    const dist = Math.abs(dot(d, axis));
    if (dist > projRadius(a, axis) + projRadius(b, axis)) return false;
  }
  return true;
}

export function obbCorners(o: OBB): V2[] {
  const [ax, ay] = obbAxes(o);
  const c = { x: o.cx, y: o.cy };
  return [
    add(add(c, mul(ax, o.hl)), mul(ay, o.hw)),
    add(sub(c, mul(ax, o.hl)), mul(ay, o.hw)),
    sub(sub(c, mul(ax, o.hl)), mul(ay, o.hw)),
    sub(add(c, mul(ax, o.hl)), mul(ay, o.hw)),
  ];
}
