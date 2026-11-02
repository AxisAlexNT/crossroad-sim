// Модель перекрёстка Оборонной и Тверской улиц в Колпино по умолчанию и предустановки светофорных программ
// и шаблоны других перекрёстков для редактора схемы.
// Геометрия — оценка по карте, интенсивности и длительности фаз — допущения. Всё редактируется в интерфейсе.

import type {
  ArmConfig, ArmId, Basemap, LaneChooserParams, ModelConfig, PedConfig, Phase, SignalGroup, SignalProgram, SpawnerParams, TransitConfig,
} from './types';
import { genControllerCode } from './codegen';
import {
  PED_COLOR, PED_GROUPS_DEFAULT, SIM_DEFAULT, TIMING_DEFAULT, VEHICLE_TYPES, conn, makeChooser, makeExit, makeSpawner,
  modelFromArms, newArm, reconcile,
} from './generate';

export const KOLPINO_ARMS: ArmConfig[] = [
  {
    id: 'E', name: 'Оборонная улица, восток', short: 'восток', angle: 0, inLanes: 3, outLanes: 2, laneWidth: 3.6, medianWidth: 3,
    axisShift: 0, crosswalkOffset: 22, crosswalkWidth: 4, stopLineGap: 1.5,
    approachLength: 170, solidLength: 30, exitLength: 120, speedLimit: 60, hasCrosswalk: true, refuge: false, color: '#22a387',
  },
  {
    id: 'N', name: 'Тверская улица, север', short: 'север', angle: 90, inLanes: 1, outLanes: 1, laneWidth: 4.5, medianWidth: 0,
    axisShift: 0, crosswalkOffset: 24, crosswalkWidth: 4, stopLineGap: 1.5,
    approachLength: 90, solidLength: 25, exitLength: 110, speedLimit: 60, hasCrosswalk: true, refuge: false, color: '#4f8cff',
  },
  {
    id: 'W', name: 'Оборонная улица, запад', short: 'запад', angle: 180, inLanes: 3, outLanes: 3, laneWidth: 3.75, medianWidth: 2.5,
    axisShift: 0, crosswalkOffset: 20, crosswalkWidth: 4, stopLineGap: 1.5,
    approachLength: 160, solidLength: 40, exitLength: 120, speedLimit: 60, hasCrosswalk: true, refuge: true, color: '#d4455f',
  },
  {
    id: 'S', name: 'Подъезд к Колпино, юг', short: 'юг', angle: 270, inLanes: 1, outLanes: 1, laneWidth: 4.5, medianWidth: 0,
    axisShift: 0, crosswalkOffset: 23.5, crosswalkWidth: 4, stopLineGap: 1.5,
    approachLength: 150, solidLength: 25, exitLength: 150, speedLimit: 60, hasCrosswalk: true, refuge: false, color: '#f2a33a',
  },
];

/** Разрешённые направления — по разметке на карте */
export const KOLPINO_CONNECTIONS = [
  // Оборонная с запада: 0 — налево и прямо, 1 — прямо, 2 — направо
  conn('W', 0, 'N', 0), conn('W', 0, 'E', 0), conn('W', 1, 'E', 1), conn('W', 2, 'S', 0),
  // Оборонная с востока: 0 — налево и прямо, 1 — прямо, 2 — направо
  conn('E', 0, 'S', 0), conn('E', 0, 'W', 0), conn('E', 1, 'W', 1), conn('E', 2, 'N', 0),
  // Тверская с севера: прямо и направо, налево только рейсовые автобусы
  conn('N', 0, 'S', 0), conn('N', 0, 'W', 2), { ...conn('N', 0, 'E', 0), busOnly: true },
  // С юга: прямо, налево, направо
  conn('S', 0, 'N', 0), conn('S', 0, 'W', 0), conn('S', 0, 'E', 1),
];

const groups = (sizes = PED_GROUPS_DEFAULT) => sizes.map((g) => ({ ...g }));

/**
 * Пешеходы. Углы: NE, NW, SW, SE, островок на Оборонной с запада — IW.
 * Оценка по застройке и маршрутам: больше всего ходят между северо-западом и юго-востоком
 * (примерно втрое больше, чем между северо-востоком и юго-западом), юго-западный угол — самый тихий.
 */
