<script setup lang="ts">
import { computed, markRaw, nextTick, reactive, ref, shallowRef, watch } from 'vue';
import { app, download, fileBase, toast } from './store';
import { defaultOptSettings, OBJECTIVES, Optimizer, phaseBounds, quickOptSettings, violation, type Candidate, type Objective, type OptProgress } from '../engine/optimizer';
import { webster } from '../engine/webster';
import { compileModel, hasCustomCode } from '../engine/compile';
import { ensureSandbox, sandboxWasm } from './sandboxLoader';
import { WorkerPool } from './pool';
import OptPlot from './OptPlot.vue';
import type { PlotAxis, PlotPoint } from './optplot';

const s = reactive(defaultOptSettings(app.cfg));
watch(() => app.cfg.signals.phases.map((p) => p.id + p.duration).join(), () => {
  if (running.value) return;
  s.bounds = phaseBounds(app.cfg, s.minGreen);
});
function applyMinGreen() {
  for (const b of s.bounds) { b.min = s.minGreen; if (b.max < b.min) b.max = b.min + 10; }
}
/** Опорная оценка по формуле Вебстера для текущей модели */
const web = computed(() => { try { return webster(app.cfg, s.minGreen, s.maxCycle > 0 ? s.maxCycle : 180); } catch { return null; } });
function applyWebster() {
  const w = web.value;
  if (!w?.ok || w.durations.length !== app.cfg.signals.phases.length) return;
  app.cfg.signals.phases.forEach((p, i) => { p.duration = w.durations[i]; });
  toast('Длительности по формуле Вебстера применены к модели');
}
function quickStart() {
  const workers = s.workers;
  Object.assign(s, quickOptSettings(app.cfg), { workers });
  start();
}
const running = ref(false);
const progress = shallowRef<OptProgress | null>(null);
let opt: Optimizer | null = null;
let pool: WorkerPool | null = null;

const objList = Object.entries(OBJECTIVES) as Array<[Objective, (typeof OBJECTIVES)[Objective]]>;
function toggleObj(o: Objective, on: boolean) {
  if (on && !s.objectives.includes(o)) s.objectives.push(o);
  if (!on) s.objectives = s.objectives.filter((x) => x !== o);
}
const startViolation = computed(() => violation(app.cfg, s, app.cfg.signals.phases.map((p) => p.duration)));
const phaseNames = ref<string[]>(app.cfg.signals.phases.map((p) => p.name));

async function start() {
  if (!s.objectives.length) { toast('Выберите хотя бы одну цель'); return; }
  const { code, errors } = compileModel(app.cfg);
  if (errors.length) { toast('Сначала исправьте ошибки в коде узлов'); return; }
  const cfg = JSON.parse(JSON.stringify(app.cfg));
  const settings = JSON.parse(JSON.stringify(s));
  phaseNames.value = cfg.signals.phases.map((p: { name: string }) => p.name);
  running.value = true;
  progress.value = null;
  sortKeys.value = [];
  let wasm: Uint8Array | undefined;
  if (hasCustomCode(cfg)) {
    if (!(await ensureSandbox())) { running.value = false; toast('Песочница для пользовательского кода не запускается в этом браузере, подбор недоступен'); return; }
    wasm = await sandboxWasm();
  }
  try {
  pool = new WorkerPool(settings.workers, wasm);
  const w = settings.useWebster && web.value?.ok ? web.value.durations : null;
  opt = new Optimizer(cfg, settings, (xs, o) => Promise.all(xs.map((x) => pool!.eval({ cfg, code, durations: x, dt: settings.dt, warmup: settings.warmup, horizon: settings.simSeconds, seeds: o?.seeds ?? settings.seeds, seedBase: o?.seedBase }))), (p) => { progress.value = markRaw(p); }, w);
    await opt.run();
  } catch (e) {
    toast('Подбор остановлен: ' + (e instanceof Error ? e.message : String(e)));
  } finally {
    running.value = false;
    pool?.terminate();
    pool = null;
  }
}
/** Первое нажатие заканчивает поиск и запускает перепроверку лучших, второе прерывает всё */
function stop() {
  if (!opt) return;
  const hard = opt.inReeval || stopping.value;
  opt.stop();
  stopping.value = true;
  if (hard) pool?.terminate();
}
const stopping = ref(false);
watch(running, (r) => { if (!r) stopping.value = false; });
const stage = computed(() => progress.value?.stage ?? 'search');
const finalRows = computed(() => progress.value?.final ?? []);
function fmtFinal(c: Candidate, j: number) {
  const o = s.objectives[j];
  if (!c.final || !o) return '—';
  const sign = OBJECTIVES[o].sense === 'max' ? -1 : 1;
  const ci = c.final.ci[j];
  return `${(sign * c.final.mean[j]).toFixed(1)} ± ${Number.isFinite(ci) ? ci.toFixed(1) : '—'}`;
}
function candidateStatus(c: Candidate) {
  if (c.invalid) return `Непригодный прогон, зерно ${c.invalid.seed}: ${c.invalid.reasons.join(", ")}`;
  return c.final ? "Перепроверен" : c.summary ? "Оценён" : "Нарушены ограничения";
}
function applyCand(c: Candidate) {
  if (c.invalid) { toast(candidateStatus(c)); return; }
  if (c.x.length !== app.cfg.signals.phases.length) { toast('Программа изменилась после подбора, длительности не подходят'); return; }
  app.cfg.signals.phases.forEach((p, i) => { p.duration = c.x[i]; });
  toast('Длительности фаз применены');
  app.tab = 'sim';
}

