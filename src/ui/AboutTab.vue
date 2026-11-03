<script setup lang="ts">
import { nextTick, onMounted, watch } from 'vue';
import { SOURCES, ASSUMPTIONS, ASSUMPTIONS_INTRO, SOURCE_KIND_NAME, type SourceKind } from '../engine/sources';
import { app } from './store';
import licensesText from '../../THIRD_PARTY_LICENSES.txt?raw';
import changelogText from '../../CHANGELOG.MD?raw';

const LIBS = [
  ['Vue 3', 'MIT', 'https://github.com/vuejs/core'],
  ['uPlot', 'MIT', 'https://github.com/leeoniya/uPlot'],
  ['CodeMirror 6', 'MIT', 'https://codemirror.net/'],
  ['sucrase', 'MIT', 'https://github.com/alangpierce/sucrase'],
  ['jsPDF', 'MIT', 'https://github.com/parallax/jsPDF'],
  ['svg2pdf.js', 'MIT', 'https://github.com/yWorks/svg2pdf.js'],
  ['fflate', 'MIT', 'https://github.com/101arrowz/fflate'],
  ['QuickJS и quickjs-emscripten', 'MIT', 'https://github.com/justjake/quickjs-emscripten'],
  ['Шрифт Inter', 'SIL Open Font License 1.1', 'https://github.com/rsms/inter'],
  ['Шрифт DejaVu Sans для PDF', 'Bitstream Vera / DejaVu license', 'https://dejavu-fonts.github.io/License.html'],
];
const KINDS: SourceKind[] = ['norm', 'method', 'draft', 'data', 'science'];
const byKind = (k: SourceKind) => SOURCES.filter((s) => s.kind === k);

/** Переход к разделу по ссылке из плашки на вкладке симуляции */
function scrollToAnchor() {
  if (!app.aboutAnchor) return;
  const id = app.aboutAnchor;
  app.aboutAnchor = '';
  void nextTick(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
}
onMounted(scrollToAnchor);
watch(() => app.aboutAnchor, scrollToAnchor);
</script>

<template>
  <div class="about-tab">
    <section id="limits">
      <h3>Допущения и ограничения модели</h3>
      <p class="small">{{ ASSUMPTIONS_INTRO }}</p>
      <ul>
        <li v-for="(a, i) in ASSUMPTIONS" :key="i" class="small">{{ a }}</li>
      </ul>
    </section>
    <section>
      <h3>Как устроена модель</h3>
      <p class="small">
        Перекрёсток описывается в формате JSON «crossroad-model»: подходы под любыми углами, полосы, разрешённые направления,
        пешеходный граф, сигнальные группы и фазы, остановки и автобусные маршруты, узлы появления машин, перестроения и выезда. Схему можно собрать во вкладке «Редактор» из шаблона или с нуля.
      </p>
      <p class="small">
        Машины едут по траекториям: полосы подхода, кривые манёвров внутри перекрёстка, полосы выезда. Скорость задаёт модель следования за лидером IDM.
        До начала сплошной линии машины перестраиваются в нужную полосу. Кто не успел, едет в направлении, разрешённом из своей полосы, как требуют ПДД.
        У стоп-линии стоит светофор с фазами и промтактами: мигающий зелёный, жёлтый, красный с жёлтым. Внутри перекрёстка машины уступают по ПДД.
        При повороте налево уступают встречным. Водитель, который едет по стрелке допсекции при красном или жёлтом основном сигнале, уступает транспортным средствам с других направлений.
        Завершающие проезд имеют приоритет, на перекрёсток при заторе не выезжают. Стоящие в перекрёстке левоповоротники закрывают встречным обзор прямого потока.
      </p>
      <p class="small">
        Рейсовые автобусы появляются по маршрутам, подъезжают к остановкам, стоят от одной до полутора минут и уезжают. Из заездного кармана автобус выезжает, а едущие сзади его пропускают.
        Пешеходы появляются на углах группами от одного до четырёх человек, идут по графу переходов и ждут разрешающего сигнала у бордюра и на островке.
      </p>
      <p class="small">
        Опасные моменты считаются по времени между проездами двух машин через точку пересечения траекторий и по сближению габаритов, продлённых вперёд.
        Столкновения и наезды — по пересечению габаритов. Модель отслеживает взаимную блокировку, когда машины ждут друг друга по кругу,
        отсутствие проезда при разрешающем сигнале и падение средней скорости. Подбор фаз ищет длительности в целых секундах по выбранным критериям в рамках модели.
        Найденные варианты показывают компромиссы между критериями и не являются рекомендацией.
      </p>
      <p class="small">
        Узлы без ручных правок работают встроенной логикой по своим параметрам. Код TypeScript, изменённый вручную, выполняется в изолированной песочнице:
        отдельном интерпретаторе JavaScript без доступа к странице, сети, файлам и хранилищу браузера, с ограничением времени и памяти.
        При загрузке файла с таким кодом приложение спрашивает, запускать ли его.
      </p>
    </section>
    <section class="ai-note">
      <h3>Об использовании ИИ</h3>
      <p class="small">
        При создании модели и приложения использовались технологии ИИ-агентов. Код, расчёты, тексты и ссылки на документы могут содержать ошибки,
        поэтому их нужно проверять. Результаты модели нельзя использовать как единственный аргумент или доказательство.
        Это инструмент для экспериментов и сравнения вариантов, а не замер, не заключение и не исследование.
      </p>
    </section>
    <section>
      <h3>Нормативные документы и данные</h3>
      <p class="small muted">
        Действующие нормативы, методические рекомендации и проекты стандартов разделены. Рекомендации и проекты обязательной силы не имеют.
        Перед выводами статус документов стоит проверить по официальным источникам.
      </p>
      <template v-for="k in KINDS" :key="k">
        <h4 v-if="byKind(k).length">{{ SOURCE_KIND_NAME[k] }}</h4>
        <ol class="sources">
          <li v-for="s in byKind(k)" :key="s.id">
            <a :href="s.url" target="_blank" rel="noopener">{{ s.title }}</a>
            <div class="small muted">{{ s.publisher }}</div>
            <div class="small">Используется: {{ s.usedFor }}</div>
          </li>
        </ol>
      </template>
    </section>
    <section id="licenses">
      <h3>Библиотеки</h3>
      <p class="small muted">Все библиотеки и шрифты встроены в файл и работают без интернета.</p>
      <ul>
        <li v-for="l in LIBS" :key="l[0]" class="small"><a :href="l[2]" target="_blank" rel="noopener">{{ l[0] }}</a> — {{ l[1] }}</li>
      </ul>
      <details class="licenses">
        <summary>Полные тексты лицензий сторонних компонентов</summary>
        <pre>{{ licensesText }}</pre>
      </details>
    </section>
    <section id="changelog">
      <h3 id="changelog-title">История изменений</h3>
      <pre class="changelog-text" role="region" aria-labelledby="changelog-title" tabindex="0">{{ changelogText }}</pre>
    </section>
  </div>
</template>
