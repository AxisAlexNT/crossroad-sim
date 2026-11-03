<script setup lang="ts">
// Интерактивный график на uPlot: наведение со значениями, выделение мышью или пальцем — масштаб, двойной клик — сброс.
// График пересоздаётся только при смене набора рядов, заголовка или темы. Новые данные не сбрасывают масштаб, выбранный пользователем.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { app } from './store';
import type { ChartSeries } from './charts';

const props = defineProps<{ title: string; x: number[]; series: ChartSeries[]; height?: number; xLabel?: string; yLabel?: string; scatter?: boolean; tick?: number }>();
const host = ref<HTMLDivElement | null>(null);
let plot: uPlot | null = null;
let ro: ResizeObserver | undefined;
let zoomed = false;

function cssVar(n: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
}

function build() {
  plot?.destroy();
  plot = null;
  zoomed = false;
  if (!host.value) return;
  const axisStroke = cssVar('--muted');
  const grid = cssVar('--grid');
  const opts: uPlot.Options = {
    width: Math.max(200, host.value.clientWidth),
    height: props.height ?? 200,
    title: props.title,
    legend: { live: true },
    cursor: { drag: { x: true, y: false }, points: { size: 6 } },
    scales: { x: { time: false } },
    hooks: {
      setSelect: [(u) => { if (u.select.width > 2) zoomed = true; }],
    },
    axes: [
      { stroke: axisStroke, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, label: props.xLabel, labelSize: 18, size: 36 },
      { stroke: axisStroke, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, label: props.yLabel, labelSize: 18, size: 48 },
    ],
    series: [
      { label: props.xLabel ?? 't, с' },
      ...props.series.map((s) => ({
        label: s.label,
        stroke: s.color,
        width: 1.6,
        dash: s.dash ? [5, 4] : undefined,
        points: props.scatter ? { show: true, size: 7, fill: s.color } : { show: false },
        paths: props.scatter ? () => null : undefined,
      })),
    ],
  };
  plot = new uPlot(opts, data(), host.value);
  host.value.querySelector('.u-over')?.addEventListener('dblclick', () => { zoomed = false; plot?.setData(data(), true); });
}

function data(): uPlot.AlignedData {
  return [props.x, ...props.series.map((s) => s.values.map(v => Number.isFinite(v) ? v : null))] as uPlot.AlignedData;
}

onMounted(() => {
  build();
  ro = new ResizeObserver(() => {
    if (!plot || !host.value || host.value.clientWidth < 10) return;
    plot.setSize({ width: Math.max(200, host.value.clientWidth), height: props.height ?? 200 });
    if (pending) { pending = false; plot.setData(data(), !zoomed); }
  });
  if (host.value) ro.observe(host.value);
});
onBeforeUnmount(() => { ro?.disconnect(); plot?.destroy(); });

// скрытый график не перерисовывается, данные подставляются, когда он снова виден
let pending = false;
watch(() => props.tick, () => {
  if (!plot) return;
  if (!host.value || host.value.offsetParent === null) { pending = true; return; }
  pending = false;
  plot.setData(data(), !zoomed);
});
// отдельные источники: массив-геттер создавался бы заново на каждом обновлении и пересоздавал график
watch([() => props.series.length, () => props.series.map((s) => s.label).join('|'), () => props.title, () => app.theme], () => build());
</script>

<template>
  <div ref="host" class="uchart" />
</template>