// ---------- оси и метрики ----------
interface Metric extends PlotAxis { get: (c: Candidate) => number | undefined; digits: number }
const metrics = computed<Metric[]>(() => [
  ...phaseNames.value.map((n, i) => ({ id: `x${i}`, label: `Фаза «${n}», с`, get: (c: Candidate) => c.x[i], digits: 0 })),
  { id: 'cycle', label: 'Цикл, с', get: (c) => c.cycle, digits: 0 },
  { id: 'avgWait', label: 'Среднее ожидание, с', get: (c) => c.summary?.avgWait, digits: 1 },
  { id: 'worstWait', label: 'Ожидание на худшем подходе, с', get: (c) => c.summary?.worstWait, digits: 1 },
  { id: 'avgDelay', label: 'Средняя задержка, с', get: (c) => c.summary?.avgDelay, digits: 1 },
  { id: 'throughput', label: 'Проезды стоп-линий, авт/ч', get: (c) => c.summary?.throughputVph, digits: 0 },
  { id: 'maxQueue', label: 'Наибольшая очередь, авт', get: (c) => c.summary?.maxQueue, digits: 0 },
  { id: 'dangers', label: 'Опасные моменты', get: (c) => c.summary?.dangers, digits: 1 },
  { id: 'collisions', label: 'Столкновения в модели', get: (c) => c.summary?.collisions, digits: 1 },
  { id: 'pedWait', label: 'Ожидание пешеходов, с', get: (c) => c.summary?.pedAvgWait, digits: 1 },
  { id: 'pedDangers', label: 'Опасно для пешеходов', get: (c) => c.summary?.pedDangers, digits: 1 },
  { id: 'pedHits', label: 'Наезды на пешеходов', get: (c) => c.summary?.pedHits, digits: 1 },
  { id: 'unserved', label: 'Не въехали в модель, авт', get: (c) => c.summary?.unserved, digits: 0 },
  { id: 'deadlocks', label: 'Взаимные блокировки', get: (c) => c.summary?.deadlocks, digits: 1 },
  { id: 'violations', label: 'Нарушения ПДД', get: (c) => c.summary?.violations, digits: 1 },
  { id: 'violation', label: 'Нарушение ограничений', get: (c) => c.violation, digits: 1 },
  { id: 'gen', label: 'Поколение', get: (c) => c.gen, digits: 0 },
]);
const metricById = computed(() => new Map(metrics.value.map((m) => [m.id, m])));
const objMetric: Record<Objective, string> = { avgWait: 'avgWait', worstWait: 'worstWait', avgDelay: 'avgDelay', throughput: 'throughput', maxQueue: 'maxQueue', dangers: 'dangers', collisions: 'collisions', cycle: 'cycle', pedWait: 'pedWait', pedDangers: 'pedDangers', pedHits: 'pedHits', deadlocks: 'deadlocks' };

