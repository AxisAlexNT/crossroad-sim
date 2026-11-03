<script setup lang="ts">
import { humanFileError } from './migrationText';
// Панель редактора: модель, шаблоны, подходы под любыми углами, автоматическая достройка
// направлений, пешеходного графа и светофорной программы. Работает с черновиком редактора.
import { computed, ref } from 'vue';
import { download, fileBase, toast, vetCustomCode } from './store';
import { editor } from './ctx';
import { TEMPLATES } from '../engine/presets';
import { genConnections, genNodes, genPedGraph, genSignals, newArm, reconcile, sideName } from '../engine/generate';
import { normalizeModel, serializeModel } from '../engine/model';
import { checkFileSize } from '../engine/limits';
import { angleDeg } from '../engine/network';
import schemaText from '../../schema/crossroad-model.schema.json?raw';
import docText from '../../docs/model-format.md?raw';
import type { ModelConfig } from '../engine/types';

const props = defineProps<{ part: 'schema' | 'file' }>();
function loadModel(cfg: ModelConfig, msg: string) {
  editor.cfg = cfg;
  editor.selected = null;
  editor.dirty = true;
  editor.version++;
  toast(msg);
}

const fileInput = ref<HTMLInputElement | null>(null);
const undo = ref<ModelConfig | null>(null);
const jsonText = ref('');
const jsonErr = ref('');
const showJson = ref(false);


function remember() {
  undo.value = JSON.parse(JSON.stringify(editor.cfg));
}
function doUndo() {
  if (!undo.value) return;
  const prev = undo.value;
  undo.value = null;
  loadModel(prev, 'Предыдущая модель восстановлена');
}

function useTemplate(id: string) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return;
  remember();
  loadModel(t.make(), `Открыт шаблон «${t.name}»`);
}

function nextArmId(): string {
  const pool = ['N', 'E', 'S', 'W', 'NE', 'NW', 'SE', 'SW'];
  for (const p of pool) if (!editor.cfg.arms.some((a) => a.id === p)) return p;
  let k = 1;
  while (editor.cfg.arms.some((a) => a.id === `A${k}`)) k++;
  return `A${k}`;
}

function addArm() {
  const angles = editor.cfg.arms.map((a) => angleDeg(a.angle)).sort((a, b) => a - b);
  let best = 0, gapBest = -1;
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i], b = i + 1 < angles.length ? angles[i + 1] : angles[0] + 360;
    if (b - a > gapBest) { gapBest = b - a; best = a + (b - a) / 2; }
  }
  if (!angles.length) best = 0;
  const id = nextArmId();
  remember();
  editor.cfg.arms.push(newArm(id, Math.round(angleDeg(best)), editor.cfg.arms.length));
  reconcile(editor.cfg);
  toast(`Добавлен подход ${id}. Направления и переходы для него можно достроить кнопками ниже.`);
}

function deleteArm(id: string) {
  if (editor.cfg.arms.length <= 2) { toast('Нужно хотя бы два подхода'); return; }
  remember();
  editor.cfg.arms = editor.cfg.arms.filter((a) => a.id !== id);
  reconcile(editor.cfg);
  const gone = new Set(editor.cfg.signals.groups.filter((g) => g.arm === id || (g.kind !== 'pedestrian' && g.movements.length === 0 && !editor.cfg.arms.some((a) => a.id === g.arm))).map((g) => g.id));
  editor.cfg.signals.groups = editor.cfg.signals.groups.filter((g) => !gone.has(g.id) || g.movements.length > 0);
  const ids = new Set(editor.cfg.signals.groups.map((g) => g.id));
  for (const p of editor.cfg.signals.phases) p.green = p.green.filter((g) => ids.has(g));
  editor.selected = null;
}

