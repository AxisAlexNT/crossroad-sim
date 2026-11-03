<script setup lang="ts">
import { version as buildVersion } from '../package.json';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { app, applyTheme, dialog, rebuild, runInteractive, simRef, type TabId } from './ui/store';
import { play, startLoop, syncTarget } from './ui/loop';
import MigrationDialog from './ui/MigrationDialog.vue';
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
const GROUPS: Array<{ name: string; tabs: TabId[] }> = [
  { name: 'Симуляция', tabs: ['sim', 'events'] },
  { name: 'Модель', tabs: ['editor', 'settings', 'about'] },
  { name: 'Анализ', tabs: ['charts', 'opt'] },
];
const activeGroup = computed(() => GROUPS.find(group => group.tabs.includes(app.tab)) ?? GROUPS[0]);
const visibleTabs = computed(() => TABS.filter(([id]) => activeGroup.value.tabs.includes(id)));
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
const confirmationPanel = ref<HTMLElement | null>(null);
let confirmationReturnFocus: HTMLElement | null = null;
watch(() => dialog.open, async open => {
  if (open) {
    confirmationReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    confirmationPanel.value?.querySelector<HTMLButtonElement>('button')?.focus();
  } else confirmationReturnFocus?.focus();
});
function confirmationKeys(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); dialog.resolve?.('cancel'); return; }
  if (event.key !== 'Tab') return;
  const targets = [...(confirmationPanel.value?.querySelectorAll<HTMLElement>('button, summary') ?? [])];
  const first = targets[0], last = targets[targets.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}


watch(() => app.cfg.name, (n) => { document.title = `${n} — модель перекрёстка`; }, { immediate: true });

onMounted(async () => {
  applyTheme();
  rebuild();
  // разгон: при открытии на перекрёстке уже есть машины и пешеходы, затем модель сразу идёт.
  // Расчёт ограничен по времени, чтобы на медленном телефоне страница не подвисала
  const version = app.version;
  let ready = true;
  try { while (version === app.version && !(await runInteractive({ type: 'advance', target: PREWARM_SECONDS }, true))) { /* следующий квант */ } }
  catch { ready = false; /* Ошибка загрузки уже доступна в состоянии модели. */ }
  syncTarget();
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (ready && version === app.version && !reduce) play();
  startLoop();
});
</script>

<template>
  <div v-if="app.interactiveError" class="alert" role="alert">Расчёт остановлен: {{ app.interactiveError }} <button @click="rebuild()">Перезапустить расчёт</button><details v-if="app.interactiveErrorDetails"><summary>Подробности для разработчика</summary><pre>{{ app.interactiveErrorDetails }}</pre></details></div>
  <MigrationDialog v-if="app.migrationOpen" />
  <div v-if="app.storageIssue && !app.migrationOpen" class="alert" role="status">{{ app.storageIssue }}</div>
  <div class="app">
    <header class="top">
      <div class="brand" :title="app.cfg.name">
        <span class="logo">◈</span><span class="brand-text">{{ brand }}</span><small class="muted">v{{ buildVersion }}</small>
      </div>
      <nav class="tabs" aria-label="Разделы приложения">
        <button v-for="group in GROUPS" :key="group.name" :class="{ on: activeGroup === group }" :aria-pressed="activeGroup === group" @click="activeGroup !== group && (app.tab = group.tabs[0])">{{ group.name }}</button>
      </nav>
      <button class="theme" :title="app.theme === 'dark' ? 'Включить светлую' : 'Включить тёмную'" @click="app.theme = app.theme === 'dark' ? 'light' : 'dark'">
        {{ app.theme === 'dark' ? '☀' : '☾' }}
      </button>
    </header>
    <nav class="subtabs" aria-label="Страницы раздела">
      <button v-for="[id, label] in visibleTabs" :key="id" class="btn small" :class="{ primary: app.tab === id }" :aria-current="app.tab === id ? 'page' : undefined" @click="app.tab = id">
        {{ label }}<template v-if="id === 'events'"><span v-if="counts.error" class="badge" title="Ошибки">{{ cap(counts.error) }}</span><span v-if="counts.warn" class="badge warn" title="Предупреждения">{{ cap(counts.warn) }}</span></template>
      </button>
    </nav>
    <main>
      <SimTab v-show="app.tab === 'sim'" ref="simTab" />
      <EventsTab v-if="app.tab === 'events'" />
      <ChartsTab v-show="app.tab === 'charts'" />
      <OptTab v-show="app.tab === 'opt'" />
      <EditorTab v-if="app.tab === 'editor'" />
      <SettingsTab v-if="app.tab === 'settings'" />
      <AboutTab v-if="app.tab === 'about'" />
    </main>
    <div v-if="app.compileErrors.length" class="compile-errors">Ошибки компиляции кода узлов: {{ app.compileErrors.join(' | ') }}</div>
    <transition name="fade"><div v-if="app.toast" class="toast">{{ app.toast }}</div></transition>
    <div v-if="dialog.open" class="modal-back" @click.self="dialog.resolve?.('cancel')" @keydown="confirmationKeys">
      <div ref="confirmationPanel" class="modal" role="dialog" aria-modal="true" :aria-label="dialog.title">
        <h3>{{ dialog.title }}</h3>
        <p class="small">{{ dialog.text }}</p>
        <ul v-if="dialog.items.length" class="small">
          <li v-for="(it, i) in dialog.items.slice(0, 5)" :key="i">{{ it }}</li>
        </ul>
        <details v-if="dialog.items.length > 5"><summary>Показать все изменения</summary><ul><li v-for="(it, i) in dialog.items.slice(5)" :key="i">{{ it }}</li></ul></details>
        <div class="row wrap gap end">
          <button v-for="b in dialog.buttons" :key="b.id" class="btn" :class="b.kind" @click="dialog.resolve?.(b.id)">{{ b.label }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.subtabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 5px 12px; background: var(--surface); border-bottom: 1px solid var(--border); }
.subtabs button { min-height: 36px; }
@media (pointer: coarse) { .subtabs button { min-height: 44px; } }
</style>
