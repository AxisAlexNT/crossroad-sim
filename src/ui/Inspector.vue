<script setup lang="ts">
// Инспектор выбранного элемента: узлы с параметрами и кодом, дорога, связь, сигнальная группа, машина,
// узел и ребро пешеходного графа, группа пешеходов.
import { computed, watch } from 'vue';
import { app, regenNode, simRef } from './store';
import { useCtx, type Ctx } from './ctx';
import NodeCode from './NodeCode.vue';
import type { ArmId, ArrivalModel, BusRoute, BusStop, PedSource, SignalGroup, VehicleKind } from '../engine/types';
import { turnKindByAngle } from '../engine/network';
import { seedRng, rngNext } from '../engine/rng';
import type { SandboxNode } from '../engine/sandbox';
import { PED_COLOR, PED_GROUPS_DEFAULT, reconcile } from '../engine/generate';

const props = defineProps<{ ctx?: Ctx }>();
const C = useCtx(() => props.ctx);
const cfg = C.cfg;
const sel = C.selected;
const live = computed(() => !C.isEditor.value);
const armName = (id: ArmId) => cfg.value.arms.find((a) => a.id === id)?.short ?? id;
const KIND = { straight: 'прямо', left: 'налево', right: 'направо', uturn: 'разворот' } as const;
const VK: Record<VehicleKind, string> = { car: 'легковая', van: 'фургон', truck: 'грузовая', bus: 'автобус' };
const WHY: Record<string, string> = {
  free: 'едет свободно', leader: 'держит дистанцию до машины впереди', merge: 'ждёт машину впереди на своём пути', signal: 'стоит на запрещающий сигнал',
  yield: 'уступает дорогу', ped: 'пропускает пешеходов', crash: 'впереди столкнувшиеся машины', exit: 'выезд занят', lc: 'ждёт возможности перестроиться',
  bus: 'автобус на остановке', curve: 'снижает скорость на повороте', stop: 'останавливается',
};

const arms = computed(() => cfg.value.arms);
const armIdsList = computed(() => cfg.value.arms.map((a) => a.id));
const arm = computed<ArmId | null>(() => (sel.value && 'arm' in sel.value ? sel.value.arm : null));
const armCfg = computed(() => (arm.value ? cfg.value.arms.find((a) => a.id === arm.value) ?? null : null));
const spawner = computed(() => (arm.value ? cfg.value.spawners[arm.value] ?? null : null));
const chooser = computed(() => (arm.value ? cfg.value.laneChoosers[arm.value] ?? null : null));
const exitNode = computed(() => (arm.value ? cfg.value.exits[arm.value] ?? null : null));
const net = C.net;

watch(() => (spawner.value ? JSON.stringify(spawner.value.params) : ''), () => { if (arm.value) regenNode('spawner', arm.value, false, cfg.value); });
watch(() => (chooser.value && armCfg.value ? JSON.stringify(chooser.value.params) + armCfg.value.inLanes : ''), () => { if (arm.value) regenNode('lanes', arm.value, false, cfg.value); });
watch(() => (exitNode.value ? JSON.stringify(exitNode.value.params) : ''), () => { if (arm.value) regenNode('exit', arm.value, false, cfg.value); });

const destTotal = computed(() => Object.values(spawner.value?.params.destinations ?? {}).reduce((a, b) => a + (b ?? 0), 0));

function reachable(d: ArmId, lane: number): ArmId[] {
  return net.value?.reachable[d]?.[lane] ?? [];
}

function setLanes(field: 'inLanes' | 'outLanes', n: number) {
  const a = armCfg.value;
  if (!a) return;
  a[field] = Math.max(0, Math.min(8, Math.round(n)));
  reconcile(cfg.value);
}

// --- связь ---
const connSel = computed(() => (sel.value?.kind === 'conn' ? cfg.value.connections.find((c) => c.id === (sel.value as { id: string }).id) ?? null : null));
const connGroups = computed(() => cfg.value.signals.groups.filter((g) => g.kind !== 'pedestrian'));
function toggleIn(gid: string, id: string, on: boolean) {
  const g = cfg.value.signals.groups.find((x) => x.id === gid);
  if (!g) return;
  if (on && !g.movements.includes(id)) g.movements.push(id);
  if (!on) g.movements = g.movements.filter((m) => m !== id);
}
function deleteConn() {
  const c = connSel.value;
  if (!c) return;
  cfg.value.connections = cfg.value.connections.filter((x) => x.id !== c.id);
  for (const g of cfg.value.signals.groups) g.movements = g.movements.filter((m) => m !== c.id);
  C.select(null);
}
function connLabel(id: string) {
  const c = cfg.value.connections.find((x) => x.id === id);
  if (!c) return id;
  const a = arms.value.find((x) => x.id === c.from.arm), b = arms.value.find((x) => x.id === c.to.arm);
  const k = a && b ? KIND[turnKindByAngle(a, b)] : '?';
  return `${armName(c.from.arm)} ${c.from.lane} → ${armName(c.to.arm)} ${c.to.lane}, ${k}`;
}

