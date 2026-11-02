// Формат модели перекрёстка (crossroad-model, версия 2) и контракты пользовательского кода.
// Модель целиком сериализуется в JSON. Формат описан в docs/model-format.md и schema/crossroad-model.schema.json.
// Система координат: метры, начало — центр перекрёстка, x — на восток, y — на север.

export type ArmId = string;

/** Тип манёвра относительно направления въезда */
export type TurnKind = 'straight' | 'left' | 'right' | 'uturn';

export interface ArmConfig {
  /** Уникальный короткий идентификатор подхода (латиница, например «N» или «A1») */
  id: ArmId;
  /** Полное название дороги */
  name: string;
  /** Короткое название стороны для подписей («север», «запад») */
  short: string;
  /** Направление дороги от центра наружу, градусы: 0 — восток, 90 — север (против часовой) */
  angle: number;
  /** Полосы к перекрёстку. Индекс 0 — у оси или разделителя, дальше — к бордюру */
  inLanes: number;
  /** Полосы от перекрёстка. Индекс 0 — у оси или разделителя */
  outLanes: number;
  laneWidth: number;
  medianWidth: number;
  /** Сдвиг оси дороги вбок (м), положительный — вправо при взгляде от центра наружу */
  axisShift: number;
  /** Расстояние от центра перекрёстка до оси пешеходного перехода, м */
  crosswalkOffset: number;
  crosswalkWidth: number;
  /** Зазор между стоп-линией и переходом, м */
  stopLineGap: number;
  /** От точки появления машин до стоп-линии, м */
  approachLength: number;
  /** От точки перестроения до стоп-линии (сплошная разметка), м */
  solidLength: number;
  /** Длина выездного участка до точки выезда из модели, м */
  exitLength: number;
  /** Разрешённая скорость, км/ч */
  speedLimit: number;
  /** Есть ли пешеходный переход через эту дорогу у перекрёстка */
  hasCrosswalk: boolean;
  /** На разделителе есть островок безопасности, где пешеходы могут остановиться */
  refuge: boolean;
  /** Цвет машин с этого подхода */
  color: string;
}

export interface LaneRef {
  arm: ArmId;
  lane: number;
}

/** Связь «полоса въезда → полоса выезда» (разрешённое направление движения) */
export interface Connection {
  id: string;
  from: LaneRef;
  to: LaneRef;
  /** Направление разрешено только рейсовым автобусам */
  busOnly?: boolean;
}

export type GroupKind = 'vehicle' | 'arrow' | 'pedestrian';

/** Сигнальная группа: светофор, допсекция или пешеходный светофор */
export interface SignalGroup {
  id: string;
  name: string;
  kind: GroupKind;
  /** Подход, к которому относится светофор (для отображения) */
  arm: ArmId;
  /** Транспортные группы: id связей. Пешеходные группы: id пешеходных переходов (рёбер) */
  movements: string[];
  color: string;
  /** Для допсекции: id основного светофора, к которому она прикреплена */
  parent?: string;
  /** Для допсекции: с какой стороны от основного светофора (как видит водитель) */
  side?: 'left' | 'right';
  /**
   * Для транспортного светофора: есть информационная световая секция, которая бело-лунным мигающим сигналом
   * предупреждает водителей о возможном движении пешеходов по переходу (ГОСТ Р 52289-2019, 7.2.6 и 7.4.12)
   */
  pedInfo?: boolean;
}

export interface Phase {
  id: string;
  name: string;
  /** Длительность основного такта, целые секунды (включая мигание зелёного) */
  duration: number;
  /** id групп с разрешающим сигналом в этой фазе */
  green: string[];
}

export interface SignalTiming {
  /** Жёлтый, с (по нормативам — 3 с) */
  yellow: number;
  /** Красный с жёлтым перед зелёным, с (не более 2 с) */
  redYellow: number;
  /** Мигание зелёного в конце основного такта, с (3 с) */
  flashGreen: number;
  /** Дополнительный «все красные» в промтакте, с */
  allRed: number;
  /** Промтакт для пешеходных групп, с */
  pedClearance: number;
}

export type ControllerMode = 'fixed' | 'code';

export interface SignalProgram {
  groups: SignalGroup[];
  phases: Phase[];
  timing: SignalTiming;
  /** Сдвиг начала цикла, с */
  offset: number;
  controller: ControllerMode;
  /** TS-код контроллера (используется при controller = 'code') */
  code: string;
}

export type VehicleKind = 'car' | 'van' | 'truck' | 'bus';

export interface VehicleTypeParams {
  kind: VehicleKind;
  share: number;
  lengthMin: number;
  lengthMax: number;
}

export type ArrivalModel = 'poisson' | 'uniform' | 'platoon';

export interface RatePoint {
  /** Время начала участка, с от начала симуляции */
  from: number;
  /** Интенсивность, авт/ч */
  rate: number;
}

