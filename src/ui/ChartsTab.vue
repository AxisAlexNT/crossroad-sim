<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import Experiments from './Experiments.vue';
import UChart from './UChart.vue';
import Histogram from './Histogram.vue';
import { chartsFor } from './charts';
import { alignChartValues } from './chartAlignment';
import { app, simRef, download, fileBase } from './store';
import { onSlowTick } from './loop';

type RunSummary = { time: number; exited: number; wait: number | null; collisions: number; mode: 'visual' | 'strict'; interventions: number; seed: number };
function runSummary(): RunSummary {
  const sim = simRef.value;
  return { mode: sim?.cfg.sim.mode ?? 'strict', interventions: sim?.st.counters.interventions ?? 0, seed: sim?.cfg.sim.seed ?? app.cfg.sim.seed, time: sim?.st.t ?? 0, exited: sim?.st.counters.exited ?? 0,
    wait: Number.isFinite(sim?.series.avgWait[sim.series.avgWait.length - 1]) ? sim!.series.avgWait[sim!.series.avgWait.length - 1] : null, collisions: sim?.st.counters.collisions ?? 0 };
}
const savedRuns = shallowRef<Array<{ name: string; series: NonNullable<typeof simRef.value>['series']; charts: ReturnType<typeof chartsFor>; summary: RunSummary }>>([]);
function removeRun(index: number) { savedRuns.value = savedRuns.value.filter((_, i) => i !== index); tick.value++; }
function rememberRun() {
  const sim = simRef.value;
  if (!sim || !sim.series.t.length) return;
  savedRuns.value = [...savedRuns.value.slice(-2), { name: `${sim.cfg.name}, прогон № ${sim.cfg.sim.seed}, ${Math.round(sim.st.t)} с`, series: JSON.parse(JSON.stringify(sim.series)), charts: chartsFor(JSON.parse(JSON.stringify(sim.cfg))), summary: runSummary() }];
  tick.value++;
}
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
watch(() => arms.value.map(a => a.id).join('|'), () => { if (!arms.value.some(a => a.id === armSel.value)) armSel.value = 'all'; });
const modeLabel = (mode: RunSummary['mode']) => mode === 'visual' ? 'Наглядный' : 'Строгий';
const waitLabel = (value: number | null) => value === null || !Number.isFinite(value) ? '—' : value.toFixed(1);
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

function overlay(c: typeof charts.value[number]) {
  const current = series.value;
  if (!current) return { x: [] as number[], series: [] as ReturnType<typeof c.series> };
  if (!savedRuns.value.length) return { x: current.t, series: c.series(current) };
  const all = [{ name: 'Сейчас', series: current, charts: charts.value }, ...savedRuns.value];
  const x = [...new Set(all.flatMap(run => run.series.t))].sort((a, b) => a - b);
  return { x, series: all.flatMap((run, index) => {
    const definition = run.charts.find(chart => chart.id === c.id);
    return (definition?.series(run.series) ?? []).map(line => ({ ...line, label: `${line.label} — ${run.name}`,
      dash: index > 0 || line.dash,
      values: alignChartValues(run.series.t, line.values, x),
    }));
  }) };
}
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
    <section class="saved-runs">
      <h3>Сравнить с текущим прогоном</h3>
      <button class="btn" :disabled="!series?.t.length" @click="rememberRun">Запомнить прогон для сравнения</button>
      <p class="small muted">Можно запомнить до трёх прогонов до закрытия страницы. Их линии показаны пунктиром. Для сравнения влияния настроек используйте одинаковый номер случайного прогона и одинаковые потоки.</p>
      <div v-for="(run, i) in savedRuns" :key="i" class="row wrap gap">
        <span>{{ run.name }}</span><button class="btn small" :aria-label="'Убрать сравнение: ' + run.name" @click="removeRun(i)">Убрать</button>
      </div>
      <div v-if="savedRuns.length" class="table-scroll">
        <table class="tbl"><thead><tr><th>Прогон</th><th>Режим</th><th>Вмешательства</th><th>Время, с</th><th>Выехало</th><th>Ожидание, с</th><th>Столкновения</th></tr></thead>
          <tbody><tr><th>Сейчас · № {{ runSummary().seed }}</th><td>{{ modeLabel(runSummary().mode) }}</td><td>{{ runSummary().interventions }}</td><td>{{ runSummary().time.toFixed(0) }}</td><td>{{ runSummary().exited }}</td><td>{{ waitLabel(runSummary().wait) }}</td><td>{{ runSummary().collisions }}</td></tr>
            <tr v-for="(run, i) in savedRuns" :key="i"><th>{{ run.name }}</th><td>{{ modeLabel(run.summary.mode) }}</td><td>{{ run.summary.interventions }}</td><td>{{ run.summary.time.toFixed(0) }}</td><td>{{ run.summary.exited }}</td><td>{{ waitLabel(run.summary.wait) }}</td><td>{{ run.summary.collisions }}</td></tr>
          </tbody>
        </table>
        <p class="small">Прогоны с вмешательствами модели нельзя использовать для оценки светофорной программы.</p>
        <p class="small muted">Сопоставляйте показатели на одинаковом времени расчёта. У сохранённого прогона остаются его направления и подписи. Прочерк означает, что измерений пока нет.</p>
      </div>
    </section>
    <details><summary>Сравнение серий случайных прогонов</summary><Experiments /></details>
    <div class="row between wrap gap">
      <div class="muted small">Выделите участок мышью или пальцем, чтобы приблизить. Двойной щелчок сбрасывает масштаб. Значения видны в легенде при наведении.</div>
      <button class="btn small" @click="exportCsv">Скачать таблицу</button>
    </div>
    <div v-if="series" class="charts-grid">
      <UChart v-for="c in charts" :key="c.id" :title="c.title" :x="overlay(c).x" :series="overlay(c).series" :height="220" :y-label="c.yLabel" :tick="tick" />
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
