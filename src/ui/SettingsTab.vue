<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { app, download, exportSession, fileBase, importSession, resetModel, simRef, toast } from './store';
import { exportPdf } from './pdf';
import { DARK, LIGHT, sceneSvg } from './scene';
import { BUILTIN_NAMES, KOLPINO_ORIGIN, basemapFeatures, parseGeoJson, parseOsmXml } from './basemap';
import { kolpinoBasemap } from '../engine/presets';
import { checkFileSize } from '../engine/limits';
import { normalizeBasemap } from '../engine/model';

const fileInput = ref<HTMLInputElement | null>(null);
const pdf = reactive({ source: 'rerun' as 'current' | 'rerun', unit: 'seconds' as 'seconds' | 'steps', amount: 600, busy: false });
const svgOpt = reactive({ palette: 'light' as 'light' | 'dark', region: 'crossing' as 'crossing' | 'all', graph: true, dynamic: true });
const sim = computed(() => app.cfg.sim);

function saveJson() {
  download(`${fileBase()}-session-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`, exportSession());
}
function loadJson(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  try { checkFileSize(f.size); } catch (err) { toast('Не удалось загрузить: ' + (err as Error).message); return; }
  f.text().then((t) => {
    importSession(t)
      .then((ok) => { if (ok) toast('Сессия загружена'); })
      .catch((err: unknown) => toast('Не удалось загрузить: ' + (err instanceof Error ? err.message : String(err))));
  });
}
async function makePdf() {
  pdf.busy = true;
  try {
    await exportPdf({ source: pdf.source, unit: pdf.unit, amount: pdf.amount });
  } catch (err) {
    toast('Ошибка экспорта в PDF: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    pdf.busy = false;
  }
}
const osmInput = ref<HTMLInputElement | null>(null);
const bm = computed(() => app.cfg.basemap);
/** Выгрузка OpenStreetMap для подложки: из неё остаётся только небольшая область, но сам файл бывает большим */
const OSM_MAX_BYTES = 80 * 1024 * 1024;
function loadOsm(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  if (f.size > OSM_MAX_BYTES) {
    toast(`Файл слишком большой: ${(f.size / 1024 / 1024).toFixed(0)} МБ. Выделите на openstreetmap.org область поменьше, до ${OSM_MAX_BYTES / 1024 / 1024} МБ`);
    (e.target as HTMLInputElement).value = '';
    return;
  }
  f.text().then((t) => {
    try {
      const origin = app.cfg.basemap?.origin ?? (app.cfg.name.includes('Колпино') ? KOLPINO_ORIGIN : undefined);
      const parsed = t.trimStart().startsWith('{') ? parseGeoJson(t, origin) : parseOsmXml(t, origin);
      const map = normalizeBasemap(parsed);
      if (!map) throw new Error('в файле не нашлось объектов для подложки');
      app.cfg.basemap = map;
      app.showBasemap = true;
      toast(`Подложка загружена, объектов: ${map.features.length}`);
    } catch (err) {
      toast('Не удалось прочитать файл: ' + (err instanceof Error ? err.message : String(err)));
    }
  });
  (e.target as HTMLInputElement).value = '';
}
function dropOsm() {
  app.cfg.basemap = null;
  app.showBasemap = false;
}
const isKolpino = computed(() => app.cfg.arms.map((a) => a.id).sort().join(',') === 'E,N,S,W' && app.cfg.name.includes('Колпино'));
function useBuiltin() {
  app.cfg.basemap = kolpinoBasemap();
  app.showBasemap = true;
}
const featureCount = computed(() => (bm.value ? basemapFeatures(bm.value).length : 0));
function makeSvg() {
  const s = simRef.value;
  if (!s) return;
  const text = sceneSvg(s.net, app.cfg, {
    palette: svgOpt.palette === 'light' ? LIGHT : DARK,
    inkscape: true,
    state: svgOpt.dynamic ? s.st : null,
    graph: svgOpt.graph,
    basemap: app.showBasemap,
    region: svgOpt.region,
    mmPerMeter: 2,
  });
  download(`${fileBase()}-t${Math.round(s.st.t)}.svg`, '<?xml version="1.0" encoding="UTF-8"?>\n' + text, 'image/svg+xml');
}
</script>

<template>
  <div class="settings-tab">
    <section>
      <h3>Сессия</h3>
      <div class="row wrap gap">
        <button class="btn primary" @click="saveJson">Скачать JSON сессии</button>
        <button class="btn" @click="fileInput?.click()">Загрузить JSON сессии</button>
        <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="loadJson" />
        <button class="btn danger" @click="resetModel">Сбросить модель</button>
      </div>
      <div class="small muted">В файл попадает вся модель: дороги, полосы, связи, пешеходный граф, светофоры, автобусы, код узлов, параметры симуляции. Сессия также сохраняется в этом браузере автоматически. Файл модели отдельно скачивается во вкладке «Редактор», раздел «Файл».</div>
    </section>

    <section>
      <h3>Экспорт в PDF</h3>
      <div class="grid3">
        <label>Графики
          <select v-model="pdf.source"><option value="rerun">новый прогон с нуля</option><option value="current">текущая симуляция</option></select>
        </label>
        <label>Длина прогона
          <select v-model="pdf.unit" :disabled="pdf.source === 'current'"><option value="seconds">секунд модели</option><option value="steps">переключений фаз</option></select>
        </label>
        <label>Сколько <input v-model.number="pdf.amount" type="number" min="1" step="1" :disabled="pdf.source === 'current'" /></label>
      </div>
      <button class="btn primary" :disabled="pdf.busy" @click="makePdf">{{ pdf.busy ? 'Готовлю PDF…' : 'Экспорт в PDF' }}</button>
      <div class="small muted">Схема перекрёстка, пиктограммы и описание фаз, ленточный график, графики метрик и проверки. На каждой странице есть пометка, что это результаты ограниченного моделирования.</div>
    </section>

    <section>
      <h3>Экспорт в SVG для Inkscape</h3>
      <div class="grid3">
        <label>Оформление
          <select v-model="svgOpt.palette"><option value="light">Светлая</option><option value="dark">Тёмная</option></select>
        </label>
        <label>Область
          <select v-model="svgOpt.region"><option value="crossing">перекрёсток</option><option value="all">вся модель с подходами</option></select>
        </label>
        <label class="check"><input v-model="svgOpt.dynamic" type="checkbox" /> Текущее состояние: машины, пешеходы, сигналы</label>
        <label class="check"><input v-model="svgOpt.graph" type="checkbox" /> Слои с графом: связи полос и пешеходные рёбра</label>
      </div>
      <button class="btn primary" @click="makeSvg">Экспорт в SVG</button>
      <div class="small muted">Каждый элемент — в своём слое: подложка, края проезжей части, разделители и островки, разметка, переходы, остановки, подписи, граф, светофоры, машины, пешеходы. Масштаб 1 : 500, то есть 1 м на местности — 2 мм на схеме.</div>
    </section>

    <section>
      <h3>Оформление</h3>
      <label class="check"><input v-model="app.theme" type="radio" value="dark" /> Тёмная</label>
      <label class="check"><input v-model="app.theme" type="radio" value="light" /> Светлая</label>
      <label class="check"><input :checked="!app.bannerClosed" type="checkbox" @change="app.bannerClosed = !($event.target as HTMLInputElement).checked" /> Плашка об ограничениях модели над картой</label>
      <div class="small muted">Закрытая плашка снова появится после перезагрузки страницы.</div>
    </section>

    <section>
      <h3>Подложка OpenStreetMap</h3>
      <div class="row wrap gap">
        <button class="btn" @click="osmInput?.click()">Загрузить выгрузку .osm или GeoJSON</button>
        <input ref="osmInput" type="file" accept=".osm,.xml,.geojson,.json" hidden @change="loadOsm" />
        <label class="check"><input v-model="app.showBasemap" type="checkbox" :disabled="!bm" /> Показывать подложку</label>
        <button v-if="isKolpino && bm?.builtin !== 'kolpino'" class="btn small" @click="useBuiltin">Встроенная подложка Колпино</button>
        <button v-if="bm" class="btn danger small" @click="dropOsm">Убрать подложку</button>
      </div>
      <template v-if="bm">
        <div class="grid3">
          <label>Прозрачность: {{ Math.round(app.basemapOpacity * 100) }}% <input v-model.number="app.basemapOpacity" type="range" min="0.1" max="1" step="0.05" /></label>
          <label>Поворот, ° <input v-model.number="bm.rotation" type="number" step="0.5" /></label>
          <label>Сдвиг на восток, м <input v-model.number="bm.dx" type="number" step="0.5" /></label>
          <label>Сдвиг на север, м <input v-model.number="bm.dy" type="number" step="0.5" /></label>
          <label>Широта центра <input v-model.number="bm.origin.lat" type="number" step="0.00001" disabled /></label>
          <label>Долгота центра <input v-model.number="bm.origin.lon" type="number" step="0.00001" disabled /></label>
        </div>
        <div class="small muted">
          {{ bm.builtin ? `Источник: ${BUILTIN_NAMES[bm.builtin] ?? bm.builtin}, она встроена в файл приложения.` : 'Источник: загруженная выгрузка, она хранится в модели и сессии.' }}
          Объектов: {{ featureCount }}. Подложка работает без сети. {{ bm.attribution }}.
        </div>
      </template>
      <div class="small muted">
        По умолчанию подложка выключена. Для другого места выгрузку можно получить на openstreetmap.org: кнопка «Экспорт», область — перекрёсток и соседние улицы.
        Центр перекрёстка в модели совмещается с точкой {{ KOLPINO_ORIGIN.lat }}, {{ KOLPINO_ORIGIN.lon }}, если модель — Колпино, иначе с серединой выгрузки.
        Поворот и сдвиг помогают совместить подложку со схемой.
      </div>
    </section>

    <section>
      <h3>Водители и безопасность</h3>
      <div class="grid3">
        <label>Доля рискованных водителей: {{ Math.round(sim.riskyShare * 100) }}%
          <input v-model.number="sim.riskyShare" type="range" min="0" max="1" step="0.05" />
        </label>
        <label>Видимость при закрытом обзоре, м <input v-model.number="sim.obstructedVisibility" type="number" min="5" max="150" step="1" /></label>
        <label>Обычная видимость, м <input v-model.number="sim.normalVisibility" type="number" min="20" max="400" step="10" /></label>
        <label>Критический интервал для левого поворота, с <input v-model.number="sim.criticalGapLeft" type="number" min="2" max="10" step="0.5" /></label>
        <label>Критический интервал для остальных, с <input v-model.number="sim.criticalGapOther" type="number" min="2" max="10" step="0.5" /></label>
        <label>Порог «опасного момента» PET, с <input v-model.number="sim.petDanger" type="number" min="0.2" max="5" step="0.1" /></label>
        <label>Окно «пересечений траекторий», с <input v-model.number="sim.petWindow" type="number" min="1" max="20" step="0.5" /></label>
        <label>Порог сближения по габаритам, с <input v-model.number="sim.ttcDanger" type="number" min="0" max="3" step="0.1" /></label>
        <label class="check"><input v-model="sim.crashPersist" type="checkbox" /> Столкнувшиеся машины остаются на месте и перекрывают проезд</label>
        <label>Время до освобождения проезда после столкновения, с <input v-model.number="sim.crashDuration" type="number" min="5" step="10" /></label>
        <label>Машина не успела перестроиться до сплошной
          <select v-model="sim.missedTurn"><option value="reroute">сразу едет по разрешённому из своей полосы направлению</option><option value="wait">сначала недолго ждёт окна перед сплошной</option></select>
        </label>
        <label>Сколько ждать окна перед сплошной, с <input v-model.number="sim.lcPatience" type="number" min="0" max="60" step="1" :disabled="sim.missedTurn !== 'wait'" /></label>
      </div>
      <div class="small muted">По ПДД водитель, не успевший занять нужную полосу до сплошной линии, едет в направлении, разрешённом из своей полосы, и меняет маршрут после перекрёстка.</div>
    </section>

    <section>
      <h3>Нарушения ПДД рискованными водителями</h3>
      <div class="grid2">
        <label>Перестроение через сплошную: {{ Math.round(sim.violations.solidLine * 100) }}% <input v-model.number="sim.violations.solidLine" type="range" min="0" max="1" step="0.05" /></label>
        <label>Остановка за стоп-линией: {{ Math.round(sim.violations.stopLine * 100) }}% <input v-model.number="sim.violations.stopLine" type="range" min="0" max="1" step="0.05" /></label>
        <label>Въезд на красный в первые секунды: {{ Math.round(sim.violations.redLight * 100) }}% <input v-model.number="sim.violations.redLight" type="range" min="0" max="1" step="0.05" /></label>
        <label>Манёвр, не разрешённый разметкой: {{ Math.round(sim.violations.illegalTurn * 100) }}% <input v-model.number="sim.violations.illegalTurn" type="range" min="0" max="1" step="0.05" /></label>
      </div>
      <div class="small muted">Доля среди рискованных водителей. Остальные водители и рейсовые автобусы правила не нарушают.</div>
    </section>

    <section>
      <h3>Проверки программы</h3>
      <label class="check"><input v-model="app.draftAsError" type="checkbox" /> Нарушения положений проектов стандартов считать ошибками</label>
      <div class="small muted">
        Проверки разделены по источникам: действующие нормативы, методические рекомендации и проекты стандартов. Проект стандарта обязательной силы не имеет,
        поэтому по умолчанию его нарушения показываются как предупреждения. Действующие нормативы проверяются в любом случае.
      </div>
    </section>

    <section>
      <h3>Диагностика движения</h3>
      <div class="grid3">
        <label>Взаимная блокировка фиксируется через, с <input v-model.number="sim.deadlockSeconds" type="number" min="3" max="120" step="1" /></label>
        <label>Водители выходят из блокировки через, с <input v-model.number="sim.deadlockBreak" type="number" min="0" max="600" step="5" /></label>
        <label>Нет проезда при разрешающем сигнале, с <input v-model.number="sim.noProgressSeconds" type="number" min="20" max="900" step="10" /></label>
        <label>Окно средней скорости, с <input v-model.number="sim.slowdownWindow" type="number" min="30" max="900" step="10" /></label>
        <label>Порог падения скорости: {{ Math.round(sim.slowdownRatio * 100) }}% от обычной <input v-model.number="sim.slowdownRatio" type="range" min="0.1" max="0.9" step="0.05" /></label>
      </div>
      <div class="small muted">Если время выхода из блокировки равно нулю, машины в модели стоят, пока блокировка не разрешится сама. Предупреждение о падении скорости появляется, когда средняя скорость в окне долго держится ниже порога.</div>
    </section>

    <section>
      <div class="small muted">
        Рискованный водитель поворачивает налево, оценивая только то, что видит. Если обзор закрыт встречными левоповоротниками,
        невидимая машина может оказаться ближе, чем кажется. Осторожный водитель в такой ситуации ждёт конца фазы.
        Опасное сближение с пешеходами — когда габарит машины, продлённый вперёд на заданное время, задевает пешехода. Наезд — когда габариты пересекаются на проезжей части.
      </div>
    </section>

    <section>
      <h3>Симуляция</h3>
      <div class="grid3">
        <label>Шаг модели, с
          <select v-model.number="sim.dt"><option :value="0.05">0,05</option><option :value="0.1">0,1</option><option :value="0.2">0,2</option><option :value="0.25">0,25</option></select>
        </label>
        <label>Зерно генератора случайных чисел <input v-model.number="sim.seed" type="number" step="1" /></label>
        <label>История для перемотки назад, с <input v-model.number="sim.historySeconds" type="number" min="10" max="1800" step="10" /></label>
      </div>
      <div class="small muted">Потоки пешеходов, их скорость и группы задаются в узлах пешеходного графа: на карте режим 🚶, затем нажмите на угол. Одинаковое зерно даёт одинаковый прогон.</div>
    </section>
  </div>
</template>
