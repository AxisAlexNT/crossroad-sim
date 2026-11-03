// Состояние приложения и управление симуляцией (пересборка модели, воспроизведение, перемотка).

import { migrationLabels } from './migrationText';
import { markRaw, reactive, shallowRef, watch } from 'vue';
import type { ArmId, ModelConfig } from '../engine/types';
import { DEFAULT_PRESET, defaultModel, kolpinoModel, applyMarkings, markingsFor, PRESETS } from '../engine/presets';
import { genConnections, genPedGraph, reconcile } from '../engine/generate';
import { compileModel, customCodeNodes, hasCustomCode } from '../engine/compile';
import { sandboxFailure, sandboxReady } from '../engine/sandbox';
import { InteractiveClient } from './interactiveClient';
import type { InteractiveCommand } from '../engine/interactiveRuntime';
import { sandboxWasm, ensureSandbox } from './sandboxLoader';
import { Simulation } from '../engine/sim';
import { runChecks, type CheckResult } from '../engine/checks';
import { genControllerCode, genExitCode, genLaneChooserCode, genSpawnerCode } from '../engine/codegen';
import { armLabel } from '../engine/generate';
import { normalizeModel, serializeModel } from '../engine/model';
import { checkFileSize } from '../engine/limits';
import { migrateSession, serializeSession, type Preferences } from '../engine/session';

export type TabId = 'sim' | 'editor' | 'events' | 'charts' | 'opt' | 'settings' | 'about';

export type Selection =
  | { kind: 'spawner'; arm: ArmId }
  | { kind: 'lanes'; arm: ArmId }
  | { kind: 'exit'; arm: ArmId }
  | { kind: 'arm'; arm: ArmId }
  | { kind: 'conn'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'vehicle'; id: number }
  | { kind: 'ped'; id: number }
  | { kind: 'pednode'; id: string }
  | { kind: 'pededge'; id: string }
  | { kind: 'stop'; id: string }
  | { kind: 'route'; id: string }
  | { kind: 'controller' };

const STORAGE_KEY = 'crossroad-sim-session-v2';
const OLD_STORAGE_KEY = 'crossroad-sim-session-v1';

let storageProtected = false;
let storageIssue = '';
let storageWarnings: string[] = [];
let pendingOriginal: string | null = null;
function loadSaved(): { cfg: ModelConfig | null; presetId?: string } & Preferences {
  for (const key of [STORAGE_KEY, OLD_STORAGE_KEY, STORAGE_KEY + '-last-good']) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      pendingOriginal = raw;
      const loaded = migrateSession(JSON.parse(raw));
      // Сохраняем исходную запись до любых автоматических преобразований.
      try {
        if (loaded.report.warnings.length || !localStorage.getItem(STORAGE_KEY + '-original')) localStorage.setItem(STORAGE_KEY + '-original', raw);
      } catch {
        storageProtected = true;
        storageIssue = 'Не удалось сохранить резервную копию в браузере. Модель открыта; скачайте исходный файл перед продолжением.';
      }
      if (loaded.report.warnings.length) {
        storageProtected = true;
        storageWarnings = migrationLabels(loaded.report.warnings);
        if (!storageIssue) storageIssue = 'Некоторые настройки сохранения обновлены.';
      }
      return { cfg: loaded.cfg, presetId: loaded.presetId, ...loaded.preferences };
    } catch {
      storageProtected = true;
      storageIssue = 'Не удалось полностью восстановить сохранение. Исходная запись не перезаписана. Можно открыть файл сессии.';
    }
  }
  return { cfg: null };
}

const saved = loadSaved();
const initialConfig = saved.cfg ?? defaultModel(DEFAULT_PRESET);
if (!saved.cfg) initialConfig.sim.mode = 'visual';

