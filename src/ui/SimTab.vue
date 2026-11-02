<script setup lang="ts">
import { computed, ref } from 'vue';
import MapView from './MapView.vue';
import Inspector from './Inspector.vue';
import PhaseEditor from './PhaseEditor.vue';
import UChart from './UChart.vue';
import { app, simRef } from './store';
import { pause, play, restart, stepPhase, stepSeconds, onSlowTick } from './loop';
import { chartsFor } from './charts';

const SPEEDS = [1, 2, 5, 10, 60, 600];
const custom = ref(3);
const mapRef = ref<InstanceType<typeof MapView> | null>(null);
defineExpose({ mapRef });

const fmt = (t: number) => {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
// графики обновляются, только когда меняется время модели (на паузе масштаб не сбрасывается)
const chartTick = ref(0);
let lastT = -1;
onSlowTick(() => {
  const t = simRef.value?.st.t ?? 0;
  if (t !== lastT) { lastT = t; chartTick.value++; }
});
const series = computed(() => { void chartTick.value; void app.version; return simRef.value?.series; });
const mini = computed(() => { void app.version; return chartsFor(app.cfg).filter((c) => c.id === 'wait' || c.id === 'queue'); });
const panel = ref<'signals' | 'inspector'>('signals');
const s = computed(() => { void app.statTick; return app.stats; });
function setSpeed(v: number) { app.speed = Math.max(1, Math.round(v)); }
function openLimits() {
  app.aboutAnchor = 'limits';
  app.tab = 'about';
}
</script>

<template>
  <div class="sim-tab">
    <div class="sim-main">
      <div v-if="!app.bannerClosed" class="limits-banner" role="note">
        <span>Экспериментальная модель с условными интенсивностями, геометрией и программами светофоров, при её создании использовались ИИ-агенты.
          Результаты нужно проверять, учитывайте <a href="#limits" @click.prevent="openLimits">ограничения модели</a>.</span>
        <button class="banner-close" title="Скрыть плашку" aria-label="Скрыть плашку" @click="app.bannerClosed = true">✕</button>
      </div>
      <div v-if="!app.hintClosed" class="quick-hint" role="note">
        <span><b>Как начать:</b> выберите вариант программы в панели «Светофор и фазы» → ▶ → вкладка «Графики». Значок ? на карте объясняет кнопки.</span>
        <button class="banner-close" title="Скрыть подсказку" aria-label="Скрыть подсказку" @click="app.hintClosed = true">✕</button>
      </div>
      <MapView ref="mapRef" class="sim-map" />
      <div class="controls">
        <div class="ctl-row">
          <div class="row gap ctl-buttons">
            <button class="btn icon" title="Сначала" @click="restart">⏮</button>
            <button class="btn icon" title="Назад до предыдущего переключения сигналов" @click="stepPhase(-1)">⏪</button>
            <button class="btn icon" title="Назад на 1 с" @click="stepSeconds(-1)">−1с</button>
            <button class="btn icon play" :title="app.playing ? 'Пауза' : 'Пуск'" @click="app.playing ? pause() : play()">{{ app.playing ? '⏸' : '▶' }}</button>
            <button class="btn icon" title="Вперёд на 1 с" @click="stepSeconds(1)">+1с</button>
            <button class="btn icon" title="Вперёд до следующего переключения сигналов" @click="stepPhase(1)">⏩</button>
          </div>
          <div class="row wrap gap ctl-speed">
            <select v-model="app.speedMode" title="Единица скорости">
              <option value="seconds">секунды</option>
              <option value="steps">переключения фаз</option>
            </select>
            <div class="speeds">
              <button v-for="v in SPEEDS" :key="v" class="btn small" :class="{ on: app.speed === v }" @click="setSpeed(v)">×{{ v }}</button>
              <span class="custom-speed">×<input v-model.number="custom" type="number" min="1" step="1" @change="setSpeed(custom)" /></span>
            </div>
          </div>
        </div>
        <div class="status-line" aria-live="off">
          <span class="clock">{{ fmt(s.t) }}</span>
          <span class="phase-now" :title="`${s.phase} · ${s.segment}`">{{ s.phase }} · {{ s.segment }}</span>
          <span class="seg-left">ещё {{ Math.ceil(s.segLeft) }} с</span>
          <span class="lag" :class="{ shown: s.lag }" title="Устройство не успевает с такой скоростью, показывается максимально возможная">не успевает: ×{{ s.realSpeed.toFixed(1) }}</span>
        </div>
        <div class="status-badges">
          <span v-if="s.deadlock" class="sbadge bad" :title="s.deadlock">Взаимная блокировка с {{ fmt(s.deadlockSince) }}: {{ s.deadlock }}</span>
          <span v-if="s.stall" class="sbadge bad">Нет проезда: {{ s.stall }}</span>
          <span v-if="s.slow" class="sbadge warn">Скорость падает: {{ s.slow }}</span>
          <span v-if="!s.deadlock && !s.stall && !s.slow" class="sbadge ok">Движение без блокировок</span>
        </div>
      </div>
      <div class="kpis">
        <div class="kpi"><span>Машин в модели</span><b>{{ s.vehicles }}</b></div>
        <div class="kpi"><span>Проехало</span><b>{{ s.crossed }}</b></div>
        <div class="kpi"><span>Ожидание, с</span><b>{{ s.avgWait.toFixed(0) }}</b></div>
        <div class="kpi"><span>Машин в час</span><b>{{ s.throughput }}</b></div>
        <div class="kpi"><span>Наибольшая очередь</span><b>{{ s.maxQueue }}</b></div>
        <div class="kpi warn"><span>Опасные моменты</span><b>{{ s.dangers }}</b></div>
        <div class="kpi bad" title="Пересечения габаритов машин в расчёте модели"><span>Столкновения в модели</span><b>{{ s.collisions }}</b></div>
        <div class="kpi bad"><span>Ошибки выбора полосы</span><b>{{ s.errors }}</b></div>
        <div class="kpi warn"><span>Нарушения ПДД</span><b>{{ s.violations }}</b></div>
        <div class="kpi"><span>Не успели перестроиться</span><b>{{ s.missed }}</b></div>
        <div class="kpi"><span>Автобусов сейчас</span><b>{{ s.buses }}</b></div>
        <div class="kpi ped"><span>Пешеходов сейчас</span><b>{{ s.peds }}</b></div>
        <div class="kpi ped"><span>Перешли</span><b>{{ s.pedDone }}</b></div>
        <div class="kpi ped"><span>Ожидание пешеходов, с</span><b>{{ s.pedWait.toFixed(0) }}</b></div>
        <div class="kpi warn"><span>Опасно для пешеходов</span><b>{{ s.pedDangers }}</b></div>
        <div class="kpi bad" title="Пересечения габаритов машины и пешеходов на проезжей части в расчёте модели"><span>Наезды в модели</span><b>{{ s.pedHits }}</b></div>
      </div>
    </div>
    <div class="sim-side">
      <div class="seg-tabs">
        <button :class="{ on: panel === 'signals' && !app.selected }" @click="panel = 'signals'; app.selected = null">Светофор и фазы</button>
        <button :class="{ on: panel === 'inspector' || app.selected }" @click="panel = 'inspector'">Выбранный узел</button>
      </div>
      <Inspector v-if="panel === 'inspector' || app.selected" />
      <div v-if="app.selected" class="row"><button class="btn small" @click="app.selected = null; panel = 'signals'">Закрыть</button></div>
      <PhaseEditor v-show="panel === 'signals' && !app.selected" />
      <div v-if="series" class="mini-charts">
        <UChart v-for="c in mini" :key="c.id" :title="c.title" :x="series.t" :series="c.series(series)" :height="150" :y-label="c.yLabel" :tick="chartTick" />
      </div>
    </div>
  </div>
</template>