export const KOLPINO_PEDS: PedConfig = {
  nodes: [
    { id: 'NE', kind: 'corner', arms: ['E', 'N'], label: 'северо-восточный угол', dx: 0, dy: 0 },
    { id: 'NW', kind: 'corner', arms: ['N', 'W'], label: 'северо-западный угол', dx: 0, dy: 0 },
    { id: 'SW', kind: 'corner', arms: ['W', 'S'], label: 'юго-западный угол', dx: 0, dy: 0 },
    { id: 'SE', kind: 'corner', arms: ['S', 'E'], label: 'юго-восточный угол', dx: 0, dy: 0 },
    { id: 'IW', kind: 'island', arms: ['W'], label: 'островок на Оборонной с запада', dx: 0, dy: 0 },
  ],
  edges: [
    { id: 'NE~NW', from: 'NE', to: 'NW', width: 4 },
    { id: 'SW~IW', from: 'SW', to: 'IW', width: 4 },
    { id: 'IW~NW', from: 'IW', to: 'NW', width: 4 },
    { id: 'SW~SE', from: 'SW', to: 'SE', width: 4 },
    { id: 'SE~NE', from: 'SE', to: 'NE', width: 4 },
  ],
  sources: [
    { node: 'NW', rate: 82, groups: groups(), speedMin: 1.0, speedMax: 1.6, destinations: { SE: 0.55, NE: 0.36, SW: 0.09 } },
    { node: 'NE', rate: 105, groups: groups(), speedMin: 1.0, speedMax: 1.6, destinations: { SE: 0.57, NW: 0.29, SW: 0.14 } },
    { node: 'SE', rate: 112, groups: groups(), speedMin: 1.0, speedMax: 1.6, destinations: { NE: 0.53, NW: 0.4, SW: 0.07 } },
    { node: 'SW', rate: 30, groups: groups(), speedMin: 1.0, speedMax: 1.6, destinations: { NE: 0.5, NW: 0.25, SE: 0.25 } },
  ],
};

function program(gs: SignalGroup[], phases: Phase[]): SignalProgram {
  const p: SignalProgram = { groups: gs, phases, timing: { ...TIMING_DEFAULT }, offset: 0, controller: 'fixed', code: '' };
  p.code = genControllerCode(p);
  return p;
}

// Транспортные группы «как есть»: по одному основному светофору на подход (левый поворот без защиты)
const G_N: SignalGroup = { id: 'N', name: 'Тверская с севера', kind: 'vehicle', arm: 'N', movements: ['N0-S0', 'N0-W2', 'N0-E0'], color: '#4f8cff' };
const G_S: SignalGroup = { id: 'S', name: 'Подъезд с юга', kind: 'vehicle', arm: 'S', movements: ['S0-N0', 'S0-W0', 'S0-E1'], color: '#f2a33a' };
const G_W_ALL: SignalGroup = { id: 'W', name: 'Оборонная с запада', kind: 'vehicle', arm: 'W', movements: ['W0-N0', 'W0-E0', 'W1-E1', 'W2-S0'], color: '#d4455f' };
const G_E_ALL: SignalGroup = { id: 'E', name: 'Оборонная с востока', kind: 'vehicle', arm: 'E', movements: ['E0-S0', 'E0-W0', 'E1-W1', 'E2-N0'], color: '#22a387' };
const G_WR: SignalGroup = { id: 'Wr', name: 'Допсекция направо с запада', kind: 'arrow', arm: 'W', movements: ['W2-S0'], color: '#b23a51', parent: 'W', side: 'right' };
// Группы с отдельными стрелками налево
const G_W_SR: SignalGroup = { id: 'W', name: 'Оборонная с запада, прямо и направо', kind: 'vehicle', arm: 'W', movements: ['W0-E0', 'W1-E1', 'W2-S0'], color: '#d4455f' };
const G_E_SR: SignalGroup = { id: 'E', name: 'Оборонная с востока, прямо и направо', kind: 'vehicle', arm: 'E', movements: ['E0-W0', 'E1-W1', 'E2-N0'], color: '#22a387' };
const G_WL: SignalGroup = { id: 'Wl', name: 'Допсекция налево с запада', kind: 'arrow', arm: 'W', movements: ['W0-N0'], color: '#ff6b8b', parent: 'W', side: 'left' };
const G_EL: SignalGroup = { id: 'El', name: 'Допсекция налево с востока', kind: 'arrow', arm: 'E', movements: ['E0-S0'], color: '#5fd4b5', parent: 'E', side: 'left' };
// Пешеходные светофоры: по группе на каждый переход (через западную часть Оборонной — обе половины с островком)
const P_N: SignalGroup = { id: 'PN', name: 'Пешеходы через Тверскую', kind: 'pedestrian', arm: 'N', movements: ['NE~NW'], color: PED_COLOR };
const P_W: SignalGroup = { id: 'PW', name: 'Пешеходы через Оборонную к западу', kind: 'pedestrian', arm: 'W', movements: ['SW~IW', 'IW~NW'], color: PED_COLOR };
const P_S: SignalGroup = { id: 'PS', name: 'Пешеходы через подъезд к Колпино', kind: 'pedestrian', arm: 'S', movements: ['SW~SE'], color: PED_COLOR };
const P_E: SignalGroup = { id: 'PE', name: 'Пешеходы через Оборонную к востоку', kind: 'pedestrian', arm: 'E', movements: ['SE~NE'], color: PED_COLOR };
const PEDS = [P_N, P_W, P_S, P_E];
const PED_IDS = PEDS.map((g) => g.id);