export const app = reactive({
  tab: 'sim' as TabId,
  detailedSettings: false,
  storageIssue,
  storageWarnings,
  migrationOpen: storageProtected,
  autosavePaused: storageProtected,
  showTimers: saved.showTimers ?? false,
  theme: (saved.theme ?? 'dark') as 'dark' | 'light',
  cfg: initialConfig as ModelConfig,
  presetId: saved.presetId ?? DEFAULT_PRESET,
  /** Нарушения положений проектов стандартов считать ошибками */
  draftAsError: saved.draftAsError ?? false,
  /** Плашка об ограничениях закрывается до перезагрузки страницы, после неё появляется снова */
  bannerClosed: false,
  /** подсказка «как начать» скрывается по крестику или после перехода на вкладку «Графики» */
  hintClosed: false,
  /** Раздел вкладки «О модели», к которому нужно перейти */
  aboutAnchor: '',
  compileErrors: [] as string[],
  selected: null as Selection | null,
  /** что редактируется на карте: связи полос или пешеходный граф. При открытии — просмотр */
  editMode: false,
  editLayer: 'veh' as 'veh' | 'ped',
  /** показывать граф: связи полос и пешеходные рёбра */
  showGraph: true,
  /** точки конфликтов: не показывать, все, только возможные при текущих сигналах */
  conflictMode: 'off' as 'off' | 'all' | 'current',
  /** подложка OpenStreetMap */
  showBasemap: false,
  basemapOpacity: 0.85,
  playing: false,
  speedMode: 'seconds' as 'seconds' | 'steps',
  speed: 1,
  checks: [] as CheckResult[],
  /** увеличивается при пересборке симуляции */
  version: 0,
  /** обновляется ~4 раза в секунду */
  stats: {
    t: 0,
    phase: '',
    segment: '',
    segLeft: 0,
    vehicles: 0,
    crossed: 0,
    exited: 0,
    errors: 0,
    dangers: 0,
    crossings: 0,
    collisions: 0,
    avgWait: 0,
    throughput: 0,
    maxQueue: 0,
    peds: 0,
    pedDone: 0,
    pedWait: 0,
    pedDangers: 0,
    pedHits: 0,
    violations: 0,
    missed: 0,
    buses: 0,
    busServed: 0,
    deadlock: '',
    deadlockSince: 0,
    stall: '',
    slow: '',
    lag: false,
    realSpeed: 0,
    cycleT: 0,
  },
  statTick: 0,
  logTick: 0,
  highlightVid: -1,
  toast: '' as string,
  interactiveError: '',
  interactiveErrorDetails: '',
});

export const simRef = shallowRef<Simulation | null>(null);

let interactiveClient: InteractiveClient | null = null;
let interactiveEpoch = 0;
let interactiveChain: Promise<unknown> = Promise.resolve();
let interactiveQueued = 0;

/** Команды сериализуются; ответы прежней модели после пересборки отбрасываются. */
export function runInteractive(command: InteractiveCommand, details = false): Promise<boolean> {
  const epoch = interactiveEpoch;
  if (interactiveQueued >= 8) return Promise.reject(new Error('Дождитесь завершения команды управления временем.'));
  interactiveQueued++;
  const task = interactiveChain.then(async () => {
    if (epoch !== interactiveEpoch) return false;
    const client = interactiveClient;
    if (!client) throw new Error('Фоновая модель ещё не готова.');
    const frame = await client.request(command, details);
    if (epoch !== interactiveEpoch || !frame) return false;
    simRef.value?.acceptFrame(frame);
    refreshStats();
    if (frame.details) app.logTick++;
    return frame.complete;
  }).catch(error => {
    if (epoch === interactiveEpoch) {
      app.playing = false;
      app.interactiveErrorDetails = error instanceof Error ? error.message : String(error);
      app.interactiveError = 'Не удалось продолжить расчёт. Перезапустите модель. Если ошибка повторится, сохраните сессию для проверки.';
    }
    throw error;
  });
  interactiveChain = task.catch(() => {});
  return task.finally(() => { interactiveQueued--; });
}

