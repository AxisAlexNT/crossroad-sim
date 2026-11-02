<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { app, applyTheme, dialog, rebuild, simRef, type TabId } from './ui/store';
import { play, startLoop, syncTarget } from './ui/loop';
import SimTab from './ui/SimTab.vue';
import EventsTab from './ui/EventsTab.vue';
import ChartsTab from './ui/ChartsTab.vue';
import OptTab from './ui/OptTab.vue';
import SettingsTab from './ui/SettingsTab.vue';
import AboutTab from './ui/AboutTab.vue';
import EditorTab from './ui/EditorTab.vue';

const TABS: Array<[TabId, string]> = [
  ['sim', 'Симуляция'],
  ['editor', 'Редактор'],
  ['events', 'События'],
  ['charts', 'Графики'],
  ['opt', 'Подбор фаз'],
  ['settings', 'Настройки'],
  ['about', 'О модели'],
];
/** Сколько секунд модели посчитать до показа, чтобы перекрёсток не был пустым */
const PREWARM_SECONDS = 90;
const simTab = ref<InstanceType<typeof SimTab> | null>(null);
void simTab;
const brand = computed(() => app.cfg.name.split(',')[0].replace(/\s*ул\.\s*/g, ' ').replace(/\s+/g, ' ').trim() || 'Перекрёсток');
const counts = computed(() => {
  void app.logTick;
  const lc = simRef.value?.levelCounts;
  return {
    error: app.checks.filter((c) => c.level === 'error').length + (lc?.error ?? 0),
    warn: app.checks.filter((c) => c.level === 'warn').length + (lc?.warn ?? 0),
  };
});
const cap = (n: number) => (n > 999 ? '999+' : String(n));

watch(() => app.cfg.name, (n) => { document.title = `${n} — модель перекрёстка`; }, { immediate: true });

onMounted(() => {
  applyTheme();
  rebuild();
  // разгон: при открытии на перекрёстке уже есть машины и пешеходы, затем модель сразу идёт.
  // Расчёт ограничен по времени, чтобы на медленном телефоне страница не подвисала
  simRef.value?.runUntil(PREWARM_SECONDS, 1200);
  syncTarget();
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) play();
  startLoop();
});
</script>

<template>
  <div class="app">
    <header class="top">
      <div class="brand" :title="app.cfg.name">
        <span class="logo">◈</span><span class="brand-text">{{ brand }}</span>
      </div>
      <nav class="tabs">
        <button v-for="[id, label] in TABS" :key="id" :class="{ on: app.tab === id }" @click="app.tab = id">
          {{ label }}<template v-if="id === 'events'"><span v-if="counts.error" class="badge" title="Ошибки">{{ cap(counts.error) }}</span><span v-if="counts.warn" class="badge warn" title="Предупреждения">{{ cap(counts.warn) }}</span></template>
        </button>
      </nav>
      <button class="theme" :title="app.theme === 'dark' ? 'Включить светлую' : 'Включить тёмную'" @click="app.theme = app.theme === 'dark' ? 'light' : 'dark'">
        {{ app.theme === 'dark' ? '☀' : '☾' }}
      </button>
    </header>
    <main>
      <SimTab v-show="app.tab === 'sim'" ref="simTab" />
      <EventsTab v-if="app.tab === 'events'" />
      <ChartsTab v-if="app.tab === 'charts'" />
      <OptTab v-show="app.tab === 'opt'" />
      <EditorTab v-if="app.tab === 'editor'" />
      <SettingsTab v-if="app.tab === 'settings'" />
      <AboutTab v-if="app.tab === 'about'" />
    </main>
    <div v-if="app.compileErrors.length" class="compile-errors">Ошибки компиляции кода узлов: {{ app.compileErrors.join(' | ') }}</div>
    <transition name="fade"><div v-if="app.toast" class="toast">{{ app.toast }}</div></transition>
    <div v-if="dialog.open" class="modal-back" @click.self="dialog.resolve?.('cancel')">
      <div class="modal" role="dialog" aria-modal="true" :aria-label="dialog.title">
        <h3>{{ dialog.title }}</h3>
        <p class="small">{{ dialog.text }}</p>
        <ul v-if="dialog.items.length" class="small">
          <li v-for="(it, i) in dialog.items" :key="i">{{ it }}</li>
        </ul>
        <div class="row wrap gap end">
          <button v-for="b in dialog.buttons" :key="b.id" class="btn" :class="b.kind" @click="dialog.resolve?.(b.id)">{{ b.label }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