// уникальные кандидаты (по длительностям), последний результат главнее
const candidates = computed(() => {
  const p = progress.value;
  if (!p) return [];
  const map = new Map<string, Candidate>();
  for (const c of p.all) map.set(c.x.join(','), c);
  return [...map.values()];
});
const frontKeys = computed(() => new Set((progress.value?.best ?? []).map((c) => c.x.join(','))));

const scatter = reactive({ x: 'cycle', y: 'avgWait' });
const contour = reactive({ x: 'x0', y: 'x1', z: 'avgWait' });
watch(() => s.objectives.join(), () => {
  const a = s.objectives[0], b = s.objectives[1];
  if (a) { scatter.x = objMetric[a]; contour.z = objMetric[a]; }
  scatter.y = b ? objMetric[b] : 'cycle';
  if (!b && a) { scatter.x = 'cycle'; scatter.y = objMetric[a]; }
}, { immediate: true });

const plotPoints = computed<PlotPoint[]>(() => candidates.value.map((c) => {
  const v: Record<string, number | undefined> = {};
  for (const m of metrics.value) v[m.id] = m.get(c);
  const key = c.x.join(',');
  return {
    v, front: frontKeys.value.has(key), feasible: c.violation === 0 && !!c.summary,
    label: `Фазы ${c.x.join(' / ')} с, цикл ${c.cycle} с` + (c.summary ? `, ожидание ${c.summary.avgWait.toFixed(1)} с, ${c.summary.throughputVph.toFixed(0)} авт/ч` : ', ' + candidateStatus(c)),
  };
}));
const plotTick = ref(0);
watch(progress, () => plotTick.value++);