function startInteractive(cfg: ModelConfig, target: number) {
  const epoch = ++interactiveEpoch;
  app.interactiveError = '';
  app.interactiveErrorDetails = '';
  interactiveClient?.dispose();
  interactiveClient = null;
  interactiveChain = (async () => {
    const wasm = hasCustomCode(cfg) ? (await sandboxWasm()).slice().buffer : undefined;
    if (epoch !== interactiveEpoch) return;
    const client = new InteractiveClient(wasm);
    interactiveClient = client;
    let frame = await client.request({ type: 'init', cfg }, true);
    if (epoch !== interactiveEpoch || !frame) return;
    simRef.value?.acceptFrame(frame);
    while (frame.state.t < target) {
      frame = await client.request({ type: 'advance', target }, false);
      if (epoch !== interactiveEpoch || !frame) return;
      simRef.value?.acceptFrame(frame);
    }
    if (target > 0) {
      frame = await client.request({ type: 'snapshot' }, true);
      if (epoch !== interactiveEpoch || !frame) return;
      simRef.value?.acceptFrame(frame);
    }
    refreshStats();
    app.logTick++;
  })().catch(error => {
    if (epoch !== interactiveEpoch) return;
    app.playing = false;
    app.interactiveErrorDetails = error instanceof Error ? error.message : String(error);
      app.interactiveError = 'Не удалось продолжить расчёт. Перезапустите модель. Если ошибка повторится, сохраните сессию для проверки.';
    toast('Фоновый расчёт остановлен. Подробности доступны в сообщении над моделью.');
  });
}

/** Предустановки светофорных программ подходят только к модели с такими же группами и подходами */
export function presetsApplicable(cfg: ModelConfig = app.cfg): boolean {
  const ids = cfg.arms.map((a) => a.id).sort().join(',');
  return ids === 'E,N,S,W' && cfg.peds.edges.some((e) => e.id === 'IW~NW');
}

export function toast(msg: string) {
  app.toast = msg;
  setTimeout(() => { if (app.toast === msg) app.toast = ''; }, 3500);
}

let sandboxWait = false;

export function rebuild(keepTime = false) {
  // код, изменённый вручную, работает в песочнице: она загружается по требованию, затем модель пересобирается
  if (hasCustomCode(app.cfg) && !sandboxReady() && !sandboxFailure()) {
    if (!sandboxWait) {
      sandboxWait = true;
      void ensureSandbox().then(() => { sandboxWait = false; rebuild(keepTime); });
    }
  }
  const { code, errors } = compileModel(app.cfg);
  app.compileErrors = errors;
  const prevT = simRef.value?.st.t ?? 0;
  let sim: Simulation;
  try {
    sim = markRaw(new Simulation(JSON.parse(JSON.stringify(app.cfg)) as ModelConfig, code));
  } catch (e) {
    toast('Не удалось подготовить модель. Проверьте настройки и код узлов в редакторе.');
    return;
  }
  for (const e of errors) sim.addLog('error', 'compile', e);
  simRef.value?.dispose();
  simRef.value = sim;
  startInteractive(JSON.parse(JSON.stringify(app.cfg)) as ModelConfig, keepTime ? Math.min(prevT, 600) : 0);
  try { app.checks = runChecks(app.cfg, { draftAsError: app.draftAsError }); } catch { app.checks = []; }
  app.version++;
  app.logTick++;
  refreshStats();
}