// --- пешеходный граф ---
const nodeLabel = (id: string) => cfg.value.peds.nodes.find((n) => n.id === id)?.label ?? id;
const pedNode = computed(() => (sel.value?.kind === 'pednode' ? cfg.value.peds.nodes.find((n) => n.id === (sel.value as { id: string }).id) ?? null : null));
const pedSource = computed(() => (pedNode.value ? cfg.value.peds.sources.find((s) => s.node === pedNode.value!.id) ?? null : null));
const otherNodes = computed(() => cfg.value.peds.nodes.filter((n) => n.id !== pedNode.value?.id));
const pedNodeEdges = computed(() => (pedNode.value ? cfg.value.peds.edges.filter((e) => e.from === pedNode.value!.id || e.to === pedNode.value!.id) : []));
function addSource() {
  const n = pedNode.value;
  if (!n) return;
  const corners = cfg.value.peds.nodes.filter((x) => x.id !== n.id && x.kind !== 'island');
  const s: PedSource = { node: n.id, rate: 40, groups: PED_GROUPS_DEFAULT.map((g) => ({ ...g })), speedMin: 1.0, speedMax: 1.6, destinations: Object.fromEntries(corners.map((c) => [c.id, 1])) };
  cfg.value.peds.sources.push(s);
}
function removeSource() {
  const n = pedNode.value;
  if (!n) return;
  cfg.value.peds.sources = cfg.value.peds.sources.filter((s) => s.node !== n.id);
}
function deletePedNode() {
  const n = pedNode.value;
  if (!n) return;
  cfg.value.peds.nodes = cfg.value.peds.nodes.filter((x) => x.id !== n.id);
  reconcile(cfg.value);
  C.select(null);
}
const pedSum = computed(() => Object.values(pedSource.value?.destinations ?? {}).reduce((a, b) => a + (b ?? 0), 0));

const pedEdge = computed(() => (sel.value?.kind === 'pededge' ? cfg.value.peds.edges.find((e) => e.id === (sel.value as { id: string }).id) ?? null : null));
const pedEdgeGeom = computed(() => {
  const e = pedEdge.value, n = net.value;
  if (!e || !n) return null;
  const i = n.pedEdgeById.get(e.id);
  return i === undefined ? null : n.pedEdges[i];
});
const pedGroups = computed(() => cfg.value.signals.groups.filter((g) => g.kind === 'pedestrian'));
function deletePedEdge() {
  const e = pedEdge.value;
  if (!e) return;
  cfg.value.peds.edges = cfg.value.peds.edges.filter((x) => x.id !== e.id);
  reconcile(cfg.value);
  C.select(null);
}
function newPedGroupFor() {
  const e = pedEdge.value;
  if (!e) return;
  let k = 1;
  while (cfg.value.signals.groups.some((g) => g.id === `PX${k}`)) k++;
  const id = `PX${k}`;
  const g = { id, name: `Пешеходы: ${nodeLabel(e.from)} — ${nodeLabel(e.to)}`, kind: 'pedestrian' as const, arm: cfg.value.arms[0].id, movements: [e.id], color: PED_COLOR };
  cfg.value.signals.groups.push(g);
  C.select({ kind: 'group', id });
}
const KIND_EDGE = { cross: 'переход поперёк дороги', half: 'половина перехода до островка', free: 'диагональный или через перекрёсток' } as const;

// --- остановки и маршруты ---
const stopSel = computed<BusStop | null>(() => (sel.value?.kind === 'stop' ? cfg.value.transit.stops.find((x) => x.id === (sel.value as { id: string }).id) ?? null : null));
const routeSel = computed<BusRoute | null>(() => (sel.value?.kind === 'route' ? cfg.value.transit.routes.find((x) => x.id === (sel.value as { id: string }).id) ?? null : null));
const routesOfStop = computed(() => (stopSel.value ? cfg.value.transit.routes.filter((r) => r.stops.includes(stopSel.value!.id)) : []));
function deleteStop() {
  const s0 = stopSel.value;
  if (!s0) return;
  cfg.value.transit.stops = cfg.value.transit.stops.filter((x) => x.id !== s0.id);
  for (const r of cfg.value.transit.routes) r.stops = r.stops.filter((x) => x !== s0.id);
  C.select(null);
}
function deleteRoute() {
  const r = routeSel.value;
  if (!r) return;
  cfg.value.transit.routes = cfg.value.transit.routes.filter((x) => x.id !== r.id);
  C.select(null);
}
function toggleRouteStop(id: string, on: boolean) {
  const r = routeSel.value;
  if (!r) return;
  if (on && !r.stops.includes(id)) r.stops.push(id);
  if (!on) r.stops = r.stops.filter((x) => x !== id);
}

