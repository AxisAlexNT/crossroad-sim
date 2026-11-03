<script setup lang="ts">
// Гистограмма распределения на canvas: столбцы, среднее, медиана и 85-й процентиль.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { app } from './store';

const props = defineProps<{ title: string; values: number[]; unit: string; color?: string; tick: number; integer?: boolean }>();
const cv = ref<HTMLCanvasElement | null>(null);
const info = ref('');
let ro: ResizeObserver | undefined;
let resizeFrame = 0;

function css(n: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
}

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function niceStep(raw: number, integer: boolean) {
  if (!(raw > 0)) return 1
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const m = raw / p
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
  return integer ? Math.max(1, Math.round(step)) : step
}

function draw() {
  const c = cv.value;
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = c.clientHeight;
  if (W < 10) return;
  c.width = Math.round(W * dpr);
  c.height = Math.round(H * dpr);
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const muted = css('--muted'), grid = css('--grid'), fg = css('--fg');
  const vals = props.values.filter((x) => Number.isFinite(x));
  g.font = '11px Inter, sans-serif';
  if (!vals.length) {
    info.value = 'Пока нет данных';
    g.fillStyle = muted;
    g.fillText('Запустите симуляцию', 12, 24);
    return;
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const med = quantile(sorted, 0.5), p85 = quantile(sorted, 0.85);
  info.value = `n = ${vals.length}, среднее ${mean.toFixed(1)} ${props.unit}, медиана ${med.toFixed(1)} ${props.unit}, 85% значений не больше ${p85.toFixed(1)} ${props.unit}`;
  const lo = Math.min(0, sorted[0]);
  let hi = quantile(sorted, 0.995);
  if (!(hi > lo)) hi = lo + 1;
  let bins = Math.min(40, Math.max(8, Math.round(Math.sqrt(vals.length) * 1.5)));
  let width = (hi - lo) / bins;
  if (props.integer) { width = Math.max(1, Math.ceil(width)); bins = Math.ceil((hi - lo + 1) / width); }
  const counts = new Array(bins).fill(0);
  for (const v of vals) counts[Math.max(0, Math.min(bins - 1, Math.floor((v - lo) / width)))]++;
  const rawMax = Math.max(...counts);
  const yStep = niceStep(rawMax / 4, true);
  const maxC = Math.max(yStep, Math.ceil(rawMax / yStep) * yStep);
  const padL = 40, padB = 26, padT = 8, padR = 12;
  const pw = W - padL - padR, ph = H - padT - padB;
  const X = (v: number) => padL + ((v - lo) / (bins * width)) * pw;
  g.strokeStyle = grid;
  g.fillStyle = muted;
  g.textAlign = 'right';
  for (let c = 0; c <= maxC + 1e-9; c += yStep) {
    const y = padT + ph - (ph * c) / maxC;
    g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + pw, y); g.stroke();
    g.fillText(String(c), padL - 4, y + 4);
  }
  g.fillStyle = props.color ?? '#4f8cff';
  counts.forEach((n, i) => {
    const x0 = X(lo + i * width), x1 = X(lo + (i + 1) * width);
    const h = (n / maxC) * ph;
    g.fillRect(x0 + 0.5, padT + ph - h, Math.max(1, x1 - x0 - 1), h);
  });
  g.fillStyle = muted;
  const span = bins * width
  const xStep = niceStep(span / 5, !!props.integer)
  const digits = xStep >= 1 ? 0 : xStep >= 0.1 ? 1 : 2
  for (let v = Math.ceil(lo / xStep) * xStep; v <= lo + span + 1e-9; v += xStep) {
    const x = X(v)
    g.textAlign = x < padL + 12 ? 'left' : x > padL + pw - 12 ? 'right' : 'center'
    g.fillText(v.toFixed(digits), x, H - 8)
  }
  const mark = (v: number, color: string, dash: number[]) => {
    if (!Number.isFinite(v) || v > lo + bins * width) return;
    g.strokeStyle = color; g.setLineDash(dash); g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(X(v), padT); g.lineTo(X(v), padT + ph); g.stroke();
    g.setLineDash([]); g.lineWidth = 1;
  };
  mark(mean, fg, []);
  mark(med, '#f2a33a', [4, 3]);
  mark(p85, '#e5484d', [2, 3]);
}

onMounted(() => {
  ro = new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(draw); });
  if (cv.value) ro.observe(cv.value);
  draw();
});
onBeforeUnmount(() => { ro?.disconnect(); cancelAnimationFrame(resizeFrame); });
watch(() => [props.tick, props.values.length, app.theme], () => draw());
</script>

<template>
  <div class="histo">
    <div class="histo-title">{{ title }}</div>
    <canvas ref="cv" />
    <div class="small muted">{{ info }}</div>
    <div class="histo-legend small muted"><span class="lg mean">среднее</span><span class="lg med">медиана</span><span class="lg p85">85%</span></div>
  </div>
</template>