const ph = (id: string, name: string, duration: number, green: string[]): Phase => ({ id, name, duration, green });

export interface Preset {
  id: string;
  name: string;
  description: string;
  signals: () => SignalProgram;
}

/** Варианты светофорных программ для перекрёстка Оборонная / Тверская. Длительности фаз условные. */
export const PRESETS: Preset[] = [
  {
    id: 'v1',
    name: 'Вариант 1. Четыре фазы без допсекций',
    description:
      'Фаза 1: Тверская в обе стороны, с севера прямо и направо, с юга прямо, налево и направо. Фаза 1,5: только с юга. ' +
      'Фаза 3: Оборонная в обе стороны, левые повороты без защиты. Фаза 4: единая пешеходная фаза. Длительности 30, 30, 25 и 25 с.',
    signals: () => program([G_N, G_S, G_W_ALL, G_E_ALL, ...PEDS], [
      ph('1', '1: Тверская', 30, ['N', 'S']),
      ph('1.5', '1,5: только с юга', 30, ['S']),
      ph('3', '3: Оборонная', 25, ['W', 'E']),
      ph('4', '4: пешеходы, ЕПФ', 25, PED_IDS),
    ]),
  },
  {
    id: 'v1a',
    name: 'Вариант 1а. С допсекцией направо с запада',
    description:
      'Как вариант 1, но у светофора на Оборонной с запада есть допсекция направо. Фаза 1,5 короче, добавлена фаза 2: с юга и по стрелке направо с запада.',
    signals: () => program([G_N, G_S, G_W_ALL, G_E_ALL, G_WR, ...PEDS], [
      ph('1', '1: Тверская', 30, ['N', 'S']),
      ph('1.5', '1,5: только с юга', 10, ['S']),
      ph('2', '2: с юга и направо с запада', 20, ['S', 'Wr']),
      ph('3', '3: Оборонная', 25, ['W', 'E']),
      ph('4', '4: пешеходы, ЕПФ', 25, PED_IDS),
    ]),
  },
  {
    id: 'v2',
    name: 'Вариант 2. Фаза Оборонной в три такта',
    description:
      'Фаза 3 разделена. 3а: все направления с запада, налево по стрелке без встречного потока. 3б: с обеих сторон прямо и направо. ' +
      '3в: все направления с востока.',
    signals: () => program([G_N, G_S, G_W_SR, G_E_SR, G_WL, G_EL, G_WR, ...PEDS], [
      ph('1', '1: Тверская', 30, ['N', 'S']),
      ph('1.5', '1,5: только с юга', 10, ['S']),
      ph('2', '2: с юга и направо с запада', 20, ['S', 'Wr']),
      ph('3a', '3а: всё с запада', 8, ['W', 'Wl']),
      ph('3b', '3б: прямо и направо с обеих сторон', 12, ['W', 'E']),
      ph('3c', '3в: всё с востока', 7, ['E', 'El']),
      ph('4', '4: пешеходы, ЕПФ', 25, PED_IDS),
    ]),
  },
  {
    id: 'v3',
    name: 'Вариант 3. Без конфликтующих потоков внутри фаз',
    description:
      'С юга отдельно, с севера отдельно, по Оборонной сначала прямо и направо, затем оба левых поворота по стрелкам, затем пешеходы. ' +
      'Внутри фаз потоки не пересекаются, цикл при этом длиннее.',
    signals: () => program([G_N, G_S, G_W_SR, G_E_SR, G_WL, G_EL, ...PEDS], [
      ph('S', 'Ю: всё с юга', 22, ['S']),
      ph('N', 'С: всё с севера', 15, ['N']),
      ph('3x', 'Оборонная прямо и направо', 18, ['W', 'E']),
      ph('3y', 'Оборонная: оба левых по стрелкам', 8, ['Wl', 'El']),
      ph('4', 'Пешеходы, ЕПФ', 25, PED_IDS),
    ]),
  },
  {
    id: 'v4',
    name: 'Вариант 4. Сначала прямо, затем налево по стрелкам',
    description:
      'Фаза 3 делится на «прямо и направо с обеих сторон» и «оба левых по стрелкам». Левые повороты не пересекаются со встречным прямым потоком.',
    signals: () => program([G_N, G_S, G_W_SR, G_E_SR, G_WL, G_EL, G_WR, ...PEDS], [
      ph('1', '1: Тверская', 30, ['N', 'S']),
      ph('1.5', '1,5: только с юга', 10, ['S']),
      ph('2', '2: с юга и направо с запада', 20, ['S', 'Wr']),
      ph('3x', '3: прямо и направо', 17, ['W', 'E']),
      ph('3y', '3*: оба левых по стрелкам', 8, ['Wl', 'El']),
      ph('4', '4: пешеходы, ЕПФ', 25, PED_IDS),
    ]),
  },
  {
    id: 'v5',
    name: 'Вариант 5. Пешеходы вместе с параллельным потоком',
    description:
      'Без единой пешеходной фазы: переходы через Тверскую и подъезд к Колпино открыты вместе с Оборонной, ' +
      'переходы через Оборонную — вместе с Тверской. Поворачивающие машины пропускают пешеходов. Проверки покажут, где это расходится с п. 7.2.6 ГОСТ Р 52289-2019.',
    signals: () => program([G_N, G_S, G_W_ALL, G_E_ALL, ...PEDS], [
      ph('1', '1: Тверская и переходы через Оборонную', 30, ['N', 'S', 'PW', 'PE']),
      ph('1.5', '1,5: только с юга', 15, ['S']),
      ph('3', '3: Оборонная и переходы через Тверскую', 28, ['W', 'E', 'PN', 'PS']),
    ]),
  },
];

