<script setup lang="ts">
// Визуальный редактор светофорного регулирования: предустановки, сигнальные группы, то есть светофоры и допсекции,
// фазы (карточки с пиктограммами), промтакты, ленточный график цикла, режим «код».
import { computed, ref, watch } from 'vue';
import { app, loadModel, loadPresetPart, presetsApplicable, regenController, resetGraph, simRef, toast } from './store';
import { editor, useCtx, type Ctx } from './ctx';
import PhasePicto from './PhasePicto.vue';
import NodeCode from './NodeCode.vue';
import { PRESETS } from '../engine/presets';
import { pedEdgesAcross } from '../engine/generate';
import { buildTimeline, cycleLength, groupBands, type Lamp } from '../engine/signals';
import { onSlowTick } from './loop';
import type { ArmId, GroupKind } from '../engine/types';

const props = defineProps<{ ctx?: Ctx }>();
const C = useCtx(() => props.ctx);
const cfg = C.cfg;
const sig = computed(() => cfg.value.signals);
const presetSel = ref(app.presetId);
const preset = computed(() => PRESETS.find((p) => p.id === presetSel.value));
const cycle = computed(() => cycleLength(sig.value));
const tl = computed(() => buildTimeline(sig.value));
const bands = computed(() => sig.value.groups.map((g) => ({ g, bands: groupBands(sig.value, g) })));
const cursor = ref(0);
const curPhase = ref(-1);

onSlowTick(() => {
  const sim = simRef.value;
  if (!sim || C.isEditor.value) { curPhase.value = -1; return; }
  curPhase.value = sim.st.sig.phaseIdx;
  // позиция в цикле — по фактическому времени текущего сегмента
  const seg = tl.value.segs.find((s) => s.phaseIdx === sim.st.sig.phaseIdx && s.kind === sim.st.sig.segment);
  cursor.value = seg ? seg.start + (sim.st.t - sim.st.sig.segStart) : 0;
});

watch(() => app.presetId, (v) => { presetSel.value = v; });

const LAMP_CLASS: Record<Lamp, string> = { G: 'g', FG: 'fg', Y: 'y', RY: 'ry', R: 'r', OFF: 'off' };

function setDur(i: number, v: number) {
  sig.value.phases[i].duration = Math.max(1, Math.min(300, Math.round(v || 1)));
}
function toggle(i: number, gid: string) {
  const ph = sig.value.phases[i];
  ph.green = ph.green.includes(gid) ? ph.green.filter((x) => x !== gid) : [...ph.green, gid];
}
function move(i: number, d: number) {
  const a = sig.value.phases;
  const j = i + d;
  if (j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]];
}
function dup(i: number) {
  const p = JSON.parse(JSON.stringify(sig.value.phases[i]));
  p.id = `${p.id}-${Date.now() % 10000}`;
  p.name = p.name + ', копия';
  sig.value.phases.splice(i + 1, 0, p);
}
function del(i: number) {
  if (sig.value.phases.length <= 1) return;
  sig.value.phases.splice(i, 1);
}
function addPhase() {
  sig.value.phases.push({ id: `ph${Date.now() % 100000}`, name: `Фаза ${sig.value.phases.length + 1}`, duration: 15, green: [] });
}
const newGroupKind = ref<GroupKind>('vehicle');
const newGroupArm = ref<ArmId>(cfg.value.arms[0]?.id ?? '');
watch(() => cfg.value.arms.map((a) => a.id).join(), () => { if (!cfg.value.arms.some((a) => a.id === newGroupArm.value)) newGroupArm.value = cfg.value.arms[0]?.id ?? ''; });
const armShort = (id: ArmId) => cfg.value.arms.find((a) => a.id === id)?.short ?? id;
const canPreset = computed(() => { void app.version; return presetsApplicable(cfg.value); });
function addGroup() {
  const id = `${newGroupKind.value === 'arrow' ? 'A' : newGroupKind.value === 'pedestrian' ? 'P' : 'G'}${newGroupArm.value}${Date.now() % 1000}`;
  const nm = armShort(newGroupArm.value);
  const name = newGroupKind.value === 'arrow' ? `Допсекция, ${nm}` : newGroupKind.value === 'pedestrian' ? `Пешеходы через ${nm}` : `Светофор, ${nm}`;
  // пешеходной группе сразу назначаем переходы через этот подход
  const movements = newGroupKind.value === 'pedestrian' ? pedEdgesAcross(cfg.value, newGroupArm.value) : [];
  sig.value.groups.push({ id, name, kind: newGroupKind.value, arm: newGroupArm.value, movements, color: newGroupKind.value === 'pedestrian' ? '#9aa3b2' : '#' + Math.floor(0x404040 + Math.random() * 0xa0a0a0).toString(16).padStart(6, '0') });
  C.select({ kind: 'group', id });
}
function loadPart(part: 'all' | 'signals' | 'markings') {
  const r = loadPresetPart(presetSel.value, part, cfg.value);
  if (!r) return;
  if (part === 'all') {
    if (C.isEditor.value) { editor.cfg = r; editor.dirty = true; editor.version++; toast('Модель загружена в редактор'); }
    else { app.presetId = presetSel.value; loadModel(r, 'Модель загружена полностью'); }
    return;
  }
  if (part === 'signals' && !C.isEditor.value) app.presetId = presetSel.value;
  if (C.isEditor.value) { editor.dirty = true; editor.version++; }
  toast(part === 'signals' ? 'Загружена только светофорная программа' : 'Загружена только разметка: направления полос и пешеходный граф');
}
function doResetGraph() {
  resetGraph(cfg.value);
  if (C.isEditor.value) { editor.dirty = true; editor.version++; }
  toast('Граф возвращён к исходному виду');
}
function applyControllerCode(code: string) {
  sig.value.code = code;
}
watch(() => sig.value.phases.map((p) => p.name + p.duration).join(), () => { if (sig.value.controller === 'fixed') regenController(cfg.value); });
const pct = (x: number) => `${(x / Math.max(1, tl.value.cycle)) * 100}%`;
</script>

