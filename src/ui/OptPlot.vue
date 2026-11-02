<script setup lang="ts">
// График результатов оптимизации на canvas: точечный (выбор осей x и y) или контурный (x, y и z — высота и цвет),
// как в инструментах анализа подбора гиперпараметров. Интерполяция по ближайшим точкам (обратные расстояния),
// изолинии — методом «марширующих квадратов».
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { app } from './store';

import type { PlotAxis, PlotPoint } from './optplot';

const props = defineProps<{ mode: 'scatter' | 'contour'; points: PlotPoint[]; axes: PlotAxis[]; x: string; y: string; z?: string; tick: number }>();
const emit = defineEmits<{ (e: 'update:x', v: string): void; (e: 'update:y', v: string): void; (e: 'update:z', v: string): void; (e: 'pick', i: number): void }>();
const cv = ref<HTMLCanvasElement | null>(null);
const tip = ref('');
let ro: ResizeObserver | undefined;
let hits: Array<{ px: number; py: number; i: number }> = [];

const xs = computed({ get: () => props.x, set: (v) => emit('update:x', v) });
const ys = computed({ get: () => props.y, set: (v) => emit('update:y', v) });
const zs = computed({ get: () => props.z ?? '', set: (v) => emit('update:z', v) });
const labelOf = (id: string) => props.axes.find((a) => a.id === id)?.label ?? id;

function css(n: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
}

const VIRIDIS = [[68, 1, 84], [65, 68, 135], [42, 120, 142], [34, 168, 132], [122, 209, 81], [253, 231, 37]];
function cmap(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
  const f = x - i;
  const a = VIRIDIS[i], b = VIRIDIS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (!(hi > lo)) return [lo];
  const step0 = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function draw() {
  const c = cv.value;
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = c.clientHeight;
  if (W < 10 || H < 10) return;
  c.width = Math.round(W * dpr);
  c.height = Math.round(H * dpr);
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const fg = css('--fg'), muted = css('--muted'), grid = css('--grid'), accent = css('--accent'), ok = css('--ok'), bad = css('--bad');
  const padL = 52, padB = 34, padT = 10, padR = props.mode === 'contour' ? 58 : 12;
  const pw = W - padL - padR, ph = H - padT - padB;
  const pts = props.points
    .map((p, i) => ({ x: p.v[props.x], y: p.v[props.y], z: props.z ? p.v[props.z] : undefined, p, i }))
    .filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y)) as Array<{ x: number; y: number; z: number | undefined; p: PlotPoint; i: number }>;
  g.font = '11px Inter, sans-serif';
  if (!pts.length) {
    g.fillStyle = muted;
    g.fillText('Нет точек для выбранных осей', padL + 8, padT + 20);
    hits = [];
    return;
  }
  let x0 = Math.min(...pts.map((q) => q.x)), x1 = Math.max(...pts.map((q) => q.x));
  let y0 = Math.min(...pts.map((q) => q.y)), y1 = Math.max(...pts.map((q) => q.y));
  if (x1 - x0 < 1e-9) { x0 -= 1; x1 += 1; }
  if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
  const mx = (x1 - x0) * 0.04, my = (y1 - y0) * 0.06;
  x0 -= mx; x1 += mx; y0 -= my; y1 += my;
  const X = (v: number) => padL + ((v - x0) / (x1 - x0)) * pw;
  const Y = (v: number) => padT + ph - ((v - y0) / (y1 - y0)) * ph;

  // контурная заливка
  if (props.mode === 'contour' && props.z) {
    const zp = pts.filter((q) => Number.isFinite(q.z) && q.p.feasible).slice(-1500) as Array<{ x: number; y: number; z: number }>;
    if (zp.length >= 3) {
      const zmin = Math.min(...zp.map((q) => q.z)), zmax = Math.max(...zp.map((q) => q.z));
      const N = 48;
      const gridZ: number[][] = [];
      const sx = x1 - x0, sy = y1 - y0;
      for (let j = 0; j <= N; j++) {
        const row: number[] = [];
        const gy = y0 + (j / N) * sy;
        for (let i = 0; i <= N; i++) {
          const gx = x0 + (i / N) * sx;
          let num = 0, den = 0, exact: number | null = null;
          for (const q of zp) {
            const dx = (q.x - gx) / sx, dy = (q.y - gy) / sy;
            const d2 = dx * dx + dy * dy;
            if (d2 < 1e-10) { exact = q.z; break; }
            const w = 1 / (d2 * d2);
            num += w * q.z;
            den += w;
          }
          row.push(exact ?? num / den);
        }
        gridZ.push(row);
      }
      const span = zmax - zmin || 1;
      const cw = pw / N, chh = ph / N;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const zz = (gridZ[j][i] + gridZ[j][i + 1] + gridZ[j + 1][i] + gridZ[j + 1][i + 1]) / 4;
          const [r, gg, b] = cmap((zz - zmin) / span);
          g.fillStyle = `rgb(${r | 0},${gg | 0},${b | 0})`;
          g.fillRect(padL + i * cw, padT + ph - (j + 1) * chh, cw + 0.6, chh + 0.6);
        }
      }
      // изолинии
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.lineWidth = 0.8;
      const levels = 8;
      for (let k = 1; k < levels; k++) {
        const lv = zmin + (span * k) / levels;
        g.beginPath();
        for (let j = 0; j < N; j++) {
          for (let i = 0; i < N; i++) {
            const a = gridZ[j][i], b = gridZ[j][i + 1], cc = gridZ[j + 1][i + 1], d = gridZ[j + 1][i];
            const P = (ii: number, jj: number) => [padL + ii * cw, padT + ph - jj * chh] as [number, number];
            const lerp = (p: [number, number], q: [number, number], va: number, vb: number): [number, number] => {
              const t = (lv - va) / (vb - va || 1e-9);
              return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
            };
            const e: Array<[number, number]> = [];
            const pa = P(i, j), pb = P(i + 1, j), pc = P(i + 1, j + 1), pd = P(i, j + 1);
            if ((a < lv) !== (b < lv)) e.push(lerp(pa, pb, a, b));
            if ((b < lv) !== (cc < lv)) e.push(lerp(pb, pc, b, cc));
            if ((cc < lv) !== (d < lv)) e.push(lerp(pc, pd, cc, d));
            if ((d < lv) !== (a < lv)) e.push(lerp(pd, pa, d, a));
            for (let m = 0; m + 1 < e.length; m += 2) { g.moveTo(e[m][0], e[m][1]); g.lineTo(e[m + 1][0], e[m + 1][1]); }
          }
        }
        g.stroke();
      }
      // шкала
      const bx = W - padR + 14, bw = 10;
      for (let k = 0; k < ph; k++) {
        const [r, gg, b] = cmap(1 - k / ph);
        g.fillStyle = `rgb(${r | 0},${gg | 0},${b | 0})`;
        g.fillRect(bx, padT + k, bw, 1.2);
      }
      g.fillStyle = muted;
      g.textAlign = 'left';
      g.fillText(fmt(zmax), bx + bw + 3, padT + 9);
      g.fillText(fmt(zmin), bx + bw + 3, padT + ph);
    } else {
      g.fillStyle = muted;
      g.fillText('Для контура нужно хотя бы три допустимые точки', padL + 8, padT + 20);
    }
  }

  // оси и сетка
  g.strokeStyle = grid;
  g.lineWidth = 1;
  g.fillStyle = muted;
  g.textAlign = 'center';
  for (const t of niceTicks(x0, x1)) {
    const px = X(t);
    if (props.mode === 'scatter') { g.beginPath(); g.moveTo(px, padT); g.lineTo(px, padT + ph); g.stroke(); }
    g.fillText(fmt(t), px, padT + ph + 14);
  }
  g.textAlign = 'right';
  for (const t of niceTicks(y0, y1)) {
    const py = Y(t);
    if (props.mode === 'scatter') { g.beginPath(); g.moveTo(padL, py); g.lineTo(padL + pw, py); g.stroke(); }
    g.fillText(fmt(t), padL - 5, py + 4);
  }
  g.strokeStyle = muted;
  g.strokeRect(padL, padT, pw, ph);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.fillText(labelOf(props.x), padL + pw / 2, H - 6);
  g.save();
  g.translate(12, padT + ph / 2);
  g.rotate(-Math.PI / 2);
  g.fillText(labelOf(props.y), 0, 0);
  g.restore();

  // точки
  hits = [];
  for (const q of pts) {
    const px = X(q.x), py = Y(q.y);
    hits.push({ px, py, i: q.i });
    g.beginPath();
    g.arc(px, py, q.p.front ? 4 : 2.6, 0, Math.PI * 2);
    if (props.mode === 'contour') {
      g.fillStyle = q.p.feasible ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.35)';
      g.strokeStyle = q.p.front ? '#ffffff' : 'rgba(255,255,255,0.6)';
    } else {
      g.fillStyle = !q.p.feasible ? bad + '66' : q.p.front ? ok : accent + 'aa';
      g.strokeStyle = q.p.front ? fg : 'transparent';
    }
    g.fill();
    g.lineWidth = 1;
    g.stroke();
  }
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