/**
 * Автобусные маршруты, проходящие через перекрёсток. Направления движения через перекрёсток определены по порядку остановок,
 * интенсивность — по интервалам из расписаний (середина диапазона интервала). В расписаниях остановки у перекрёстка
 * называются «Тверская улица (Оборонная улица)».
 */
export const KOLPINO_TRANSIT = (): TransitConfig => ({
  enabled: true,
  stops: [
    { id: 'TV-in', name: 'Тверская улица перед перекрёстком', arm: 'N', side: 'approach', dist: 18, bay: true },
    { id: 'TV-out', name: 'Тверская улица за перекрёстком', arm: 'N', side: 'exit', dist: 65, bay: true },
    { id: 'OB-W', name: 'Оборонная улица к западу от перекрёстка', arm: 'W', side: 'exit', dist: 20, bay: true },
    { id: 'OB-E', name: 'Оборонная улица к востоку от перекрёстка', arm: 'E', side: 'exit', dist: 25, bay: true },
  ],
  routes: [
    { id: '324n', name: '324 к Тверской', from: 'S', to: 'N', stops: ['TV-out'], perHour: 3.3, length: 12, headway: '14–22 мин', enabled: true },
    { id: '324s', name: '324 к пос. Тельмана', from: 'N', to: 'S', stops: ['TV-in'], perHour: 3.3, length: 12, headway: '14–22 мин', enabled: true },
    { id: '325w', name: '325 к Заводскому проспекту', from: 'N', to: 'W', stops: ['OB-W'], perHour: 2.2, length: 12, headway: '25–30 мин', enabled: true },
    { id: '325n', name: '325 к Тверской', from: 'W', to: 'N', stops: ['TV-out'], perHour: 2.2, length: 12, headway: '25–30 мин', enabled: true },
    { id: '328e', name: '328 к Московской улице', from: 'N', to: 'E', stops: ['TV-in'], perHour: 3.3, length: 12, headway: '13–23 мин', enabled: true },
    { id: '328w', name: '328 к улице Анисимова', from: 'E', to: 'W', stops: ['OB-W'], perHour: 3.3, length: 12, headway: '13–23 мин', enabled: true },
    { id: '330w', name: '330 к улице Анисимова', from: 'N', to: 'W', stops: ['OB-W'], perHour: 6.7, length: 12, headway: '6–12 мин', enabled: true },
    { id: '330n', name: '330 к Тверской', from: 'W', to: 'N', stops: ['TV-out'], perHour: 6.7, length: 12, headway: '6–12 мин', enabled: true },
    { id: '364n', name: '364 к Тверской', from: 'W', to: 'N', stops: ['TV-out'], perHour: 2.9, length: 12, headway: 'около 20 мин', enabled: true },
    { id: '364w', name: '364 к улице Анисимова', from: 'N', to: 'W', stops: ['OB-W'], perHour: 2.9, length: 12, headway: 'около 20 мин', enabled: true },
    { id: '367s', name: '367 к пос. Тельмана', from: 'N', to: 'S', stops: ['TV-in'], perHour: 3.3, length: 12, headway: '14–22 мин', enabled: true },
    { id: '367n', name: '367 к Тверской', from: 'S', to: 'N', stops: ['TV-out'], perHour: 3.3, length: 12, headway: '14–22 мин', enabled: true },
    { id: '392n', name: '392 к Тверской', from: 'S', to: 'N', stops: ['TV-out'], perHour: 2.7, length: 12, headway: '22 мин', enabled: true },
    { id: '392s', name: '392 к пос. Тельмана', from: 'N', to: 'S', stops: ['TV-in'], perHour: 2.7, length: 12, headway: '22 мин', enabled: true },
  ],
  dwellMin: 60,
  dwellMax: 90,
});