function genAllConnections() {
  remember();
  editor.cfg.connections = genConnections(editor.cfg.arms);
  reconcile(editor.cfg);
  for (const a of editor.cfg.arms) {
    const ch = editor.cfg.laneChoosers[a.id];
    if (ch && !ch.manual) {
      ch.params.weights = {};
      for (const c of editor.cfg.connections) if (c.from.arm === a.id) (ch.params.weights[c.to.arm] ??= Array(a.inLanes).fill(0))[c.from.lane] = 1;
    }
  }
  toast('Направления построены по типовой схеме. Светофоры могут ссылаться на старые направления: при необходимости пересоберите программу.');
}
function genPeds() {
  remember();
  editor.cfg.peds = genPedGraph(editor.cfg.arms);
  reconcile(editor.cfg);
  toast('Пешеходный граф построен заново: углы, островки, переходы, источники по 60 чел/ч.');
}
function genProgram() {
  remember();
  editor.cfg.signals = genSignals(editor.cfg.arms, editor.cfg.connections, editor.cfg.peds);
  toast('Светофорная программа собрана: фазы по встречным парам подходов и единая пешеходная фаза.');
}
function genEverything() {
  remember();
  editor.cfg.connections = genConnections(editor.cfg.arms);
  editor.cfg.peds = genPedGraph(editor.cfg.arms);
  editor.cfg.signals = genSignals(editor.cfg.arms, editor.cfg.connections, editor.cfg.peds);
  editor.cfg.spawners = {};
  editor.cfg.laneChoosers = {};
  editor.cfg.exits = {};
  Object.assign(editor.cfg, genNodes(editor.cfg));
  reconcile(editor.cfg);
  toast('Модель достроена по подходам');
}
function tidy() {
  reconcile(editor.cfg);
  toast('Ссылки проверены, недостающие узлы созданы');
}

function exportModel() {
  download(`${fileBase()}.crossroad.json`, serializeModel(editor.cfg));
}
function importModel(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try { checkFileSize(f.size); } catch (err) { toast(humanFileError(err)); (e.target as HTMLInputElement).value = ''; return; }
  f.text().then(async (t) => {
    try {
      const cfg = await vetCustomCode(normalizeModel(JSON.parse(t)));
      if (!cfg) return;
      remember();
      loadModel(cfg, `Загружена модель «${cfg.name}»`);
    } catch (err) {
      toast(humanFileError(err));
    }
  });
  (e.target as HTMLInputElement).value = '';
}
function openJson() {
  jsonText.value = serializeModel(editor.cfg);
  jsonErr.value = '';
  showJson.value = !showJson.value;
}
async function applyJson() {
  try {
    checkFileSize(jsonText.value.length);
    const cfg = await vetCustomCode(normalizeModel(JSON.parse(jsonText.value)));
    if (!cfg) return;
    remember();
    loadModel(cfg, 'Изменения модели применены');
    jsonErr.value = '';
  } catch (err) {
    jsonErr.value = humanFileError(err);
  }
}
async function copyJson() {
  try { await navigator.clipboard.writeText(serializeModel(editor.cfg)); toast('Текст модели скопирован'); } catch { toast('Буфер обмена недоступен'); }
}
const counts = computed(() => ({
  arms: editor.cfg.arms.length,
  conns: editor.cfg.connections.length,
  nodes: editor.cfg.peds.nodes.length,
  edges: editor.cfg.peds.edges.length,
  groups: editor.cfg.signals.groups.length,
  phases: editor.cfg.signals.phases.length,
}));
</script>