function onMove(e: PointerEvent) {
  const c = cv.value;
  if (!c) return;
  const r = c.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  let best: { i: number; d: number } | null = null;
  for (const h of hits) {
    const d = Math.hypot(h.px - mx, h.py - my);
    if (d < 10 && (!best || d < best.d)) best = { i: h.i, d };
  }
  tip.value = best ? props.points[best.i].label : '';
}
function onClick(e: PointerEvent) {
  onMove(e);
  const c = cv.value;
  if (!c) return;
  const r = c.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const h = hits.find((x) => Math.hypot(x.px - mx, x.py - my) < 10);
  if (h) emit('pick', h.i);
}

onMounted(() => {
  ro = new ResizeObserver(() => draw());
  if (cv.value) ro.observe(cv.value);
  draw();
});
onBeforeUnmount(() => ro?.disconnect());
watch(() => [props.tick, props.x, props.y, props.z, props.mode, app.theme, props.points.length], () => draw());
</script>

<template>
  <div class="opt-plot">
    <div class="axes">
      <label>Ось X <select v-model="xs"><option v-for="a in axes" :key="a.id" :value="a.id">{{ a.label }}</option></select></label>
      <label>Ось Y <select v-model="ys"><option v-for="a in axes" :key="a.id" :value="a.id">{{ a.label }}</option></select></label>
      <label v-if="mode === 'contour'">Высота и цвет, ось Z <select v-model="zs"><option v-for="a in axes" :key="a.id" :value="a.id">{{ a.label }}</option></select></label>
    </div>
    <canvas ref="cv" @pointermove="onMove" @pointerdown="onClick" @pointerleave="tip = ''" />
    <div class="tip">{{ tip || (mode === 'contour' ? 'Цвет — значение Z, интерполированное между точками, линии — уровни Z. Точки — оценённые варианты.' : 'Зелёные — недоминируемые варианты, красные — нарушают ограничения. Нажмите на точку, чтобы найти её в таблице.') }}</div>
  </div>
</template>
