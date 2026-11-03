<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import ExperimentWorker from '../engine/experimentWorker?worker&inline';
import { compareExperiments, parseExperiment, type ExperimentResult } from '../engine/experiment';
import { checkFileSize } from '../engine/limits';
import { normalizeModel } from '../engine/model';
import { hasCustomCode } from '../engine/compile';
import { app, download } from './store';
import { sandboxWasm } from './sandboxLoader';
import UChart from './UChart.vue';
const results = shallowRef<ExperimentResult[]>([]);
const revision = ref(0);
watch(results, () => revision.value++);
const horizon = ref(3600), warmup = ref(300), repetitions = ref(10), progress = ref(0), busy = ref(false), error = ref('');
let worker: Worker | null = null;
let generation = 0;
function cancel() { generation++; worker?.terminate(); worker = null; busy.value = false; }
onBeforeUnmount(cancel);
async function run() {
  cancel(); const token = generation; error.value = ''; busy.value = true; progress.value = 0;
  try {
    const cfg = normalizeModel(JSON.parse(JSON.stringify(app.cfg)));
    const wasm = hasCustomCode(cfg) ? (await sandboxWasm()).slice().buffer : undefined;
    if (token !== generation) return;
    worker = new ExperimentWorker();
    worker.onmessage = e => {
      if (token !== generation) return;
      if (e.data.progress) progress.value = e.data.progress;
      if (e.data.error) { error.value = e.data.error; cancel(); }
      if (e.data.result) { results.value = [...results.value.slice(-1), e.data.result]; cancel(); }
    };
    worker.onerror = e => { if (token !== generation) return; error.value = e.message; cancel(); };
    worker.onmessageerror = () => { if (token !== generation) return; error.value = 'Не удалось прочитать результат эксперимента.'; cancel(); };
    worker.postMessage({ spec: { cfg, warmup: warmup.value, horizon: horizon.value, dt: cfg.sim.dt, seeds: Array.from({ length: Math.max(1, Math.min(100, repetitions.value)) }, (_, i) => (cfg.sim.seed + i * 7919) % 2147483648) }, wasm });
  } catch (e) { error.value = String(e); cancel(); }
}
async function importResult(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; if (!file) return;
  try {
    checkFileSize(file.size);
    const loaded = parseExperiment(JSON.parse(await file.text()));
    results.value = [...results.value.slice(-1), loaded];
    error.value = '';
  } catch (e) { error.value = String(e); }
  input.value = '';
}
const comparison = computed(() => {
  if (results.value.length !== 2) return { eligible: false, text: '' };
  try {
    const c = compareExperiments(results.value[0], results.value[1], 'avgWait');
    return { eligible: true, text: `Разность ожидания, вариант 2 − вариант 1: ${c.mean.toFixed(2)} с; 95% интервал: ${c.ci95 === null ? 'недостаточно повторов' : `${(c.mean-c.ci95).toFixed(2)} … ${(c.mean+c.ci95).toFixed(2)} с`}` };
  } catch (e) { return { eligible: false, text: e instanceof Error ? e.message : String(e) }; }
});
const alignedSeries = computed(() => results.value.length === 2
  && JSON.stringify(results.value[0].runs[0].series.t) === JSON.stringify(results.value[1].runs[0].series.t));

</script>
<template>
  <section class="card">
    <h3>Сравнение экспериментов</h3>
    <label>Загрузить результат <input type="file" accept=".json" @change="importResult" /></label>
    <div class="row wrap gap">
      <label>Прогрев, с <input v-model.number="warmup" type="number" min="0" max="86400" /></label>
      <label>Окно, с <input v-model.number="horizon" type="number" min="1" max="86400" /></label>
      <label>Повторы <input v-model.number="repetitions" type="number" min="1" max="100" /></label>
      <button class="btn" :disabled="busy" @click="run">Запустить текущую модель</button>
      <button v-if="busy" class="btn" @click="cancel">Отменить {{ progress }}/{{ repetitions }}</button>
    </div>
    <p class="small muted">Сохраняются два последних эксперимента. Измените модель и запустите второй вариант с теми же зёрнами. Различия спроса и геометрии нужно учитывать при интерпретации.</p>
    <p v-if="error" class="alert">{{ error }}</p>
    <p>{{ comparison.text }}</p>
    <UChart :key="revision" v-if="comparison.eligible && alignedSeries"
      title="Сопоставление первых повторов — историческое ожидание" :x="results[0].runs[0].series.t"
      :series="results.map((r, i) => ({ label: 'Вариант ' + (i + 1), color: i ? '#4f8cff' : '#f2a33a', values: r.runs[0].series.avgWait }))" />
    <p v-if="comparison.eligible && !alignedSeries" class="small muted">Временные сетки рядов различаются; графики показаны отдельно.</p>
    <div v-for="(r, i) in results" :key="`${revision}-${i}`" class="card">
      <b>Вариант {{ i + 1 }}: {{ r.spec.cfg.name }}</b>
      <button class="btn small" @click="download('experiment.json', JSON.stringify(r), 'application/json')">Скачать результат</button>
      <p>{{ r.runs.length }} повторов; непригодных: {{ r.runs.filter(x => x.status !== 'complete').length }}</p>
      <p v-for="run in r.runs.filter(x => x.status === 'invalid')" :key="run.seed">Зерно {{ run.seed }}: {{ run.invalidReasons?.join(', ') || 'прогон непригоден для сравнения' }}</p>
      <UChart :title="'Ожидание, первый повтор — вариант ' + (i + 1) + (r.runs[0].status === 'invalid' ? ' (непригоден для сравнения)' : '')" :x="r.runs[0].series.t" :series="[{ label: 'с', color: '#f2a33a', values: r.runs[0].series.avgWait }]" />
    </div>
  </section>
</template>