// --- группа ---
const groupSel = computed(() => (sel.value?.kind === 'group' ? cfg.value.signals.groups.find((g) => g.id === (sel.value as { id: string }).id) ?? null : null));
function deleteGroup() {
  const g = groupSel.value;
  if (!g) return;
  cfg.value.signals.groups = cfg.value.signals.groups.filter((x) => x.id !== g.id);
  for (const p of cfg.value.signals.phases) p.green = p.green.filter((x) => x !== g.id);
  C.select(null);
}
const KIND_NAMES = { vehicle: 'Основной светофор', arrow: 'Дополнительная секция со стрелкой', pedestrian: 'Пешеходный светофор' } as const;
const vehicleHeads = computed(() => cfg.value.signals.groups.filter((g) => g.kind === 'vehicle'));
const sectionsOf = (id: string) => cfg.value.signals.groups.filter((g) => g.kind === 'arrow' && g.parent === id);
const parentOf = computed(() => (groupSel.value?.parent ? cfg.value.signals.groups.find((g) => g.id === groupSel.value!.parent) ?? null : null));
/** Добавить допсекцию к основному светофору, не трогая сам светофор */
function addSection(side: 'left' | 'right') {
  const g = groupSel.value;
  if (!g || g.kind !== 'vehicle') return;
  let k = 1;
  while (cfg.value.signals.groups.some((x) => x.id === `${g.id}${side === 'left' ? 'l' : 'r'}${k > 1 ? k : ''}`)) k++;
  const id = `${g.id}${side === 'left' ? 'l' : 'r'}${k > 1 ? k : ''}`;
  // по умолчанию — повороты в эту сторону из этого светофора
  const n = net.value;
  const movements = n ? g.movements.filter((m) => { const ci = n.connById.get(m); if (ci === undefined) return false; const kind = n.conns[ci].kind; return side === 'left' ? kind === 'left' || kind === 'uturn' : kind === 'right'; }) : [];
  const sec: SignalGroup = { id, name: `Допсекция ${side === 'left' ? 'налево' : 'направо'}: ${g.name}`, kind: 'arrow', arm: g.arm, movements, color: side === 'left' ? '#ff6b8b' : '#b23a51', parent: g.id, side };
  cfg.value.signals.groups.push(sec);
  C.select({ kind: 'group', id });
}
function edgeLabel(id: string) {
  const e = cfg.value.peds.edges.find((x) => x.id === id);
  return e ? `${nodeLabel(e.from)} — ${nodeLabel(e.to)}` : id;
}

// --- машина и пешеходы ---
const veh = computed(() => {
  void app.statTick;
  if (sel.value?.kind !== 'vehicle') return null;
  const id = sel.value.id;
  return simRef.value?.st.vehicles.find((v) => v.id === id) ?? null;
});
const vehLog = computed(() => {
  void app.logTick;
  if (sel.value?.kind !== 'vehicle') return [];
  const id = sel.value.id;
  return (simRef.value?.log ?? []).filter((e) => e.vid === id).slice(-8);
});
const pedAgent = computed(() => {
  void app.statTick;
  if (sel.value?.kind !== 'ped') return null;
  const id = sel.value.id;
  return simRef.value?.st.peds.find((p) => p.id === id) ?? null;
});

// --- тесты для кода: вызовы идут в песочницу, как в симуляции ---
function testSpawn(node: SandboxNode): string | null {
  const st = seedRng(1);
  const rand = () => rngNext(st);
  const memory = {};
  for (let i = 0; i < 300; i++) {
    const out = node.call('spawn', [], 0, { t: i * 0.1, dt: 0.1, arm: arm.value, memory }, rand);
    if (!Array.isArray(out)) return 'spawn() должна вернуть массив машин, пустой тоже подходит';
    for (const v of out as Array<{ destination: string; length: number; kind: string }>) {
      if (!armIdsList.value.includes(v.destination)) return `Неизвестный подход выезда: ${v.destination}. Есть: ${armIdsList.value.join(', ')}`;
      if (!(v.length > 0)) return 'У машины должна быть положительная длина';
    }
  }
  return null;
}
function testChooser(node: SandboxNode): string | null {
  const d = arm.value!;
  const st = seedRng(2);
  const lanes = Array.from({ length: armCfg.value?.inLanes ?? 1 }, (_, i) => ({ index: i, reachable: reachable(d, i), vehicles: 0, queue: 0 }));
  for (const dest of armIdsList.value) {
    const r = node.call('chooseLane', [{ id: 1, kind: 'car', length: 4.5, destination: dest, lane: 0 }], 1, { t: 0, arm: d, lanes, memory: {} }, () => rngNext(st));
    if (!Number.isInteger(r)) return `chooseLane() должна вернуть целый номер полосы, получено: ${String(r)}`;
  }
  return null;
}
function testExit(node: SandboxNode): string | null {
  const r = node.call('canExit', [], 0, { t: 0, dt: 0.1, arm: arm.value, lane: 0, memory: {} }, () => 0.5);
  return typeof r === 'boolean' ? null : 'canExit() должна вернуть true или false';
}

function applyCode(kind: 'spawner' | 'lanes' | 'exit', code: string) {
  const d = arm.value!;
  const node = kind === 'spawner' ? cfg.value.spawners[d] : kind === 'lanes' ? cfg.value.laneChoosers[d] : cfg.value.exits[d];
  node.code = code;
  node.manual = true;
}