<template>
  <div class="phase-editor">
    <template v-if="canPreset">
      <label class="grow">Предустановка
        <select v-model="presetSel">
          <option v-for="p in PRESETS" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <div v-if="preset" class="small muted preset-desc">{{ preset.description }}</div>
      <div class="row wrap gap">
        <button class="btn primary small" @click="loadPart('signals')">Загрузить светофоры</button>
        <button class="btn small" @click="loadPart('markings')">Загрузить разметку</button>
        <button class="btn small" @click="loadPart('all')">Загрузить всё</button>
      </div>
    </template>
    <div v-else class="small muted preset-desc">Предустановки рассчитаны на перекрёсток Оборонная / Тверская. Для этой схемы программу можно собрать здесь или достроить автоматически во вкладке «Редактор».</div>
    <div class="row wrap gap"><button class="btn small" title="Разрешённые направления и пешеходный граф — как в исходной модели или по типовой схеме" @click="doResetGraph">Сбросить граф к исходному</button></div>

    <h4>Сигнальные группы</h4>
    <div class="groups">
      <button v-for="g in sig.groups" :key="g.id" class="group-chip" :class="{ sel: app.selected?.kind === 'group' && app.selected.id === g.id }" @click="app.selected = { kind: 'group', id: g.id }">
        <span class="chip" :style="{ background: g.color }" />{{ g.name }}
        <span class="muted small">{{ g.kind === 'arrow' ? (g.side === 'left' ? '◀' : '▶') : g.kind === 'pedestrian' ? '🚶' : '●' }}</span>
      </button>
    </div>
    <div class="row wrap gap small">
      <select v-model="newGroupKind"><option value="vehicle">основной светофор</option><option value="pedestrian">пешеходный светофор</option></select>
      <select v-model="newGroupArm"><option v-for="a in cfg.arms" :key="a.id" :value="a.id">{{ a.short }} [{{ a.id }}]</option></select>
      <button class="btn small" @click="addGroup">+ светофор</button>
    </div>
    <div class="small muted">Допсекции со стрелками добавляются к основному светофору: нажмите на него и выберите «+ секция слева» или «+ секция справа».</div>

    <h4>Фазы <span class="muted small">— цикл {{ cycle }} с. Нажмите на группу в карточке, чтобы включить ей зелёный в этой фазе</span></h4>
    <div class="phases">
      <div v-for="(ph, i) in sig.phases" :key="ph.id" class="phase-card" :class="{ cur: curPhase === i }">
        <div class="row between">
          <input v-model="ph.name" class="phase-name" />
        </div>
        <PhasePicto :phase-idx="i" :size="104" :ctx="ctx" />
        <div class="dur row">
          <button class="btn small" @click="setDur(i, ph.duration - 1)">−</button>
          <input :value="ph.duration" type="number" min="1" step="1" @change="setDur(i, +($event.target as HTMLInputElement).value)" />
          <span class="small">с</span>
          <button class="btn small" @click="setDur(i, ph.duration + 1)">+</button>
        </div>
        <div class="phase-groups">
          <button v-for="g in sig.groups" :key="g.id" class="mini-chip" :class="{ on: ph.green.includes(g.id) }" :style="{ '--c': g.color }" :title="g.name" @click="toggle(i, g.id)">{{ g.id }}</button>
        </div>
        <div class="row between phase-actions">
          <button class="btn tiny" title="Раньше" @click="move(i, -1)">◀</button>
          <button class="btn tiny" title="Копия" @click="dup(i)">⧉</button>
          <button class="btn tiny" title="Удалить" @click="del(i)">✕</button>
          <button class="btn tiny" title="Позже" @click="move(i, 1)">▶</button>
        </div>
      </div>
      <button class="phase-add" @click="addPhase">+ фаза</button>
    </div>

    <h4>Ленточный график цикла</h4>
    <div class="timeline">
      <div class="tl-head">
        <div v-for="(s, i) in tl.segs" :key="i" class="tl-seg" :class="s.kind" :style="{ left: pct(s.start), width: pct(s.end - s.start) }" :title="sig.phases[s.phaseIdx]?.name">
          {{ s.kind === 'main' ? sig.phases[s.phaseIdx]?.name.split(':')[0] : '' }}
        </div>
      </div>
      <div v-for="row in bands" :key="row.g.id" class="tl-row">
        <div class="tl-label"><span class="chip" :style="{ background: row.g.color }" />{{ row.g.id }}</div>
        <div class="tl-track">
          <div v-for="(b, j) in row.bands" :key="j" class="tl-band" :class="LAMP_CLASS[b.lamp]" :style="{ left: pct(b.from), width: pct(b.to - b.from) }" :title="`${b.lamp} ${b.from.toFixed(0)}–${b.to.toFixed(0)} с`" />
          <div class="tl-cursor" :style="{ left: pct(cursor) }" />
        </div>
      </div>
      <div class="tl-scale small muted"><span>0</span><span>{{ (tl.cycle / 2).toFixed(0) }} с</span><span>{{ tl.cycle }} с</span></div>
    </div>

    <details class="sub">
      <summary>Промтакт и сигналы перехода</summary>
      <div class="grid3">
        <label>Жёлтый, с <input v-model.number="sig.timing.yellow" type="number" min="0" max="6" step="1" /></label>
        <label>Красный с жёлтым, с <input v-model.number="sig.timing.redYellow" type="number" min="0" max="4" step="1" /></label>
        <label>Мигание зелёного, с <input v-model.number="sig.timing.flashGreen" type="number" min="0" max="6" step="1" /></label>
        <label>Все красные, с <input v-model.number="sig.timing.allRed" type="number" min="0" max="10" step="1" /></label>
        <label>Пешеходный промтакт, с <input v-model.number="sig.timing.pedClearance" type="number" min="0" max="10" step="1" /></label>
        <label>Сдвиг цикла, с <input v-model.number="sig.offset" type="number" min="0" step="1" /></label>
      </div>
    </details>
    <details class="sub">
      <summary>Адаптивное управление кодом</summary>
      <label class="check"><input type="radio" value="fixed" v-model="sig.controller" /> Жёсткая программа, фазы по кругу</label>
      <label class="check"><input type="radio" value="code" v-model="sig.controller" /> Пользовательский код смены фаз</label>
      <NodeCode :code="sig.code" :manual="sig.controller === 'code'" fn-name="nextPhase" @apply="applyControllerCode" @regen="regenController(cfg)" />
    </details>
  </div>
</template>