export interface SpawnerParams {
  arrival: ArrivalModel;
  /** Интенсивность, авт/ч (если профиль пуст) */
  rate: number;
  /** Ступенчатый профиль интенсивности */
  profile: RatePoint[];
  /** Для 'platoon': размер пачки машин */
  platoonSize: number;
  /** Доли машин по подходам выезда */
  destinations: Record<ArmId, number>;
  types: VehicleTypeParams[];
}

export type LaneStrategy = 'weights' | 'shortestQueue';

export interface LaneChooserParams {
  strategy: LaneStrategy;
  /** Для каждого подхода выезда — веса полос въезда */
  weights: Record<ArmId, number[]>;
  /** Доля машин, которые появляются уже в нужной полосе */
  preLaned: number;
}

export interface ExitParams {
  /** Пропускная способность выезда, авт/ч на полосу (0 — без ограничений) */
  capacityPerLane: number;
  /** Интервалы полной блокировки выезда (пробка дальше по дороге) */
  blocked: { from: number; to: number }[];
}

export interface CodeNode<P> {
  id: string;
  params: P;
  /** TypeScript-код узла */
  code: string;
  /** true — код правили вручную, он главнее параметров */
  manual: boolean;
}

// ---------- Пешеходы ----------

/**
 * Узел пешеходного графа:
 * corner — угол между двумя соседними подходами (arms = [a, b], b — следующий против часовой),
 * island — островок безопасности на разделителе подхода (arms = [a]),
 * point — произвольная точка (x, y).
 */
export interface PedNode {
  id: string;
  kind: 'corner' | 'island' | 'point';
  arms: ArmId[];
  label: string;
  x?: number;
  y?: number;
  /** Ручной сдвиг от автоматически вычисленного положения, м */
  dx: number;
  dy: number;
}

/** Ребро пешеходного графа — пешеходный переход (или его половина до островка) */
export interface PedEdge {
  id: string;
  from: string;
  to: string;
  /** Ширина «зебры», м */
  width: number;
}

export interface PedGroupSize {
  size: number;
  share: number;
}

/** Источник пешеходов в узле (обычно на углу) */
export interface PedSource {
  node: string;
  /** Пешеходов в час (людей, не групп) */
  rate: number;
  groups: PedGroupSize[];
  speedMin: number;
  speedMax: number;
  /** Куда хотят попасть: id узла → вес */
  destinations: Record<string, number>;
}

export interface PedConfig {
  nodes: PedNode[];
  edges: PedEdge[];
  sources: PedSource[];
}

/** Вероятности нарушений ПДД для рискованных водителей (0…1) */
export interface ViolationSettings {
  /** перестроение через сплошную, если не успел занять нужную полосу */
  solidLine: number;
  /** остановка за стоп-линией на запрещающий сигнал */
  stopLine: number;
  /** въезд на перекрёсток в первые секунды красного */
  redLight: number;
  /** поворот из полосы, откуда он разметкой не разрешён */
  illegalTurn: number;
}

export interface SimSettings {
  dt: number;
  seed: number;
  /** Доля рискованных водителей: поворачивают налево, ориентируясь только на то, что видят, и чаще нарушают ПДД */
  riskyShare: number;
  violations: ViolationSettings;
  /** Видимость встречного потока, когда её закрывают встречные левоповоротники, м */
  obstructedVisibility: number;
  /** Обычная видимость, м */
  normalVisibility: number;
  /** Критический интервал для поворота налево через встречный поток, с */
  criticalGapLeft: number;
  /** Критический интервал для остальных уступающих манёвров, с */
  criticalGapOther: number;
  /** Порог PET для «опасного момента», с */
  petDanger: number;
  /** Окно PET для подсчёта «пересечений траекторий», с */
  petWindow: number;
  /** Запас по времени для «опасного сближения» по габаритам, с */
  ttcDanger: number;
  /** Столкнувшиеся машины остаются на месте и перекрывают проезд */
  crashPersist: boolean;
  /** Время до освобождения проезда после столкновения, с */
  crashDuration: number;
  /**
   * Машина не успела перестроиться до сплошной:
   * 'reroute' — сразу едет по направлению, разрешённому из своей полосы;
   * 'wait' — сначала ждёт окна перед сплошной не дольше lcPatience секунд.
   */
  missedTurn: 'reroute' | 'wait';
  /** Сколько секунд водитель готов стоять перед сплошной в ожидании окна для перестроения */
  lcPatience: number;
  /** Через сколько секунд взаимного ожидания фиксируется взаимная блокировка */
  deadlockSeconds: number;
  /** Водители выходят из взаимной блокировки, нарушая очерёдность, через столько секунд (0 — никогда) */
  deadlockBreak: number;
  /** Окно усреднения скорости для предупреждения о замедлении, с */
  slowdownWindow: number;
  /** Порог замедления: средняя скорость в окне ниже этой доли от обычной */
  slowdownRatio: number;
  /** Нет проезда при разрешающем сигнале столько секунд — предупреждение */
  noProgressSeconds: number;
  /** Сколько секунд истории хранить для перемотки назад */
  historySeconds: number;
}

// ---------- Общественный транспорт ----------

