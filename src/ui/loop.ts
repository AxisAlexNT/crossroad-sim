// Цикл воспроизведения: двигает симуляцию в реальном времени (с бюджетом на кадр),
// плавно интерполирует положение машин между шагами и обновляет статистику.

import { watch } from 'vue';
import { app, rebuild, refreshStats, runInteractive, simRef, toast } from './store';

type RenderFn = (alpha: number) => void;
const renderers = new Set<RenderFn>();
const slowHooks = new Set<() => void>();

export function onRender(fn: RenderFn) {
  renderers.add(fn);
  return () => renderers.delete(fn);
}

/** Вызывается ~1 раз в секунду (обновление графиков и т. п.) */
export function onSlowTick(fn: () => void) {
  slowHooks.add(fn);
  return () => slowHooks.delete(fn);
}

let last = 0;
let target = 0;
let stepAcc = 0;
let lastStats = 0;
let lastSlow = 0;
let simAtLastSlow = 0;
let realAtLastSlow = 0;
let alpha = 1;
let forceRender = true;
let frameRequest = false;
let lastDetails = 0;

export function requestRender() {
  forceRender = true;
}

/** Синхронизировать «целевое» время с симуляцией (после перемотки/пересборки) */
export function syncTarget() {
  const sim = simRef.value;
  target = sim ? sim.st.t : 0;
  alpha = 1;
  forceRender = true;
}

/** Сглаженное время работы кадра: расчёт и отрисовка, мс */
let workEma = 0;
let slowDevice = false;
let frameNo = 0;

/** Подстройка под устройство: если кадр стабильно дольше 20 мс, считаем меньше и рисуем через кадр */
function adapt(work: number) {
  workEma = workEma ? workEma * 0.95 + work * 0.05 : work;
  if (!slowDevice && workEma > 20) { slowDevice = true; }
  else if (slowDevice && workEma < 8) { slowDevice = false; }
}

function frame(now: number) {
  requestAnimationFrame(frame);
  const sim = simRef.value;
  if (!sim) return;
  const t0 = performance.now();
  frameNo++;
  const dtReal = last ? Math.min(0.1, (now - last) / 1000) : 0;
  last = now;
  let advanced = false;
  if (app.playing) {
    if (target < sim.st.t - sim.dt - 1e-6) target = sim.st.t;
    if (app.speedMode === 'seconds') target = Math.min(target + dtReal * app.speed, sim.st.t + Math.max(1, app.speed * .2));
    else stepAcc += dtReal * app.speed;
    if (!frameRequest && (app.speedMode === 'seconds' || stepAcc >= 1)) {
      frameRequest = true;
      const version = app.version;
      const seconds = app.speedMode === 'seconds';
      const details = now - lastDetails >= 1000;
      if (details) lastDetails = now;
      void runInteractive(seconds ? { type: 'advance', target: Math.max(target, sim.st.t) } : { type: 'nextPhase' }, details)
        .then(complete => {
          if (version !== app.version) return;
          if (!seconds && complete) stepAcc = Math.max(0, Math.min(3, stepAcc - 1));
          forceRender = true;
        })
        .catch(error => { if (version === app.version) { app.playing = false; toast('Расчёт остановлен. Перезапустите модель или проверьте сообщение об ошибке.'); } })
        .finally(() => { frameRequest = false; });
    }
    app.stats.lag = target - sim.st.t > Math.max(1, app.speed * .2);
    alpha = app.speedMode === 'seconds' ? Math.max(0, Math.min(1, 1 - (sim.st.t - target) / sim.dt)) : 1;
    advanced = true;
  }
  // карта рисуется, только когда видна вкладка симуляции, на медленном устройстве — через кадр
  const visible = app.tab === 'sim' && !document.hidden;
  if ((advanced || forceRender) && visible && (!slowDevice || forceRender || frameNo % 2 === 0)) {
    forceRender = false;
    for (const r of renderers) r(alpha);
  }
  if (advanced || visible) adapt(performance.now() - t0);
  if (now - lastStats > 250) {
    lastStats = now;
    refreshStats();
  }
  if (now - lastSlow > 1000) {
    const simDelta = sim.st.t - simAtLastSlow;
    const realDelta = (now - realAtLastSlow) / 1000;
    if (realAtLastSlow) app.stats.realSpeed = realDelta > 0 ? simDelta / realDelta : 0;
    simAtLastSlow = sim.st.t;
    realAtLastSlow = now;
    lastSlow = now;
    for (const h of slowHooks) h();
    app.logTick++;
  }
}

watch(() => app.version, () => syncTarget());
watch(() => app.tab, () => { forceRender = true; });

let started = false;
export function startLoop() {
  if (started) return;
  started = true;
  requestAnimationFrame(frame);
}

// --- управление временем ---

export function play() {
  syncTarget();
  app.playing = true;
}

export function pause() {
  app.playing = false;
  syncTarget();
}

type Command = Parameters<typeof runInteractive>[0];
let controls: Promise<void> = Promise.resolve();
let pendingControls = 0;
function enqueueControl(makeCommand: () => Command) {
  pause();
  if (pendingControls >= 8) { toast('Дождитесь завершения перемотки.'); return; }
  const version = app.version;
  pendingControls++;
  controls = controls.then(async () => {
    if (version !== app.version) return;
    await runInteractive({ type: 'snapshot' });
    if (version === app.version) await control(makeCommand());
  }).catch(error => { toast('Расчёт остановлен. Перезапустите модель или проверьте сообщение об ошибке.'); }).finally(() => { pendingControls--; });
}

async function control(command: Command) {
  pause();
  const version = app.version;
  try {
    let complete: boolean;
    do {
      complete = await runInteractive(command, true);
      if (version !== app.version) return;
    } while (!complete && (command.type === 'advance' || command.type === 'nextPhase'));
    syncTarget();
    refreshStats();
    for (const h of slowHooks) h();
    app.logTick++;
  } catch (error) { toast('Расчёт остановлен. Перезапустите модель или проверьте сообщение об ошибке.'); }
}

export function stepSeconds(sec: number) {
  const sim = simRef.value;
  if (!sim) return;
  enqueueControl(() => sec > 0 ? { type: 'advance', target: (simRef.value?.st.t ?? 0) + sec } : { type: 'back', seconds: -sec });
}

export function stepPhase(dir: 1 | -1) {
  enqueueControl(() => ({ type: dir > 0 ? 'nextPhase' : 'previousPhase' }));
}

export function restart() {
  rebuild(false);
  syncTarget();
  refreshStats();
  for (const h of slowHooks) h();
  app.logTick++;
}