export function refreshStats() {
  const sim = simRef.value;
  if (!sim) return;
  const st = sim.st;
  const s = app.stats;
  s.t = st.t;
  const ph = sim.cfg.signals.phases[st.sig.phaseIdx];
  const nx = sim.cfg.signals.phases[st.sig.nextIdx];
  s.phase = ph ? ph.name : '—';
  s.segment = st.sig.segment === 'main' ? 'основной такт' : `промтакт → ${nx?.name ?? ''}`;
  s.segLeft = Math.max(0, st.sig.segStart + st.sig.segDur - st.t);
  s.vehicles = st.vehicles.length;
  s.crossed = st.counters.crossedStop;
  s.exited = st.counters.exited;
  s.errors = st.counters.errors;
  s.dangers = st.counters.dangers;
  s.crossings = st.counters.crossings;
  s.collisions = st.counters.collisions;
  const se = sim.series;
  s.avgWait = Number.isFinite(se.avgWait[se.avgWait.length - 1]) ? se.avgWait[se.avgWait.length - 1] : 0;
  s.throughput = se.throughput[se.throughput.length - 1] ?? 0;
  s.maxQueue = st.maxQueue;
  s.peds = st.peds.reduce((a, p) => a + p.size, 0);
  s.pedDone = st.counters.pedDone;
  s.pedWait = Number.isFinite(se.pedWait[se.pedWait.length - 1]) ? se.pedWait[se.pedWait.length - 1] : 0;
  s.pedDangers = st.counters.pedDangers;
  s.pedHits = st.counters.pedHits;
  const c = st.counters;
  s.violations = c.violSolid + c.violStop + c.violRed + c.violTurn;
  s.missed = c.missedTurns;
  s.buses = st.vehicles.filter((v) => v.route).length;
  s.busServed = c.busServed;
  const d = st.status.deadlock;
  s.deadlock = d ? `${d.movements.slice(0, 3).join(', ')}${d.movements.length > 3 ? ` и ещё ${d.movements.length - 3}` : ''}` : '';
  s.deadlockSince = d ? d.since : 0;
  s.stall = st.status.stall.map((x) => x.label).join(', ');
  s.slow = st.status.slow.map((x) => x.label).join(', ');
  app.statTick++;
}

let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let suppress = false;

export function withoutRebuild(fn: () => void) {
  suppress = true;
  fn();
  setTimeout(() => { suppress = false; }, 0);
}

watch(
  () => app.cfg,
  () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSession, 600);
    if (suppress) return;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      const wasT = simRef.value?.st.t ?? 0;
      rebuild(false);
      if (wasT > 1) toast('Модель изменена, симуляция начата заново');
    }, 300);
  },
  { deep: true },
);

watch(() => app.showTimers, saveSession);
watch(() => app.theme, () => { saveSession(); applyTheme(); });
watch(() => app.draftAsError, () => {
  saveSession();
  try { app.checks = runChecks(app.cfg, { draftAsError: app.draftAsError }); } catch { app.checks = []; }
});

export function applyTheme() {
  document.documentElement.dataset.theme = app.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', app.theme === 'dark' ? '#000000' : '#ffffff');
}

export function saveSession() {
  if (storageProtected) return;
  try {
    const text = exportSession();
    const previous = localStorage.getItem(STORAGE_KEY);
    if (previous) { migrateSession(JSON.parse(previous)); localStorage.setItem(STORAGE_KEY + '-last-good', previous); }
    localStorage.setItem(STORAGE_KEY, text);
    app.storageIssue = '';
    app.autosavePaused = false;
  } catch {
    app.autosavePaused = true;
    app.storageIssue = 'Не удалось сохранить настройки в браузере. Скачайте файл сессии для сохранения изменений.';
  }
}

export function exportSavedOriginal() {
  try {
    const text = (app.autosavePaused ? pendingOriginal : null) ?? localStorage.getItem(STORAGE_KEY + '-original') ?? localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(OLD_STORAGE_KEY);
    if (text) download('session-original.json', text, 'application/json');
    else toast('Исходное сохранение недоступно');
  } catch { toast('Хранилище браузера недоступно'); }
}

export function resumeSaving() {
  try {
    const current = pendingOriginal ?? localStorage.getItem(STORAGE_KEY);
    if (current && current !== localStorage.getItem(STORAGE_KEY + '-original')) localStorage.setItem(STORAGE_KEY + '-original', current);
    localStorage.setItem(STORAGE_KEY, exportSession());
    pendingOriginal = null;
    storageProtected = false;
    app.autosavePaused = false;
    app.migrationOpen = false;
    app.storageIssue = '';
    toast('Изменения приняты. Автосохранение включено');
  } catch {
    storageProtected = true; app.autosavePaused = true; app.migrationOpen = true;
    app.storageIssue = 'Не удалось включить автосохранение. Исходная запись не перезаписана; скачайте исходный файл и повторите попытку.';
  }
}