// ---------- таблица с сортировкой по нескольким столбцам ----------
const sortKeys = ref<Array<{ key: string; dir: 1 | -1 }>>([]);
function clickSort(key: string) {
  const list = [...sortKeys.value];
  const i = list.findIndex((k) => k.key === key);
  if (i < 0) list.push({ key, dir: 1 });
  else if (list[i].dir === 1) list[i] = { key, dir: -1 };
  else list.splice(i, 1);
  sortKeys.value = list;
}
function sortMark(key: string) {
  const i = sortKeys.value.findIndex((k) => k.key === key);
  if (i < 0) return null;
  return { arrow: sortKeys.value[i].dir === 1 ? '↑' : '↓', n: sortKeys.value.length > 1 ? i + 1 : 0 };
}
const showAll = ref(true);
const rowLimit = ref(100);
const highlight = ref('');
const tableCols = computed(() => {
  const ids = [...phaseNames.value.map((_, i) => `x${i}`), 'cycle', ...s.objectives.map((o) => objMetric[o])];
  for (const extra of ['avgWait', 'throughput', 'pedWait', 'dangers', 'pedDangers']) if (!ids.includes(extra)) ids.push(extra);
  return ids.map((id) => metricById.value.get(id)!).filter(Boolean);
});
const sortedAll = computed(() => {
  const base = showAll.value ? candidates.value : candidates.value.filter((c) => frontKeys.value.has(c.x.join(',')));
  const keys = sortKeys.value;
  const sorted = keys.length
    ? [...base].sort((a, b) => {
      for (const k of keys) {
        const m = metricById.value.get(k.key);
        if (!m) continue;
        const va = m.get(a), vb = m.get(b);
        const fa = Number.isFinite(va), fb = Number.isFinite(vb);
        if (!fa && !fb) continue;
        if (!fa) return 1;
        if (!fb) return -1;
        if (va! !== vb!) return (va! - vb!) * k.dir;
      }
      return 0;
    })
    : base;
  return sorted;
});
const rows = computed(() => sortedAll.value.slice(0, rowLimit.value));
function cell(c: Candidate, m: Metric) {
  const v = m.get(c);
  return Number.isFinite(v) ? (v as number).toFixed(m.digits) : '—';
}
function pick(i: number) {
  const c = candidates.value[i];
  if (!c) return;
  highlight.value = c.x.join(',');
  showAll.value = true;
  nextTick(() => {
    const idx = sortedAll.value.findIndex((x) => x.x.join(',') === highlight.value);
    if (idx >= rowLimit.value) rowLimit.value = idx + 20;
    nextTick(() => document.querySelector('.opt-tab tr.sel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  });
}

function exportResults() {
  const p = progress.value;
  if (!p) return;
  download(`${fileBase()}-optimization.json`, JSON.stringify({
    settings: s, objectives: s.objectives.map((o) => OBJECTIVES[o]),
    phases: phaseNames.value, evaluations: p.evaluations, generations: p.generation, elapsed: p.elapsed,
    best: p.best.map((c) => ({ durations: c.x, cycle: c.cycle, objectives: Object.fromEntries(s.objectives.map((o, i) => [o, OBJECTIVES[o].sense === 'max' ? -c.obj[i] : c.obj[i]])), summary: c.summary })),
    all: candidates.value.map((c) => ({ durations: c.x, cycle: c.cycle, violation: c.violation, generation: c.gen, status: candidateStatus(c), invalid: c.invalid, rejectedAt: c.rejectedAt, summary: c.summary })),
    final: p.final.map((c) => ({ durations: c.x, cycle: c.cycle, runs: c.final?.n, mean: c.final?.mean, ci95: c.final?.ci, summary: c.final?.summary })),
    log: p.log,
  }, null, 2));
}
function exportCsv() {
  const cols = metrics.value;
  const quote = (v: string) => '"' + v.replaceAll('"', '""') + '"';
  const lines = [[...cols.map((m) => quote(m.label)), quote('Статус')].join(';')];
  for (const c of candidates.value) lines.push([...cols.map((m) => { const v = m.get(c); return Number.isFinite(v) ? String(v) : ''; }), quote(candidateStatus(c))].join(';'));
  download(`${fileBase()}-optimization.csv`, lines.join('\n'), 'text/csv');
}
</script>

<template>
  <div class="opt-tab">
    <section>
      <h3>Цели</h3>
      <div class="grid3">
        <label v-for="[k, o] in objList" :key="k" class="check">
          <input type="checkbox" :checked="s.objectives.includes(k)" @change="toggleObj(k, ($event.target as HTMLInputElement).checked)" />
          {{ o.label }}, {{ o.sense === 'max' ? 'чем больше, тем лучше' : 'чем меньше, тем лучше' }}
        </label>
      </div>
      <div class="small muted">Для одной цели используется дифференциальная эволюция, для нескольких — NSGA-II и множество Парето. Результат подбора — варианты в рамках модели для условных потоков, а не рекомендация к применению.</div>
      <div class="row gap wrap" style="margin-top: 8px">
        <button v-if="!running" class="btn primary wrap-btn" @click="quickStart">Быстрый подбор с рекомендуемыми ограничениями</button>
        <span class="small muted">Одна цель — среднее ожидание. Фаза не короче {{ s.minGreen }} с, красный не дольше 90 с, цикл не длиннее 120 с, пешеходам хватает времени, 3 прогона на вариант и перепроверка лучших.</span>
      </div>
    </section>
    <section v-if="web">
      <h3>Опорная оценка по формуле Вебстера</h3>
      <div v-if="web.ok" class="small">
        C₀ = (1,5·L + 5) / (1 − Y) — около <b>{{ web.cycle }} с</b>, потерянное время L ≈ {{ web.lost.toFixed(0) }} с, сумма фазовых коэффициентов Y ≈ {{ web.Y.toFixed(2).replace('.', ',') }}.
        Длительности основных тактов: {{ web.durations.join(' / ') }} с.
      </div>
      <div v-else class="small bad">Формула не применима: {{ web.why }}.</div>
      <div class="small muted">Это приближение для изолированного перекрёстка по условным интенсивностям модели и потоку насыщения 1800 ед./ч на полосу прямо и 1600 ед./ч для поворотов. Пешеходов, конфликты внутри фаз и автобусы оно не учитывает, поэтому подходит как начальная точка, а не как ответ.</div>
      <div class="row gap wrap">
        <label class="check"><input v-model="s.useWebster" type="checkbox" :disabled="!web.ok" /> Добавить в начальную популяцию подбора</label>
        <button class="btn small" :disabled="!web.ok || running" @click="applyWebster">Применить к модели</button>
      </div>
    </section>
    <section>
      <h3>Что подбирать: длительности фаз в целых секундах</h3>
      <div class="row gap wrap">
        <label>Фаза не короче, с <input v-model.number="s.minGreen" type="number" min="1" max="60" step="1" style="width: 70px" /></label>
        <button class="btn small" @click="applyMinGreen">Задать для всех фаз</button>
      </div>
      <div class="table-scroll">
        <table class="tbl">
          <thead>
            <tr><th>Фаза</th><th>Подбирать</th><th>от, с</th><th>до, с</th><th>сейчас</th></tr>
          </thead>
          <tbody>
            <tr v-for="b in s.bounds" :key="b.idx">
              <td>{{ app.cfg.signals.phases[b.idx]?.name }}</td>
              <td><input v-model="b.enabled" type="checkbox" /></td>
              <td><input v-model.number="b.min" type="number" min="1" step="1" /></td>
              <td><input v-model.number="b.max" type="number" min="1" step="1" /></td>
              <td>{{ app.cfg.signals.phases[b.idx]?.duration }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section>
      <h3>Ограничения</h3>
      <div class="grid3">
        <label>Красный на любой транспортной группе не дольше, с, 0 — без ограничения <input v-model.number="s.maxRed" type="number" min="0" step="5" /></label>
        <label>Цикл не длиннее, с, 0 — без ограничения <input v-model.number="s.maxCycle" type="number" min="0" step="5" /></label>
        <label class="check"><input v-model="s.pedTime" type="checkbox" /> Пешеходам хватает времени на переход при скорости 1,2 м/с, с островком — на каждую половину</label>
        <label class="check"><input v-model="s.pedTimePlus5" type="checkbox" :disabled="!s.pedTime" /> Добавить 5 с на начало движения, B / 1,2 + 5</label>
      </div>
      <div v-if="startViolation.v > 0" class="small bad">Текущая программа нарушает ограничения: {{ startViolation.why.join(', ') }}</div>
    </section>
    <section>
      <h3>Бюджет и точность</h3>
      <div class="grid3">
        <label>Время на подбор, с <input v-model.number="s.budgetSeconds" type="number" min="5" step="5" /></label>
        <label>Секунд модели на один прогон <input v-model.number="s.simSeconds" type="number" min="60" step="60" /></label>
        <label>Разгон модели без учёта в итогах, с <input v-model.number="s.warmup" type="number" min="0" step="30" /></label>
        <label>Шаг модели, с
          <select v-model.number="s.dt"><option :value="0.1">0,1 — точнее</option><option :value="0.2">0,2</option><option :value="0.25">0,25 — быстрее</option></select>
        </label>
        <label>Прогонов с разным зерном на вариант <input v-model.number="s.seeds" type="number" min="1" max="10" step="1" /></label>
        <label>Перепроверить лучших вариантов <input v-model.number="s.reevalTop" type="number" min="0" max="20" step="1" /></label>
        <label>Новых зёрен для перепроверки <input v-model.number="s.reevalSeeds" type="number" min="0" max="20" step="1" /></label>
        <label>Популяция <input v-model.number="s.population" type="number" min="4" max="60" step="2" /></label>
        <label>Потоков вычислений <input v-model.number="s.workers" type="number" min="1" max="8" step="1" /></label>
        <label>Алгоритм
          <select v-model="s.algorithm"><option value="auto">по числу целей</option><option value="nsga2">NSGA-II</option><option value="de">дифференциальная эволюция</option></select>
        </label>
      </div>
      <div class="row gap wrap">
        <button v-if="!running" class="btn primary" @click="start">Запустить подбор</button>
        <button v-else class="btn danger" @click="stop">{{ stage === 'reeval' || stopping ? 'Прервать' : 'Остановить и перепроверить лучшие' }}</button>
        <button class="btn" :disabled="!progress" @click="exportResults">Скачать результат JSON</button>
        <button class="btn" :disabled="!progress" @click="exportCsv">Все варианты CSV</button>
      </div>
    </section>
    <section v-if="progress">
      <h3>Результаты <span class="small muted">— оценок {{ progress.evaluations }}, поколение {{ progress.generation }}, {{ progress.elapsed.toFixed(0) }} с{{ progress.done ? ', готово' : '' }}</span></h3>
      <div v-if="stage === 'reeval' && !progress.done" class="small">Идёт перепроверка лучших вариантов на новых зёрнах…</div>
      <div v-if="finalRows.length" class="final-box">
        <h4>Итог после перепроверки на новых зёрнах</h4>
        <div class="table-scroll">
          <table class="tbl">
            <thead>
              <tr><th>Длительности фаз, с</th><th>Цикл, с</th><th v-for="o in s.objectives" :key="o">{{ OBJECTIVES[o].label }}, {{ OBJECTIVES[o].unit }}</th><th>Прогонов</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="(c, i) in finalRows" :key="c.x.join(',')" :class="{ front: i === 0 }">
                <td>{{ c.x.join(' / ') }}{{ c.origin === 'start' ? ', исходная' : c.origin === 'webster' ? ', по Вебстеру' : '' }}</td>
                <td>{{ c.cycle }}</td>
                <td v-for="(o, j) in s.objectives" :key="o">{{ fmtFinal(c, j) }}</td>
                <td>{{ c.final?.n }}</td>
                <td>{{ candidateStatus(c) }}</td>
              <td><button class="btn small" :disabled="!!c.invalid" @click="applyCand(c)">Применить</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="small muted">Среднее и половина ширины 95 % доверительного интервала по новым зёрнам, все варианты на одних и тех же потоках машин и пешеходов. Варианты отсортированы по среднему. Если интервалы перекрываются, в модели эти варианты не различаются.</div>
      </div>
      <div class="opt-plots">
        <OptPlot v-model:x="scatter.x" v-model:y="scatter.y" mode="scatter" :points="plotPoints" :axes="metrics" :tick="plotTick" @pick="pick" />
        <div>
          <OptPlot v-model:x="contour.x" v-model:y="contour.y" v-model:z="contour.z" mode="contour" :points="plotPoints" :axes="metrics" :tick="plotTick" @pick="pick" />
          <div class="small muted">Цвет между точками получен интерполяцией по оценённым вариантам, а не расчётом модели.</div>
        </div>
      </div>
      <div class="row between wrap gap" style="margin-top: 8px">
        <div class="row gap small">
          <label class="check"><input v-model="showAll" type="radio" :value="true" /> все варианты: {{ candidates.length }}</label>
          <label class="check"><input v-model="showAll" type="radio" :value="false" /> только недоминируемые: {{ progress.best.length }}</label>
        </div>
        <div class="small muted">Щелчок по заголовку: по возрастанию, по убыванию, без сортировки. Несколько столбцов сортируются по порядку выбора, он показан номером у стрелки.</div>
      </div>
      <div class="table-scroll">
        <table class="tbl">
          <thead>
            <tr>
              <th v-for="m in tableCols" :key="m.id" class="sort-th" :title="m.label" @click="clickSort(m.id)">
                {{ m.label }}<span v-if="sortMark(m.id)" class="sort-mark">{{ sortMark(m.id)!.arrow }}<sup v-if="sortMark(m.id)!.n">{{ sortMark(m.id)!.n }}</sup></span>
              </th>
              <th>Статус</th><th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in rows" :key="c.x.join(',')" :class="{ 'feasible-no': c.violation > 0, front: frontKeys.has(c.x.join(',')), sel: highlight === c.x.join(',') }">
              <td v-for="m in tableCols" :key="m.id">{{ cell(c, m) }}</td>
              <td>{{ candidateStatus(c) }}</td>
              <td><button class="btn small" :disabled="!!c.invalid" @click="applyCand(c)">Применить</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <button v-if="rows.length >= rowLimit" class="btn small" @click="rowLimit += 200">Показать ещё</button>
      <pre class="opt-log">{{ progress.log.slice(-40).join('\n') }}</pre>
    </section>
  </div>
</template>