// рейсовые автобусы задаются маршрутами, в общем потоке остаются только крупные машины такого же размера
const TYPES_KOLPINO = VEHICLE_TYPES.map((t) => (t.kind === 'bus' ? { ...t, share: 0.01 } : t.kind === 'car' ? { ...t, share: 0.87 } : { ...t }));

const SPAWN_DEFAULT: Record<ArmId, Omit<SpawnerParams, 'types'>> = {
  W: { arrival: 'poisson', rate: 420, profile: [], platoonSize: 4, destinations: { E: 0.72, N: 0.18, S: 0.1 } },
  E: { arrival: 'poisson', rate: 400, profile: [], platoonSize: 4, destinations: { W: 0.7, S: 0.2, N: 0.1 } },
  N: { arrival: 'poisson', rate: 220, profile: [], platoonSize: 4, destinations: { S: 0.6, W: 0.4 } },
  S: { arrival: 'poisson', rate: 380, profile: [], platoonSize: 4, destinations: { N: 0.45, W: 0.35, E: 0.2 } },
};

const CHOOSER_DEFAULT: Record<ArmId, LaneChooserParams> = {
  W: { strategy: 'weights', preLaned: 0.7, weights: { E: [0.35, 0.65, 0], N: [1, 0, 0], S: [0, 0, 1] } },
  E: { strategy: 'weights', preLaned: 0.7, weights: { W: [0.3, 0.7, 0], S: [1, 0, 0], N: [0, 0, 1] } },
  N: { strategy: 'weights', preLaned: 1, weights: { S: [1], W: [1] } },
  S: { strategy: 'weights', preLaned: 1, weights: { N: [1], W: [1], E: [1] } },
};

export const DEFAULT_PRESET = 'v1';

/** Модель перекрёстка Оборонная / Тверская */
export function kolpinoModel(presetId = DEFAULT_PRESET): ModelConfig {
  const arms = structuredClone(KOLPINO_ARMS);
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const spawners: ModelConfig['spawners'] = {};
  const laneChoosers: ModelConfig['laneChoosers'] = {};
  const exits: ModelConfig['exits'] = {};
  for (const a of arms) {
    spawners[a.id] = makeSpawner(a, { ...structuredClone(SPAWN_DEFAULT[a.id]), types: TYPES_KOLPINO.map((t) => ({ ...t })) });
    laneChoosers[a.id] = makeChooser(a, structuredClone(CHOOSER_DEFAULT[a.id]));
    exits[a.id] = makeExit(a, { capacityPerLane: 0, blocked: [] });
  }
  return {
    format: 'crossroad-model',
    version: 2,
    name: 'Оборонная ул. / Тверская ул., Колпино',
    description: 'Регулируемый перекрёсток с четырьмя подходами. На западной части Оборонной есть островок безопасности.',
    arms,
    connections: structuredClone(KOLPINO_CONNECTIONS),
    peds: structuredClone(KOLPINO_PEDS),
    signals: preset.signals(),
    transit: KOLPINO_TRANSIT(),
    spawners, laneChoosers, exits,
    sim: structuredClone(SIM_DEFAULT),
    basemap: kolpinoBasemap(),
  };
}