function addProfile() {
  spawner.value?.params.profile.push({ from: (spawner.value.params.profile[spawner.value.params.profile.length - 1]?.from ?? 0) + 600, rate: spawner.value.params.rate });
}
function addType() {
  spawner.value?.params.types.push({ kind: 'van', share: 0.05, lengthMin: 5.5, lengthMax: 6.5 });
}
const arrivals: Array<[ArrivalModel, string]> = [['poisson', 'Пуассоновский, случайные интервалы'], ['uniform', 'Равномерный'], ['platoon', 'Пачками']];
function setWeight(dest: ArmId, lane: number, v: number) {
  const ch = chooser.value, a = armCfg.value;
  if (!ch || !a) return;
  const arr = ch.params.weights[dest] ?? Array(a.inLanes).fill(0);
  arr[lane] = v;
  ch.params.weights[dest] = [...arr];
}
</script>

<template>
  <div class="inspector">
    <div v-if="!sel" class="muted small">
      Нажмите на узел на карте: <b>＋</b> — появление машин, <b>⇄</b> — точка перестроения, <b>→</b> — выезд, светофор — сигнальная группа.
      В режиме ✎ потяните от залитой вершины в конце полосы к вершине-контуру выезда, чтобы разрешить направление. Узлы ＋, ⇄ и → можно двигать вдоль дороги.
      В режиме 🚶 правится пешеходный граф: углы, островки, переходы и потоки пешеходов.
    </div>

    <!-- Появление машин -->
    <section v-if="sel?.kind === 'spawner' && spawner && armCfg">
      <h3>＋ Появление машин · {{ armCfg.name }}</h3>
      <div class="grid2">
        <label>Модель потока
          <select v-model="spawner.params.arrival"><option v-for="[v, l] in arrivals" :key="v" :value="v">{{ l }}</option></select>
        </label>
        <label>Интенсивность, авт/ч <input v-model.number="spawner.params.rate" type="number" min="0" step="10" /></label>
        <label v-if="spawner.params.arrival === 'platoon'">Машин в пачке <input v-model.number="spawner.params.platoonSize" type="number" min="1" max="20" /></label>
      </div>
      <details class="sub">
        <summary>Профиль интенсивности по времени, точек: {{ spawner.params.profile.length }}</summary>
        <div v-for="(r, i) in spawner.params.profile" :key="i" class="row gap">
          <label>с <input v-model.number="r.from" type="number" min="0" step="60" /></label>
          <label>авт/ч <input v-model.number="r.rate" type="number" min="0" step="10" /></label>
          <button class="btn small" @click="spawner.params.profile.splice(i, 1)">✕</button>
        </div>
        <button class="btn small" @click="addProfile">+ участок</button>
      </details>
      <h4>Доли направлений</h4>
      <div class="grid4">
        <label v-for="a in arms" :key="a.id">{{ a.short }} [{{ a.id }}]
          <input v-model.number="spawner.params.destinations[a.id]" type="number" min="0" max="1" step="0.05" />
        </label>
      </div>
      <div class="small muted">Сумма {{ destTotal.toFixed(2) }}, доли нормируются автоматически.</div>
      <h4>Типы машин</h4>
      <table class="tbl">
        <tr><th>Тип</th><th>Доля</th><th>Длина, м</th><th /></tr>
        <tr v-for="(t, i) in spawner.params.types" :key="i">
          <td><select v-model="t.kind"><option v-for="(l, k) in VK" :key="k" :value="k">{{ l }}</option></select></td>
          <td><input v-model.number="t.share" type="number" min="0" max="1" step="0.01" /></td>
          <td class="row gap"><input v-model.number="t.lengthMin" type="number" min="2" step="0.1" />–<input v-model.number="t.lengthMax" type="number" min="2" step="0.1" /></td>
          <td><button class="btn small" @click="spawner.params.types.splice(i, 1)">✕</button></td>
        </tr>
      </table>
      <button class="btn small" @click="addType">+ тип</button>
      <NodeCode :code="spawner.code" :manual="spawner.manual" fn-name="spawn" :test="testSpawn" @apply="applyCode('spawner', $event)" @regen="regenNode('spawner', arm!, true, cfg)" />
    </section>

    <!-- Перестроение -->
    <section v-if="sel?.kind === 'lanes' && chooser && armCfg && arm">
      <h3>⇄ Точка перестроения · {{ armCfg.name }}</h3>
      <div class="small muted">До точки разметка прерывистая и можно перестраиваться, после неё — сплошная. К этой точке машина уже должна быть в нужной полосе.</div>
      <div class="grid2">
        <label>Стратегия
          <select v-model="chooser.params.strategy"><option value="weights">по весам</option><option value="shortestQueue">где очередь короче</option></select>
        </label>
        <label>Уже в нужной полосе: {{ Math.round(chooser.params.preLaned * 100) }}%
          <input v-model.number="chooser.params.preLaned" type="range" min="0" max="1" step="0.05" />
        </label>
        <label>Сплошная перед стоп-линией, м <input v-model.number="armCfg.solidLength" type="number" min="5" :max="armCfg.approachLength - 10" step="1" /></label>
      </div>
      <h4>Веса полос для каждого направления</h4>
      <div class="table-scroll">
        <table class="tbl">
          <tr><th>Куда</th><th v-for="l in armCfg.inLanes" :key="l">полоса {{ l - 1 }}</th></tr>
          <tr v-for="a in arms" :key="a.id">
            <td>{{ a.short }}</td>
            <td v-for="l in armCfg.inLanes" :key="l" :class="{ invalid: (chooser.params.weights[a.id]?.[l - 1] ?? 0) > 0 && !reachable(arm, l - 1).includes(a.id), possible: reachable(arm, l - 1).includes(a.id) }">
              <input type="number" min="0" step="0.05" :value="chooser.params.weights[a.id]?.[l - 1] ?? 0" @change="setWeight(a.id, l - 1, +($event.target as HTMLInputElement).value)" />
            </td>
          </tr>
        </table>
      </div>
      <div class="small muted">Зелёные ячейки — из полосы можно проехать в это направление. Красные — вес задан, но проехать нельзя, такие машины будут ошибаться полосой.</div>
      <NodeCode :code="chooser.code" :manual="chooser.manual" fn-name="chooseLane" :test="testChooser" @apply="applyCode('lanes', $event)" @regen="regenNode('lanes', arm!, true, cfg)" />
    </section>

    <!-- Выезд -->
    <section v-if="sel?.kind === 'exit' && exitNode && armCfg">
      <h3>→ Выезд · {{ armCfg.name }}</h3>
      <div class="grid2">
        <label>Пропускная способность, авт/ч на полосу, 0 — без ограничений
          <input v-model.number="exitNode.params.capacityPerLane" type="number" min="0" step="50" />
        </label>
        <label>Длина выездного участка, м <input v-model.number="armCfg.exitLength" type="number" min="20" step="5" /></label>
      </div>
      <h4>Затор дальше по дороге, выезд закрыт</h4>
      <div v-for="(b, i) in exitNode.params.blocked" :key="i" class="row gap">
        <label>с <input v-model.number="b.from" type="number" min="0" step="10" /></label>
        <label>до <input v-model.number="b.to" type="number" min="0" step="10" /></label>
        <button class="btn small" @click="exitNode.params.blocked.splice(i, 1)">✕</button>
      </div>
      <button class="btn small" @click="exitNode.params.blocked.push({ from: 120, to: 240 })">+ интервал</button>
      <NodeCode :code="exitNode.code" :manual="exitNode.manual" fn-name="canExit" :test="testExit" @apply="applyCode('exit', $event)" @regen="regenNode('exit', arm!, true, cfg)" />
    </section>

    <!-- Дорога -->
    <section v-if="arm && armCfg && (sel?.kind === 'spawner' || sel?.kind === 'arm' || sel?.kind === 'lanes' || sel?.kind === 'exit')">
      <details class="sub" :open="sel?.kind === 'arm'">
        <summary>Параметры дороги «{{ armCfg.name }}»</summary>
        <div class="grid2">
          <label>Название <input v-model="armCfg.name" /></label>
          <label>Короткое название <input v-model="armCfg.short" /></label>
          <label>Направление в градусах, 0 — восток, 90 — север <input v-model.number="armCfg.angle" type="number" step="1" /></label>
          <label>Полос к перекрёстку <input :value="armCfg.inLanes" type="number" min="0" max="8" @change="setLanes('inLanes', +($event.target as HTMLInputElement).value)" /></label>
          <label>Полос от перекрёстка <input :value="armCfg.outLanes" type="number" min="0" max="8" @change="setLanes('outLanes', +($event.target as HTMLInputElement).value)" /></label>
          <label>Ширина полосы, м <input v-model.number="armCfg.laneWidth" type="number" min="2.5" max="6" step="0.05" /></label>
          <label>Разделитель, м <input v-model.number="armCfg.medianWidth" type="number" min="0" max="20" step="0.5" /></label>
          <label>От точки появления до стоп-линии, м <input v-model.number="armCfg.approachLength" type="number" min="30" max="600" step="5" /></label>
          <label>Ось перехода от центра, м <input v-model.number="armCfg.crosswalkOffset" type="number" min="5" max="80" step="0.5" /></label>
          <label>Ширина перехода, м <input v-model.number="armCfg.crosswalkWidth" type="number" min="2" max="8" step="0.5" /></label>
          <label>Скорость, км/ч <input v-model.number="armCfg.speedLimit" type="number" min="10" max="110" step="5" /></label>
          <label>Цвет машин <input v-model="armCfg.color" type="color" /></label>
          <label class="check"><input v-model="armCfg.hasCrosswalk" type="checkbox" /> Пешеходный переход</label>
          <label class="check"><input v-model="armCfg.refuge" type="checkbox" /> Островок безопасности на разделителе</label>
        </div>
        <div class="small muted">Новые островки и переходы появятся в пешеходном графе после команды «Достроить пешеходный граф» на вкладке «Редактор», панель «Схема».</div>
      </details>
    </section>

    <!-- Связь -->
    <section v-if="sel?.kind === 'conn'">
      <h3>Направление</h3>
      <div v-if="connSel">
        <div>{{ connLabel(connSel.id) }}</div>
        <h4>Каким светофором управляется</h4>
        <label v-for="g in connGroups" :key="g.id" class="check">
          <input type="checkbox" :checked="g.movements.includes(connSel.id)" @change="toggleIn(g.id, connSel.id, ($event.target as HTMLInputElement).checked)" />
          <span class="chip" :style="{ background: g.color }" /> {{ g.name }} <span class="muted small">{{ g.kind === 'arrow' ? 'стрелка' : 'основной' }}</span>
        </label>
        <button class="btn danger small" @click="deleteConn">Запретить это направление</button>
      </div>
      <div v-else class="muted">Направление удалено.</div>
    </section>

    <!-- Узел пешеходного графа -->
    <section v-if="sel?.kind === 'pednode'">
      <template v-if="pedNode">
        <h3>🚶 {{ pedNode.label }} <span class="muted small">({{ pedNode.id }})</span></h3>
        <div class="grid2">
          <label>Название <input v-model="pedNode.label" /></label>
          <label>Тип <input :value="pedNode.kind === 'corner' ? 'угол между подходами' : pedNode.kind === 'island' ? 'островок безопасности' : 'произвольная точка'" disabled /></label>
          <template v-if="pedNode.kind === 'point'">
            <label>x, м <input v-model.number="pedNode.x" type="number" step="0.5" /></label>
            <label>y, м <input v-model.number="pedNode.y" type="number" step="0.5" /></label>
          </template>
          <template v-else>
            <label>Сдвиг x, м <input v-model.number="pedNode.dx" type="number" step="0.5" /></label>
            <label>Сдвиг y, м <input v-model.number="pedNode.dy" type="number" step="0.5" /></label>
          </template>
        </div>
        <div class="small muted">Переходы из узла: {{ pedNodeEdges.map((e) => nodeLabel(e.from === pedNode!.id ? e.to : e.from)).join(', ') || 'нет' }}.</div>
        <h4>Пешеходы, которые начинают путь здесь</h4>
        <template v-if="pedSource">
          <div class="grid3">
            <label>Человек в час <input v-model.number="pedSource.rate" type="number" min="0" step="5" /></label>
            <label>Скорость от, м/с <input v-model.number="pedSource.speedMin" type="number" min="0.4" max="2.5" step="0.05" /></label>
            <label>до, м/с <input v-model.number="pedSource.speedMax" type="number" min="0.4" max="2.5" step="0.05" /></label>
          </div>
          <h4>Веса направлений</h4>
          <div class="grid3">
            <label v-for="n in otherNodes" :key="n.id">{{ n.label }}
              <input v-model.number="pedSource.destinations[n.id]" type="number" min="0" step="0.05" />
            </label>
          </div>
          <div class="small muted">Сумма {{ pedSum.toFixed(2) }}, веса нормируются. Маршрут строится по графу переходов, кратчайший или близкий к нему.</div>
          <h4>Группы пешеходов, которые переходят дорогу вместе</h4>
          <table class="tbl">
            <tr><th>Человек</th><th>Доля</th><th /></tr>
            <tr v-for="(g, i) in pedSource.groups" :key="i">
              <td><input v-model.number="g.size" type="number" min="1" max="4" step="1" /></td>
              <td><input v-model.number="g.share" type="number" min="0" max="1" step="0.01" /></td>
              <td><button class="btn small" @click="pedSource.groups.splice(i, 1)">✕</button></td>
            </tr>
          </table>
          <div class="row gap">
            <button class="btn small" @click="pedSource.groups.push({ size: 2, share: 0.1 })">+ размер группы</button>
            <button class="btn small danger" @click="removeSource">Здесь пешеходы не появляются</button>
          </div>
          <div class="small muted">Группы от трёх человек идут на 15% медленнее, пары — на 5%.</div>
        </template>
        <button v-else class="btn small" @click="addSource">+ пешеходы появляются здесь</button>
        <div class="row gap"><button class="btn danger small" @click="deletePedNode">Удалить узел</button></div>
      </template>
      <div v-else class="muted">Узел удалён.</div>
    </section>

    <!-- Ребро пешеходного графа -->
    <section v-if="sel?.kind === 'pededge'">
      <template v-if="pedEdge">
        <h3>Переход: {{ nodeLabel(pedEdge.from) }} — {{ nodeLabel(pedEdge.to) }}</h3>
        <div v-if="pedEdgeGeom" class="small muted">{{ KIND_EDGE[pedEdgeGeom.kind] }}. Длина пути {{ pedEdgeGeom.path.length.toFixed(1) }} м, по проезжей части {{ (pedEdgeGeom.roadS1 - pedEdgeGeom.roadS0).toFixed(1) }} м.</div>
        <div v-if="pedEdgeGeom?.kind === 'free' && pedEdgeGeom.roadS1 - pedEdgeGeom.roadS0 > 0.5" class="alert">Диагональный переход открывают только в отдельной пешеходной фазе, когда все машины стоят.</div>
        <div class="grid2">
          <label>Ширина «зебры», м <input v-model.number="pedEdge.width" type="number" min="2" max="10" step="0.5" /></label>
        </div>
        <h4>Каким пешеходным светофором управляется</h4>
        <label v-for="g in pedGroups" :key="g.id" class="check">
          <input type="checkbox" :checked="g.movements.includes(pedEdge.id)" @change="toggleIn(g.id, pedEdge.id, ($event.target as HTMLInputElement).checked)" />
          {{ g.name }} <span class="muted small">({{ g.id }})</span>
        </label>
        <div class="row gap">
          <button class="btn small" @click="newPedGroupFor">+ отдельный пешеходный светофор</button>
          <button class="btn danger small" @click="deletePedEdge">Удалить переход</button>
        </div>
        <div v-if="!pedGroups.some((g) => g.movements.includes(pedEdge!.id))" class="small muted">Без светофора пешеходы переходят, когда рядом нет машин, а машины обязаны их пропускать.</div>
      </template>
      <div v-else class="muted">Переход удалён.</div>
    </section>

    <!-- Остановка -->
    <section v-if="sel?.kind === 'stop'">
      <template v-if="stopSel">
        <h3>Остановка автобусов</h3>
        <div class="grid2">
          <label>Название <input v-model="stopSel.name" /></label>
          <label>Подход <select v-model="stopSel.arm"><option v-for="a in arms" :key="a.id" :value="a.id">{{ a.short }} [{{ a.id }}]</option></select></label>
          <label>Сторона <select v-model="stopSel.side"><option value="approach">перед перекрёстком</option><option value="exit">за перекрёстком</option></select></label>
          <label>{{ stopSel.side === 'approach' ? 'От стоп-линии, м' : 'От начала выезда, м' }} <input v-model.number="stopSel.dist" type="number" min="5" step="1" /></label>
          <label class="check"><input v-model="stopSel.bay" type="checkbox" /> Заездной карман</label>
        </div>
        <div class="small muted">В кармане автобус не занимает полосу. Без кармана машины за ним ждут, пока он стоит. Маршруты с этой остановкой: {{ routesOfStop.map((r) => r.name).join(', ') || 'нет' }}.</div>
        <button class="btn danger small" @click="deleteStop">Удалить остановку</button>
      </template>
      <div v-else class="muted">Остановка удалена.</div>
    </section>

    <!-- Маршрут -->
    <section v-if="sel?.kind === 'route'">
      <template v-if="routeSel">
        <h3>Автобусный маршрут</h3>
        <div class="grid2">
          <label>Название <input v-model="routeSel.name" /></label>
          <label>Автобусов в час <input v-model.number="routeSel.perHour" type="number" min="0" step="0.1" /></label>
          <label>Откуда <select v-model="routeSel.from"><option v-for="a in arms" :key="a.id" :value="a.id">{{ a.short }}</option></select></label>
          <label>Куда <select v-model="routeSel.to"><option v-for="a in arms" :key="a.id" :value="a.id">{{ a.short }}</option></select></label>
          <label>Длина автобуса, м <input v-model.number="routeSel.length" type="number" min="6" max="25" step="0.5" /></label>
          <label>Интервал по расписанию <input v-model="routeSel.headway" /></label>
          <label class="check"><input v-model="routeSel.enabled" type="checkbox" /> Маршрут работает</label>
        </div>
        <h4>Остановки</h4>
        <label v-for="st in cfg.transit.stops" :key="st.id" class="check">
          <input type="checkbox" :checked="routeSel.stops.includes(st.id)" @change="toggleRouteStop(st.id, ($event.target as HTMLInputElement).checked)" /> {{ st.name }}
        </label>
        <button class="btn danger small" @click="deleteRoute">Удалить маршрут</button>
      </template>
      <div v-else class="muted">Маршрут удалён.</div>
    </section>

    <!-- Сигнальная группа -->
    <section v-if="sel?.kind === 'group' && groupSel">
      <h3><span class="chip" :style="{ background: groupSel.color }" /> Сигнальная группа</h3>
      <div class="grid2">
        <label>Название <input v-model="groupSel.name" /></label>
        <label>Тип <input :value="KIND_NAMES[groupSel.kind]" disabled /></label>
        <label v-if="groupSel.kind !== 'arrow'">Подход <select v-model="groupSel.arm"><option v-for="a in arms" :key="a.id" :value="a.id">{{ a.short }} [{{ a.id }}]</option></select></label>
        <label v-else>Светофор, к которому прикреплена <select v-model="groupSel.parent"><option :value="undefined">отдельно</option><option v-for="g in vehicleHeads" :key="g.id" :value="g.id">{{ g.name }}</option></select></label>
        <label v-if="groupSel.kind === 'arrow'">Сторона <select v-model="groupSel.side"><option value="left">слева</option><option value="right">справа</option></select></label>
        <label>Цвет <input v-model="groupSel.color" type="color" /></label>
      </div>
      <template v-if="groupSel.kind === 'vehicle'">
        <h4>Дополнительные секции</h4>
        <div v-for="x in sectionsOf(groupSel.id)" :key="x.id" class="row between">
          <button class="btn small" @click="C.select({ kind: 'group', id: x.id })">{{ x.side === 'left' ? '◀' : '▶' }} {{ x.name }}</button>
        </div>
        <div class="row gap">
          <button class="btn small" @click="addSection('left')">+ секция слева</button>
          <button class="btn small" @click="addSection('right')">+ секция справа</button>
        </div>
        <div class="small muted">Секция горит зелёной стрелкой в фазах, где она включена, и разрешает выбранные направления, даже когда основной сигнал красный.</div>
        <label class="check"><input v-model="groupSel.pedInfo" type="checkbox" /> Информационная секция «внимание, пешеходы»</label>
        <div class="small muted">Бело-лунный мигающий сигнал предупреждает поворачивающих водителей о пешеходах на переходе. Учитывается в проверке по пункту 7.2.6 ГОСТ Р 52289-2019, на движение машин в модели не влияет.</div>
      </template>
      <div v-if="groupSel.kind === 'arrow' && parentOf" class="small muted">Секция стоит {{ groupSel.side === 'left' ? 'слева' : 'справа' }} от светофора «{{ parentOf.name }}».</div>
      <template v-if="groupSel.kind !== 'pedestrian'">
        <h4>Какими направлениями управляет</h4>
        <label v-for="c in cfg.connections" :key="c.id" class="check">
          <input type="checkbox" :checked="groupSel.movements.includes(c.id)" @change="toggleIn(groupSel.id, c.id, ($event.target as HTMLInputElement).checked)" />
          {{ connLabel(c.id) }}
        </label>
      </template>
      <template v-else>
        <h4>Какими переходами управляет</h4>
        <label v-for="e in cfg.peds.edges" :key="e.id" class="check">
          <input type="checkbox" :checked="groupSel.movements.includes(e.id)" @change="toggleIn(groupSel.id, e.id, ($event.target as HTMLInputElement).checked)" />
          {{ edgeLabel(e.id) }}
        </label>
        <div class="small muted">Переход через дорогу с островком — это два ребра. Обычно ими управляет один светофор, но можно и раздельно.</div>
      </template>
      <button class="btn danger small" @click="deleteGroup">Удалить группу</button>
    </section>

    <!-- Машина -->
    <section v-if="sel?.kind === 'vehicle'">
      <h3>Машина #{{ sel.id }}</h3>
      <div v-if="veh">
        <div class="kv"><span>Тип</span><b>{{ VK[veh.kind] }}, {{ veh.len.toFixed(1) }} м</b></div>
        <div class="kv"><span>Маршрут</span><b>{{ armName(veh.origin) }} → {{ armName(veh.dest) }}</b></div>
        <div class="kv"><span>Полоса / целевая</span><b>{{ veh.lane }} / {{ veh.targetLane }}</b></div>
        <div class="kv"><span>Скорость</span><b>{{ (veh.v * 3.6).toFixed(0) }} км/ч</b></div>
        <div class="kv"><span>Ожидание</span><b>{{ veh.stopTime.toFixed(0) }} с</b></div>
        <div class="kv"><span>Водитель</span><b>{{ veh.risky ? 'рискованный' : 'осторожный' }}</b></div>
        <div v-if="veh.conn >= 0" class="kv"><span>Манёвр</span><b>{{ simRef?.connLabel(veh.conn) }}</b></div>
        <div v-if="veh.origDest" class="kv"><span>Хотела на</span><b>{{ armName(veh.origDest) }}, не успела перестроиться</b></div>
        <div v-if="veh.route" class="kv"><span>Маршрут автобуса</span><b>{{ cfg.transit.routes.find((r) => r.id === veh!.route)?.name ?? veh.route }}</b></div>
        <div class="kv"><span>Сейчас</span><b>{{ WHY[veh.why] }}</b></div>
        <div v-if="veh.error" class="alert">⚠ {{ veh.error }}</div>
      </div>
      <div v-else class="muted">Машина уже покинула модель.</div>
      <div v-for="(e, i) in vehLog" :key="i" class="small log-line" :class="e.level">{{ e.t }} с — {{ e.msg }}</div>
    </section>

    <!-- Пешеходы -->
    <section v-if="sel?.kind === 'ped'">
      <h3>Пешеходы #{{ sel.id }}</h3>
      <div v-if="pedAgent">
        <div class="kv"><span>В группе</span><b>{{ pedAgent.size }} чел.</b></div>
        <div class="kv"><span>Маршрут</span><b>{{ nodeLabel(pedAgent.origin) }} → {{ nodeLabel(pedAgent.dest) }}</b></div>
        <div class="kv"><span>Скорость</span><b>{{ pedAgent.speed.toFixed(2) }} м/с</b></div>
        <div class="kv"><span>Ждут</span><b>{{ pedAgent.waiting ? 'да' : 'нет' }}, всего {{ pedAgent.waitTime.toFixed(0) }} с</b></div>
        <div v-if="pedAgent.hit" class="alert">⚠ Наезд, ждут помощи</div>
      </div>
      <div v-else class="muted">Пешеходы уже перешли.</div>
    </section>
  </div>
</template>