export function useDefaultSavedModel() {
  app.cfg = defaultModel(DEFAULT_PRESET);
  app.cfg.sim.mode = 'visual';
  app.presetId = DEFAULT_PRESET;
  app.selected = null;
  resumeSaving();
}

export async function restoreSavedOriginal() {
  try {
    const original = localStorage.getItem(STORAGE_KEY + '-original');
    if (!original) { toast('Исходное сохранение недоступно'); return; }
    await importSession(original);
  } catch { toast('Исходное сохранение не удалось открыть. Его можно скачать и сохранить отдельно.'); }
}

export function applyPreset(id: string) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return;
  if (id === 'worked') {
    const mode = app.cfg.sim.mode;
    app.cfg = kolpinoModel(id); app.cfg.sim.mode = mode;
    app.presetId = id; app.selected = null;
    toast('Модель загружена; режим расчёта сохранён'); return;
  }
  if (!presetsApplicable()) { toast('Предустановки рассчитаны на модель Оборонная / Тверская'); return; }
  app.presetId = id;
  app.cfg.signals = p.signals();
  app.selected = null;
  toast(`Загружена программа «${p.name}»`);
}

/**
 * Загрузить предустановку частично: только светофорную программу, только разметку (разрешённые направления и пешеходный граф)
 * или всю модель целиком.
 */
export function loadPresetPart(id: string, part: 'all' | 'signals' | 'markings', cfg: ModelConfig = app.cfg): ModelConfig | null {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return null;
  if (part === 'all') {
    const m = kolpinoModel(id);
    if (id !== 'worked') m.sim = JSON.parse(JSON.stringify(cfg.sim));
    else m.sim.mode = cfg.sim.mode;
    return m;
  }
  if (part === 'signals') {
    if (!presetsApplicable(cfg)) { toast('Программа рассчитана на модель Оборонная / Тверская'); return null; }
    cfg.signals = p.signals();
    return cfg;
  }
  resetGraph(cfg);
  return cfg;
}

/** Вернуть граф к исходному виду: разметку модели по умолчанию или типовую разметку по подходам */
export function resetGraph(cfg: ModelConfig = app.cfg) {
  const m = markingsFor(cfg) ?? { connections: genConnections(cfg.arms), peds: genPedGraph(cfg.arms) };
  applyMarkings(cfg, m);
}

export function resetModel() {
  const mode = app.cfg.sim.mode;
  app.cfg = defaultModel(app.presetId);
  app.cfg.sim.mode = mode;
  app.selected = null;
  toast('Модель сброшена к исходной');
}

/** Заменить модель целиком (шаблон, импорт) */
export function loadModel(cfg: ModelConfig, msg?: string) {
  app.cfg = cfg;
  app.selected = null;
  if (msg) toast(msg);
}

/** Перегенерировать код узлов из параметров (если код не правили вручную) */
export function regenNode(kind: 'spawner' | 'lanes' | 'exit', arm: ArmId, force = false, cfg: ModelConfig = app.cfg) {
  const a = cfg.arms.find((x) => x.id === arm);
  if (!a) return;
  if (kind === 'spawner') {
    const n = cfg.spawners[arm];
    if (!n || (n.manual && !force)) return;
    n.code = genSpawnerCode(armLabel(a), n.params);
    n.manual = false;
  } else if (kind === 'lanes') {
    const n = cfg.laneChoosers[arm];
    if (!n || (n.manual && !force)) return;
    n.code = genLaneChooserCode(armLabel(a), n.params, a.inLanes);
    n.manual = false;
  } else {
    const n = cfg.exits[arm];
    if (!n || (n.manual && !force)) return;
    n.code = genExitCode(armLabel(a), n.params);
    n.manual = false;
  }
}

export function regenController(cfg: ModelConfig = app.cfg) {
  cfg.signals.code = genControllerCode(cfg.signals);
}

/** Сессия: модель и выбранная предустановка */
export function exportSession(): string {
  return serializeSession(app.cfg, app.presetId, { theme: app.theme, draftAsError: app.draftAsError, showTimers: app.showTimers });
}

