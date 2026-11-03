<script setup lang="ts">
// Редактор: черновик модели, который правится отдельно от симуляции. Карта с режимами правки,
// панели схемы, выбранного элемента, светофоров, автобусов, файла и проверок. «Перенести в симулятор» — применить черновик.
import { computed, ref, watch } from 'vue';
import MapView from './MapView.vue';
import Inspector from './Inspector.vue';
import PhaseEditor from './PhaseEditor.vue';
import EditorSchema from './EditorSchema.vue';
import { app, loadModel, toast } from './store';
import { editor } from './ctx';
import { runChecks } from '../engine/checks';
import { reconcile } from '../engine/generate';
import type { BusStop } from '../engine/types';

type Panel = 'schema' | 'item' | 'signals' | 'transit' | 'file' | 'checks';
const panel = ref<Panel>('schema');
const PANELS: Array<[Panel, string]> = [['schema', 'Схема'], ['item', 'Элемент'], ['signals', 'Светофоры'], ['transit', 'Автобусы'], ['file', 'Файл'], ['checks', 'Проверки']];
const LAYERS: Array<[typeof editor.layer, string]> = [['arms', 'Подходы'], ['veh', 'Полосы и направления'], ['ped', 'Пешеходы'], ['stops', 'Остановки']];

let skip = 0;
watch(() => editor.cfg, () => {
  if (skip > 0) { skip--; return; }
  editor.dirty = true;
}, { deep: true });
watch(() => editor.selected, (s) => { if (s) panel.value = 'item'; });

const checks = computed(() => {
  void editor.version;
  try { return runChecks(JSON.parse(JSON.stringify(editor.cfg)), { draftAsError: app.draftAsError }); } catch (e) { return [{ level: 'error' as const, code: 'build', msg: 'Не удалось проверить модель. Проверьте геометрию и код узлов.' }]; }
});
const counts = computed(() => ({ error: checks.value.filter((c) => c.level === 'error').length, warn: checks.value.filter((c) => c.level === 'warn').length }));
const LEVEL = { error: 'Ошибка', warn: 'Предупреждение', info: 'Сведения' } as const;

function toSim() {
  const cfg = reconcile(JSON.parse(JSON.stringify(editor.cfg)));
  loadModel(cfg, 'Черновик перенесён в симулятор, симуляция начата заново');
  editor.dirty = false;
  app.tab = 'sim';
}
function fromSim() {
  skip = 1;
  editor.cfg = JSON.parse(JSON.stringify(app.cfg));
  editor.selected = null;
  editor.dirty = false;
  editor.version++;
  toast('В редактор загружена модель из симулятора');
}

// --- автобусы ---
const tr = computed(() => editor.cfg.transit);
const newStop = ref<{ arm: string; side: BusStop['side'] }>({ arm: editor.cfg.arms[0]?.id ?? '', side: 'exit' });
function addStop() {
  let k = 1;
  while (tr.value.stops.some((s) => s.id === `ST${k}`)) k++;
  const arm = editor.cfg.arms.find((a) => a.id === newStop.value.arm) ?? editor.cfg.arms[0];
  if (!arm) return;
  tr.value.stops.push({ id: `ST${k}`, name: `Остановка ${k}`, arm: arm.id, side: newStop.value.side, dist: 25, bay: true });
  editor.selected = { kind: 'stop', id: `ST${k}` };
  editor.layer = 'stops';
}
function addRoute() {
  let k = 1;
  while (tr.value.routes.some((r) => r.id === `R${k}`)) k++;
  const a = editor.cfg.arms[0], b = editor.cfg.arms[Math.min(2, editor.cfg.arms.length - 1)];
  tr.value.routes.push({ id: `R${k}`, name: `Маршрут ${k}`, from: a.id, to: b.id, stops: [], perHour: 4, length: 12, enabled: true });
  editor.selected = { kind: 'route', id: `R${k}` };
}
const armShort = (id: string) => editor.cfg.arms.find((a) => a.id === id)?.short ?? id;
</script>

