// Цикл воспроизведения: двигает симуляцию в реальном времени (с бюджетом на кадр),
// плавно интерполирует положение машин между шагами и обновляет статистику.

import { watch } from 'vue';
import { app, rebuild, refreshStats, simRef } from './store';

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

/** Время на расчёт модели в одном кадре, мс. На медленных устройствах уменьшается само */
let frameBudget = 9;
/** Сглаженное время работы кадра: расчёт и отрисовка, мс */
let workEma = 0;
let slowDevice = false;
let frameNo = 0;

/** Подстройка под устройство: если кадр стабильно дольше 20 мс, считаем меньше и рисуем через кадр */
function adapt(work: number) {
  workEma = workEma ? workEma * 0.95 + work * 0.05 : work;
  if (!slowDevice && workEma > 20) { slowDevice = true; frameBudget = 5; }
  else if (slowDevice && workEma < 8) { slowDevice = false; frameBudget = 9; }
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
    if (app.speedMode === 'seconds') {
      target += dtReal * app.speed;
      const ok = sim.runUntil(target, frameBudget);
      if (!ok) {
        // не успеваем — сбрасываем отставание, чтобы вкладка не «залипала»
        app.stats.lag = true;
        target = sim.st.t;
      } else app.stats.lag = false;
      alpha = Math.max(0, Math.min(1, 1 - (sim.st.t - target) / sim.dt));
    } else {
      stepAcc += dtReal * app.speed;
      const t0 = performance.now();
      while (stepAcc >= 1 && performance.now() - t0 < frameBudget * 3) {
        sim.runToNextLampChange();
        stepAcc -= 1;
      }
      if (stepAcc > 3) stepAcc = 0;
      target = sim.st.t;
      alpha = 1;
    }
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

export function stepSeconds(sec: number) {
  const sim = simRef.value;
  if (!sim) return;
  if (sec > 0) sim.runUntil(sim.st.t + sec);
  else sim.back(-sec);
  syncTarget();
  refreshStats();
  for (const h of slowHooks) h();
  app.logTick++;
}

export function stepPhase(dir: 1 | -1) {
  const sim = simRef.value;
  if (!sim) return;
  if (dir > 0) sim.runToNextLampChange();
  else sim.backToPrevLampChange();
  syncTarget();
  refreshStats();
  for (const h of slowHooks) h();
  app.logTick++;
}

export function restart() {
  rebuild(false);
  syncTarget();
  refreshStats();
  for (const h of slowHooks) h();
  app.logTick++;
}