/** Остановка автобуса у подхода: на полосах к перекрёстку или от него */
export interface BusStop {
  id: string;
  name: string;
  arm: ArmId;
  side: 'approach' | 'exit';
  /** Расстояние от стоп-линии (к перекрёстку) или от начала выезда (от перекрёстка), м */
  dist: number;
  /** Заездной карман: автобус освобождает полосу на время стоянки */
  bay: boolean;
}

export interface BusRoute {
  id: string;
  name: string;
  from: ArmId;
  to: ArmId;
  /** id остановок по порядку */
  stops: string[];
  /** Автобусов в час в этом направлении */
  perHour: number;
  /** Длина автобуса, м */
  length: number;
  /** Интервал по расписанию, мин (для справки) */
  headway?: string;
  enabled: boolean;
}

export interface TransitConfig {
  enabled: boolean;
  stops: BusStop[];
  routes: BusRoute[];
  /** Время стоянки на остановке, с */
  dwellMin: number;
  dwellMax: number;
}

// ---------- Подложка ----------

export type BasemapKind = 'building' | 'road' | 'path' | 'water' | 'green' | 'rail' | 'parking' | 'area';

export interface BasemapFeature {
  k: BasemapKind;
  /** координаты x0,y0,x1,y1… в метрах относительно центра перекрёстка (до поворота и сдвига) */
  g: number[];
  closed: boolean;
  name?: string;
  /** для дорог: класс highway */
  hw?: string;
}

export interface Basemap {
  /**
   * Встроенная в приложение подложка, например 'kolpino'. Тогда объекты берутся из приложения,
   * а в файле модели хранятся только привязка и поворот
   */
  builtin?: string;
  /** точка, которая совмещается с центром перекрёстка */
  origin: { lat: number; lon: number };
  /** поворот подложки, градусы против часовой стрелки */
  rotation: number;
  dx: number;
  dy: number;
  features: BasemapFeature[];
  attribution: string;
}

export interface ModelConfig {
  format: 'crossroad-model';
  version: 2;
  name: string;
  description: string;
  arms: ArmConfig[];
  connections: Connection[];
  peds: PedConfig;
  signals: SignalProgram;
  transit: TransitConfig;
  /** Подложка из данных OpenStreetMap (необязательно) */
  basemap?: Basemap | null;
  spawners: Record<ArmId, CodeNode<SpawnerParams>>;
  laneChoosers: Record<ArmId, CodeNode<LaneChooserParams>>;
  exits: Record<ArmId, CodeNode<ExitParams>>;
  sim: SimSettings;
}

/** Скомпилированный JS (после TypeScript) для каждого узла с кодом */
export interface CompiledCode {
  spawners: Record<ArmId, string | undefined>;
  laneChoosers: Record<ArmId, string | undefined>;
  exits: Record<ArmId, string | undefined>;
  controller?: string;
}

// ---------- Контракты пользовательского кода ----------

export interface NewVehicle {
  /** id подхода, куда машина хочет уехать */
  destination: ArmId;
  kind: VehicleKind;
  length: number;
  /** id маршрута для рейсового автобуса */
  route?: string;
}

export interface SpawnContext {
  /** Время симуляции, с */
  t: number;
  /** Шаг, с */
  dt: number;
  arm: ArmId;
  random(): number;
  uniform(a: number, b: number): number;
  /** Выбор ключа объекта по весам: pick({ N: 0.2, E: 0.8 }) */
  pick(weights: Record<string, number>): string;
  pickWeighted<T>(items: Array<[T, number]>): T;
  /** Состояние для вашего кода (сохраняется между вызовами и в снимках) */
  memory: Record<string, unknown>;
}

export interface VehicleInfo {
  id: number;
  kind: VehicleKind;
  length: number;
  destination: ArmId;
  lane: number;
}

export interface LaneInfo {
  index: number;
  /** Куда можно доехать из полосы (id подходов выезда) */
  reachable: ArmId[];
  /** Машин в полосе на подходе */
  vehicles: number;
  /** Длина очереди (стоящих машин), шт. */
  queue: number;
}

export interface LaneContext {
  t: number;
  arm: ArmId;
  lanes: LaneInfo[];
  random(): number;
  pickWeighted<T>(items: Array<[T, number]>): T;
  memory: Record<string, unknown>;
}

export interface ExitContext {
  t: number;
  dt: number;
  arm: ArmId;
  lane: number;
  memory: Record<string, unknown>;
}

export interface ControllerContext {
  t: number;
  /** Индекс фазы, которая только что закончилась */
  phaseIndex: number;
  phaseCount: number;
  /** Длительности фаз из программы */
  durations: number[];
  /** Очереди по подходам (стоящие машины) */
  queues: Record<ArmId, number>;
  /** Пешеходы, ожидающие у переходов */
  pedsWaiting: number;
  memory: Record<string, unknown>;
}

/** id подходов модели в порядке объявления */
export function armIds(cfg: Pick<ModelConfig, 'arms'>): ArmId[] {
  return cfg.arms.map((a) => a.id);
}

export function armById(cfg: Pick<ModelConfig, 'arms'>, id: ArmId): ArmConfig | undefined {
  return cfg.arms.find((a) => a.id === id);
}