<template>
  <div class="editor-tab">
    <div class="editor-bar">
      <button class="btn primary" @click="toSim">Перенести в симулятор</button>
      <button class="btn" @click="fromSim">Взять из симулятора</button>
      <span class="small" :class="editor.dirty ? 'warn-text' : 'muted'">{{ editor.dirty ? 'Черновик отличается от модели в симуляторе' : 'Черновик совпадает с моделью в симуляторе' }}</span>
      <button class="btn small" :class="{ bad: counts.error }" @click="panel = 'checks'">Ошибок {{ counts.error }}, предупреждений {{ counts.warn }}</button>
    </div>
    <div class="editor-main">
      <div class="editor-map">
        <div class="layer-tabs">
          <button v-for="[id, label] in LAYERS" :key="id" :class="{ on: editor.layer === id }" @click="editor.layer = id">{{ label }}</button>
        </div>
        <MapView ctx="editor" class="editor-mapview" />
      </div>
      <div class="editor-side">
        <div class="seg-tabs wrap">
          <button v-for="[id, label] in PANELS" :key="id" :class="{ on: panel === id }" @click="panel = id">{{ label }}</button>
        </div>
        <EditorSchema v-if="panel === 'schema'" part="schema" />
        <EditorSchema v-else-if="panel === 'file'" part="file" />
        <template v-else-if="panel === 'item'">
          <Inspector ctx="editor" />
          <div v-if="editor.selected" class="row"><button class="btn small" @click="editor.selected = null">Снять выделение</button></div>
        </template>
        <PhaseEditor v-else-if="panel === 'signals'" ctx="editor" />
        <div v-else-if="panel === 'transit'" class="transit-panel">
          <section>
            <h3>Рейсовые автобусы</h3>
            <label class="check"><input v-model="tr.enabled" type="checkbox" /> Автобусы по маршрутам</label>
            <div class="grid2">
              <label>Стоянка на остановке от, с <input v-model.number="tr.dwellMin" type="number" min="5" step="5" /></label>
              <label>до, с <input v-model.number="tr.dwellMax" type="number" min="5" step="5" /></label>
            </div>
            <div class="small muted">Крупные машины без маршрута задаются долей типа «автобус» в узлах появления машин.</div>
          </section>
          <section>
            <div class="row between wrap gap">
              <h3>Остановки</h3>
              <div class="row gap">
                <select v-model="newStop.arm"><option v-for="a in editor.cfg.arms" :key="a.id" :value="a.id">{{ a.short }}</option></select>
                <select v-model="newStop.side"><option value="approach">перед перекрёстком</option><option value="exit">за перекрёстком</option></select>
                <button class="btn small" @click="addStop">+ остановка</button>
              </div>
            </div>
            <table class="tbl">
              <thead>
                <tr><th>Название</th><th>Где</th><th>м</th><th>Карман</th></tr>
              </thead>
              <tbody>
                <tr v-for="s in tr.stops" :key="s.id" class="clickable" @click="editor.selected = { kind: 'stop', id: s.id }">
                  <td>{{ s.name }}</td><td>{{ armShort(s.arm) }}, {{ s.side === 'approach' ? 'перед' : 'за' }}</td><td>{{ s.dist }}</td><td>{{ s.bay ? 'да' : 'нет' }}</td>
                </tr>
              </tbody>
            </table>
          </section>
          <section>
            <div class="row between wrap gap">
              <h3>Маршруты</h3>
              <button class="btn small" @click="addRoute">+ маршрут</button>
            </div>
            <table class="tbl">
              <thead>
                <tr><th>Маршрут</th><th>Откуда — куда</th><th>в час</th><th>Интервал</th><th /></tr>
              </thead>
              <tbody>
                <tr v-for="r in tr.routes" :key="r.id" class="clickable" :class="{ off: !r.enabled }" @click="editor.selected = { kind: 'route', id: r.id }">
                  <td>{{ r.name }}</td><td>{{ armShort(r.from) }} — {{ armShort(r.to) }}</td><td>{{ r.perHour }}</td><td>{{ r.headway ?? '' }}</td>
                  <td><input v-model="r.enabled" type="checkbox" title="Маршрут работает" @click.stop /></td>
                </tr>
              </tbody>
            </table>
            <div class="small muted">Число автобусов в час по каждому маршруту оценено по интервалам из расписаний, середина диапазона. Перед выводами его стоит сверить с данными перевозчика.</div>
          </section>
        </div>
        <section v-else-if="panel === 'checks'">
          <h3>Проверки черновика</h3>
          <div v-for="(c, i) in checks" :key="i" class="check-item" :class="c.level">
            <span class="lvl">{{ LEVEL[c.level] }}</span>
            <span class="msg">{{ c.msg }}</span>
            <span />
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