<template>
  <div class="schema-panel">
    <template v-if="props.part === 'schema'">
      <section>
        <h3>Модель</h3>
        <div class="grid2">
          <label>Название <input v-model="editor.cfg.name" /></label>
          <label>Описание <input v-model="editor.cfg.description" /></label>
        </div>
        <div class="small muted">Подходов {{ counts.arms }}, направлений {{ counts.conns }}, пешеходных узлов {{ counts.nodes }} и переходов {{ counts.edges }}, сигнальных групп {{ counts.groups }}, фаз {{ counts.phases }}.</div>
      </section>

      <section>
        <h3>Шаблоны</h3>
        <div class="templates">
          <div v-for="t in TEMPLATES" :key="t.id" class="template-card">
            <b>{{ t.name }}</b>
            <span class="small muted">{{ t.description }}</span>
            <button class="btn small" @click="useTemplate(t.id)">Открыть</button>
          </div>
        </div>
        <div v-if="undo" class="row gap small"><span class="muted">Модель заменена.</span><button class="btn small" @click="doUndo">Вернуть предыдущую</button></div>
      </section>

      <section>
        <div class="row between wrap gap">
          <h3>Подходы</h3>
          <button class="btn small primary" @click="addArm">+ подход</button>
        </div>
        <div class="table-scroll">
          <table class="tbl arm-table">
            <thead>
              <tr>
                <th>Код</th><th>Название</th><th>Сторона</th><th>Угол, °</th><th>Полос к / от</th><th>Ширина полосы</th><th>Разделитель</th>
                <th>Переход от центра</th><th>Переход</th><th>Островок</th><th>км/ч</th><th>Подход / выезд, м</th><th>Цвет</th><th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in editor.cfg.arms" :key="a.id">
                <td><b>{{ a.id }}</b></td>
                <td><input v-model="a.name" /></td>
                <td><input v-model="a.short" class="narrow" :placeholder="sideName(a.angle)" /></td>
                <td><input v-model.number="a.angle" type="number" step="1" class="narrow" /></td>
                <td class="row gap">
                  <input :value="a.inLanes" type="number" min="0" max="8" class="narrow" @change="a.inLanes = Math.max(0, Math.min(8, Math.round(+($event.target as HTMLInputElement).value))); reconcile(editor.cfg)" />
                  <input :value="a.outLanes" type="number" min="0" max="8" class="narrow" @change="a.outLanes = Math.max(0, Math.min(8, Math.round(+($event.target as HTMLInputElement).value))); reconcile(editor.cfg)" />
                </td>
                <td><input v-model.number="a.laneWidth" type="number" min="2.5" max="6" step="0.05" class="narrow" /></td>
                <td><input v-model.number="a.medianWidth" type="number" min="0" max="20" step="0.5" class="narrow" /></td>
                <td><input v-model.number="a.crosswalkOffset" type="number" min="5" max="80" step="0.5" class="narrow" /></td>
                <td><input v-model="a.hasCrosswalk" type="checkbox" /></td>
                <td><input v-model="a.refuge" type="checkbox" /></td>
                <td><input v-model.number="a.speedLimit" type="number" min="10" max="110" step="5" class="narrow" /></td>
                <td class="row gap">
                  <input v-model.number="a.approachLength" type="number" min="30" step="5" class="narrow" />
                  <input v-model.number="a.exitLength" type="number" min="20" step="5" class="narrow" />
                </td>
                <td><input v-model="a.color" type="color" /></td>
                <td><button class="btn tiny danger" title="Удалить подход" @click="deleteArm(a.id)">✕</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="small muted">Угол — направление дороги от центра наружу: 0° — восток, 90° — север, 180° — запад, 270° — юг. Полосы нумеруются от оси дороги к бордюру, начиная с нуля. Остальные параметры подхода — на панели «Элемент» после нажатия на подход на карте.</div>
      </section>

      <section>
        <h3>Достроить автоматически</h3>
        <div class="row wrap gap">
          <button class="btn" @click="genAllConnections">Направления по полосам</button>
          <button class="btn" @click="genPeds">Пешеходный граф</button>
          <button class="btn" @click="genProgram">Светофорную программу</button>
          <button class="btn primary" @click="genEverything">Всё по подходам</button>
          <button class="btn" @click="tidy">Проверить ссылки</button>
        </div>
        <div class="small muted">
          Направления: левые повороты из левых полос, правые из правых, прямо из средних. Пешеходный граф: углы между соседними подходами, островки на разделителях с отметкой «островок», переходы через каждый подход.
          Программа: встречные пары подходов в отдельных фазах и единая пешеходная фаза. После генерации всё можно поправить вручную, на карте и в редакторе фаз.
        </div>
      </section>

    </template>
    <template v-else>
      <section>
        <h3>Файл модели</h3>
        <div class="row wrap gap">
          <button class="btn primary" @click="exportModel">Скачать модель</button>
          <button class="btn" @click="fileInput?.click()">Загрузить модель</button>
          <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="importModel" />
          <button class="btn" @click="copyJson">Копировать текст</button>
          <button class="btn" @click="openJson">{{ showJson ? 'Скрыть текст' : 'Править текст' }}</button>
          <button class="btn" @click="download('crossroad-model.schema.json', schemaText)">Схема формата файла</button>
          <button class="btn" @click="download('model-format.md', docText, 'text/markdown')">Описание формата</button>
        </div>
        <div class="small muted">Файл содержит модель в текстовом формате. Сохранения первой версии с четырьмя подходами открываются и преобразуются автоматически.</div>
        <template v-if="showJson">
          <textarea v-model="jsonText" class="json-box" spellcheck="false" />
          <div class="row gap">
            <button class="btn small primary" @click="applyJson">Применить изменения</button>
            <span v-if="jsonErr" class="small bad">{{ jsonErr }}</span>
          </div>
        </template>
      </section>
    </template>
  </div>
</template>
