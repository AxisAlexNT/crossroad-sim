<script setup lang="ts">
import { computed, ref } from 'vue';
import { app, simRef, download, fileBase } from './store';
import { SOURCES, SOURCE_KIND_TAG } from '../engine/sources';

const level = ref<'all' | 'error' | 'warn' | 'info'>('all');
const q = ref('');
const limit = ref(300);
const srcById = new Map(SOURCES.map((s) => [s.id, s]));
const LEVEL = { error: 'Ошибка', warn: 'Предупреждение', info: 'Сведения' } as const;

const checks = computed(() => app.checks);
const counts = computed(() => ({
  error: checks.value.filter((c) => c.level === 'error').length,
  warn: checks.value.filter((c) => c.level === 'warn').length,
  info: checks.value.filter((c) => c.level === 'info').length,
}));
const log = computed(() => {
  void app.logTick;
  const all = simRef.value?.log ?? [];
  const f = all.filter((e) => (level.value === 'all' || e.level === level.value) && (!q.value || (e.msg + (e.detail ?? '')).toLowerCase().includes(q.value.toLowerCase())));
  return f.slice(-limit.value).reverse();
});
const totals = computed(() => { void app.logTick; return simRef.value?.logCounts ?? {}; });
const CODE_NAMES: Record<string, string> = {
  crash: 'столкновения', ttc: 'опасные сближения', pet: 'опасные моменты', lane: 'ошибки выбора полосы', route: 'нет пути',
  gridlock: 'долго стоят в перекрёстке', 'forced-lc': 'ждали окна для перестроения', amber: 'въезд на жёлтый', reroute: 'поехали в другую сторону', code: 'ошибки кода', compile: 'компиляция', 'crash-clear': 'проезд освобождён', overflow: 'переполнение очереди',
  'ped-hit': 'наезды на пешеходов', 'ped-danger': 'опасно для пешеходов', 'ped-route': 'нет пути для пешеходов',
  'missed-turn': 'не успели перестроиться', 'viol-solid': 'перестроение через сплошную', 'viol-stop': 'остановка за стоп-линией', 'viol-red': 'въезд на красный', 'viol-turn': 'манёвр не по разметке',
  deadlock: 'взаимная блокировка', 'deadlock-end': 'блокировка закончилась', 'deadlock-manual': 'выезд из блокировки вручную', stall: 'нет проезда', 'stall-end': 'проезд возобновился', slow: 'скорость падает', 'slow-end': 'скорость восстановилась',
};

function show(vid?: number) {
  if (vid === undefined) return;
  app.selected = { kind: 'vehicle', id: vid };
  app.highlightVid = vid;
  app.tab = 'sim';
}
function exportLog() {
  const rows = ['t;уровень;код;сообщение;подробности'];
  for (const e of simRef.value?.log ?? []) rows.push([e.t, e.level, e.code, JSON.stringify(e.msg), JSON.stringify(e.detail ?? '')].join(';'));
  download(`${fileBase()}-log.csv`, rows.join('\n'), 'text/csv');
}
</script>

<template>
  <div class="logs-tab events-tab">
    <section>
      <h3>Проверка конфигурации <span class="small muted">— ошибок {{ counts.error }}, предупреждений {{ counts.warn }}, сведений {{ counts.info }}</span></h3>
      <div v-for="(c, i) in checks" :key="i" class="check-item" :class="c.level">
        <span class="lvl">{{ LEVEL[c.level] }}</span>
        <span class="msg">{{ c.msg }}</span>
        <span v-if="c.source && srcById.get(c.source)" class="src">
          <a :href="srcById.get(c.source)!.url" target="_blank" rel="noopener">{{ srcById.get(c.source)!.short }} ↗</a>
          <span class="src-kind" :class="srcById.get(c.source)!.kind">{{ SOURCE_KIND_TAG[srcById.get(c.source)!.kind] }}</span>
        </span>
        <span v-else class="src muted">оценка модели</span>
      </div>
    </section>
    <section>
      <div class="row between wrap">
        <h3>События симуляции</h3>
        <div class="row gap wrap">
          <select v-model="level"><option value="all">все</option><option value="error">ошибки</option><option value="warn">предупреждения</option><option value="info">сведения</option></select>
          <input v-model="q" placeholder="поиск" />
          <button class="btn small" @click="exportLog">CSV</button>
        </div>
      </div>
      <div class="row wrap gap small">
        <span v-for="(n, k) in totals" :key="k" class="tag">{{ CODE_NAMES[k] ?? k }}: {{ n }}</span>
      </div>
      <div class="log-list">
        <div v-for="(e, i) in log" :key="i" class="log-line" :class="e.level" @click="show(e.vid)">
          <span class="t">{{ e.t.toFixed(1) }} с</span>
          <span class="msg">{{ e.msg }}<span v-if="e.detail" class="detail">{{ e.detail }}</span></span>
        </div>
        <div v-if="!log.length" class="muted small">Пока пусто, запустите симуляцию.</div>
      </div>
      <button v-if="log.length >= limit" class="btn small" @click="limit += 300">Показать больше</button>
    </section>
  </div>
</template>