/** Загрузить сессию из файла. false — пользователь отказался */
export async function importSession(text: string): Promise<boolean> {
  checkFileSize(new TextEncoder().encode(text).length);
  const data = JSON.parse(text) as unknown;
  const loaded = migrateSession(data);
  if (loaded.report.warnings.length) {
    let choice: string;
    do {
      choice = await ask('Сохранение обновлено', 'Модель можно открыть. Несколько настроек пришлось изменить для этой версии программы.', migrationLabels(loaded.report.warnings),
        [{ id: 'load', label: 'Продолжить', kind: 'primary' }, { id: 'download', label: 'Скачать исходный файл' }, { id: 'default', label: 'Открыть модель по умолчанию' }]);
      if (choice === 'download') download('исходная-сессия.json', text, 'application/json');
    } while (choice === 'download');
    if (choice === 'default') { useDefaultSavedModel(); return false; }
    if (choice !== 'load') return false;
  }
  const cfg = await vetCustomCode(loaded.cfg);
  if (!cfg) return false;
  const compiled = compileModel(cfg);
  if (compiled.errors.length) throw new Error(compiled.errors.join('\n'));
  pendingOriginal = text;
  storageProtected = true; app.autosavePaused = true;
  app.storageWarnings = migrationLabels(loaded.report.warnings);
  app.cfg = cfg;
  app.presetId = loaded.presetId && PRESETS.some((p) => p.id === loaded.presetId) ? loaded.presetId : 'custom';
  Object.assign(app, loaded.preferences);
  app.selected = null;
  resumeSaving();
  return true;
}

// ---------- окно подтверждения ----------

export interface DialogButton { id: string; label: string; kind?: 'primary' | 'danger' }
export const dialog = reactive({
  open: false, title: '', text: '', items: [] as string[], buttons: [] as DialogButton[],
  resolve: null as null | ((id: string) => void),
});

export function ask(title: string, text: string, items: string[], buttons: DialogButton[]): Promise<string> {
  dialog.resolve?.('cancel');
  return new Promise((resolve) => {
    Object.assign(dialog, { open: true, title, text, items, buttons, resolve: (id: string) => { dialog.open = false; dialog.resolve = null; resolve(id); } });
  });
}

/** Перевести все узлы на параметры и выключить код контроллера */
export function stripCustomCode(cfg: ModelConfig): ModelConfig {
  for (const rec of [cfg.spawners, cfg.laneChoosers, cfg.exits]) for (const n of Object.values(rec)) n.manual = false;
  cfg.signals.controller = 'fixed';
  cfg.signals.code = genControllerCode(cfg.signals);
  return reconcile(cfg);
}

/**
 * Модель из файла с пользовательским кодом: спросить, запускать ли его.
 * null — загрузку отменили
 */
export async function vetCustomCode(cfg: ModelConfig): Promise<ModelConfig | null> {
  const nodes = customCodeNodes(cfg);
  if (!nodes.length) return cfg;
  const r = await ask(
    'В файле есть пользовательский код',
    'Код выполняется в изолированной песочнице: без доступа к странице, сети, файлам и хранилищу браузера, с ограничением времени и памяти. ' +
      'Всё равно запускайте его, только если доверяете источнику файла. Без кода эти узлы будут работать по своим параметрам.',
    nodes,
    [{ id: 'keep', label: 'Загрузить с кодом', kind: 'primary' }, { id: 'strip', label: 'Загрузить без кода' }, { id: 'cancel', label: 'Отмена' }],
  );
  if (r === 'cancel') return null;
  return r === 'strip' ? stripCustomCode(cfg) : cfg;
}

export function armName(id: ArmId, cfg: ModelConfig = app.cfg): string {
  return cfg.arms.find((a) => a.id === id)?.short ?? id;
}

export function download(name: string, content: string | Blob, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Имя файла по названию модели (латиница не обязательна, браузеры понимают кириллицу) */
export function fileBase(): string {
  const n = app.cfg.name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return n || 'perekrestok';
}

// подсказка «как начать» больше не нужна, когда человек дошёл до графиков
watch(() => app.tab, (t) => { if (t === 'charts') app.hintClosed = true; });