/**
 * Встроенная подложка OpenStreetMap для Колпино. Центр — общая точка Оборонной и Тверской улиц в данных OSM,
 * поворот совмещает оси улиц с осями схемы. Значения выдаёт scripts/prepare-osm.ts
 */
export function kolpinoBasemap(): Basemap {
  return { builtin: 'kolpino', origin: { lat: 59.7308223, lon: 30.6119932 }, rotation: -1.52, dx: 0, dy: 0, features: [], attribution: '© участники OpenStreetMap, лицензия ODbL' };
}

/** Исходная разметка: разрешённые направления и пешеходный граф (для модели с подходами Колпино — из неё, иначе по типовой схеме) */
export function markingsFor(cfg: ModelConfig): Pick<ModelConfig, 'connections' | 'peds'> | null {
  const ids = cfg.arms.map((a) => a.id).sort().join(',');
  if (ids === 'E,N,S,W') return { connections: structuredClone(KOLPINO_CONNECTIONS), peds: structuredClone(KOLPINO_PEDS) };
  return null;
}

/** Загрузить только разметку (рёбра графа) в модель, сохранив светофоры и остальное */
export function applyMarkings(cfg: ModelConfig, m: Pick<ModelConfig, 'connections' | 'peds'>): ModelConfig {
  cfg.connections = structuredClone(m.connections);
  cfg.peds = structuredClone(m.peds);
  return reconcile(cfg);
}

export const defaultModel = kolpinoModel;

export interface Template {
  id: string;
  name: string;
  description: string;
  make: () => ModelConfig;
}

/** Шаблоны для редактора схемы */
export const TEMPLATES: Template[] = [
  {
    id: 'kolpino',
    name: 'Оборонная / Тверская, Колпино',
    description: 'Модель по умолчанию: четыре подхода, островок на западной части Оборонной, единая пешеходная фаза, автобусные маршруты.',
    make: () => kolpinoModel(DEFAULT_PRESET),
  },
  {
    id: 'cross4',
    name: 'Типовой крестообразный перекрёсток',
    description: 'Четыре подхода под прямым углом, по две полосы в каждую сторону, две фазы и ЕПФ.',
    make: () => modelFromArms('Типовой перекрёсток 4 подхода', [newArm('E', 0, 0), newArm('N', 90, 1), newArm('W', 180, 2), newArm('S', 270, 3)], { description: 'Сгенерировано по шаблону.' }),
  },
  {
    id: 'tee',
    name: 'Т-образный перекрёсток',
    description: 'Главная дорога восток — запад с разделителем и островками, примыкание с юга.',
    make: () => {
      const e = { ...newArm('E', 0, 0), medianWidth: 3, refuge: true, name: 'Главная дорога, восток' };
      const w = { ...newArm('W', 180, 2), medianWidth: 3, refuge: true, name: 'Главная дорога, запад' };
      const s = { ...newArm('S', 270, 3), inLanes: 2, outLanes: 1, name: 'Примыкание, юг' };
      return modelFromArms('Т-образный перекрёсток', [e, w, s], { rate: 280, pedRate: 40, description: 'Сгенерировано по шаблону.' });
    },
  },
  {
    id: 'skew',
    name: 'Перекрёсток под острым углом',
    description: 'Четыре подхода, второстепенная дорога пересекает главную под углом около 60°.',
    make: () => {
      const arms = [
        { ...newArm('E', 0, 0), inLanes: 2, outLanes: 2, name: 'Главная, восток' },
        { ...newArm('NE', 60, 1), inLanes: 2, outLanes: 1, laneWidth: 3.5, name: 'Второстепенная, северо-восток' },
        { ...newArm('W', 180, 2), inLanes: 2, outLanes: 2, name: 'Главная, запад' },
        { ...newArm('SW', 240, 3), inLanes: 2, outLanes: 1, laneWidth: 3.5, name: 'Второстепенная, юго-запад' },
      ].map((a) => ({ ...a, crosswalkOffset: a.id.length > 1 ? 20 : 18 }));
      return modelFromArms('Перекрёсток под углом', arms, { rate: 220, description: 'Сгенерировано по шаблону.' });
    },
  },
];
