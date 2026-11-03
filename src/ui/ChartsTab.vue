<script setup lang="ts">
import { computed, ref } from 'vue';
import Experiments from './Experiments.vue';
import UChart from './UChart.vue';
import Histogram from './Histogram.vue';
import { chartsFor } from './charts';
import { app, simRef, download, fileBase } from './store';
import { onSlowTick } from './loop';

const tick = ref(0);
let lastT = -1;
onSlowTick(() => {
  const t = simRef.value?.st.t ?? 0;
  if (app.tab === 'charts' && t !== lastT) { lastT = t; tick.value++; }
});
const series = computed(() => { void tick.value; void app.version; return simRef.value?.series; });
const charts = computed(() => { void app.version; return chartsFor(app.cfg); });
const armSel = ref('all');
const arms = computed(() => app.cfg.arms);
const pick = (arr: Array<{ a: string; v: number }> | undefined, all = true) => (arr ?? []).filter((x) => (armSel.value === 'all' ? all || x.a === 'all' : x.a === armSel.value)).map((x) => x.v);
const hist = computed(() => {
  void tick.value; void app.version;
  const sm = simRef.value?.samples;
  const sim = simRef.value;
  return {
    wait: pick(sm?.wait),
    delay: pick(sm?.delay),
    ped: (sm?.pedWait ?? []).map((x) => x.v),
    cycle: (sm?.cycle ?? []).filter((x) => x.a === armSel.value).map((x) => x.v),
    dwell: (sm?.dwell ?? []).map((x) => x.v),
    speed: (sim?.st.vehicles ?? []).filter((v) => v.phase !== 'exit' && (armSel.value === 'all' || v.origin === armSel.value)).map((v) => v.v * 3.6),
  };
});

function exportCsv() {
  const s = simRef.value?.series;
  if (!s) return;
  const cols: Array<[string, number[]]> = [];
  for (const [k, v] of Object.entries(s)) {
    if (k === 'queues') for (const [a, q] of Object.entries(v as Record<string, number[]>)) cols.push([`queue_${a}`, q]);
    else cols.push([k, v as number[]]);
  }
  const rows = [cols.map((c) => c[0]).join(';')];
  for (let i = 0; i < s.t.length; i++) rows.push(cols.map((c) => Number.isFinite(c[1][i]) ? c[1][i] : '').join(';'));
  download(`${fileBase()}-metrics.csv`, rows.join('\n'), 'text/csv');
}
</script>

<template>
  <div class="charts-tab">
    <Experiments />
    <div class="row between wrap gap">
      <div class="muted small">Выделите участок мышью или пальцем, чтобы приблизить. Двойной щелчок сбрасывает масштаб. Значения видны в легенде при наведении.</div>
      <button class="btn small" @click="exportCsv">Скачать CSV</button>
    </div>
    <div v-if="series" class="charts-grid">
      <UChart v-for="c in charts" :key="c.id" :title="c.title" :x="series.t" :series="c.series(series)" :height="220" :y-label="c.yLabel" :tick="tick" />
    </div>
    <div class="row between wrap gap" style="margin-top: 14px">
      <h3>Распределения</h3>
      <label class="row gap">Подход
        <select v-model="armSel"><option value="all">все</option><option v-for="a in arms" :key="a.id" :value="a.id">{{ a.short }}</option></select>
      </label>
    </div>
    <div class="charts-grid">
      <Histogram title="Ожидание у стоп-линии" :values="hist.wait" unit="с" color="#f2a33a" :tick="tick" />
      <Histogram title="Задержка проезда через модель" :values="hist.delay" unit="с" color="#a970ff" :tick="tick" />
      <Histogram title="Проезды стоп-линии за цикл" :values="hist.cycle" unit="авт" color="#4f8cff" :tick="tick" integer />
      <Histogram title="Скорость машин сейчас" :values="hist.speed" unit="км/ч" color="#3fc1d9" :tick="tick" />
      <Histogram title="Ожидание пешеходов" :values="hist.ped" unit="с" color="#ffd166" :tick="tick" />
      <Histogram title="Стоянка автобусов на остановках" :values="hist.dwell" unit="с" color="#9bc53d" :tick="tick" />
    </div>
  </div>
</template>
