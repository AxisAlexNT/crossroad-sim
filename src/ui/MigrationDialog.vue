<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { app, exportSavedOriginal, resumeSaving, useDefaultSavedModel } from './store';
const panel = ref<HTMLElement | null>(null);
const expanded = ref(false);
onMounted(() => nextTick(() => panel.value?.querySelector<HTMLButtonElement>('button')?.focus()));
function trap(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const buttons = [...(panel.value?.querySelectorAll<HTMLElement>('button, summary') ?? [])];
  const first = buttons[0], last = buttons[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
</script>
<template>
  <div class="modal-back" @keydown="trap">
    <section ref="panel" class="modal migration-dialog" role="dialog" aria-modal="true" aria-labelledby="migration-title" aria-describedby="migration-description">
      <h2 id="migration-title">{{ app.storageWarnings.length ? 'Настройки сохранения обновлены' : 'Сохранение требует внимания' }}</h2>
      <p id="migration-description">{{ app.storageWarnings.length ? 'Модель открыта. Некоторые настройки пришлось изменить, потому что в этой версии у них другие допустимые значения.' : 'Проверьте сообщение ниже. Вы можете скачать исходный файл или продолжить с открытой моделью.' }}</p>
      <ul><li v-for="label in (expanded ? app.storageWarnings : app.storageWarnings.slice(0, 5))" :key="label">{{ label }}</li></ul>
      <button v-if="app.storageWarnings.length > 5" class="btn" @click="expanded = !expanded">{{ expanded ? 'Свернуть список' : 'Показать все изменения' }}</button>
      <p>Исходная запись не перезаписана. Автосохранение приостановлено до вашего выбора.</p>
      <p v-if="app.storageIssue && (!app.storageWarnings.length || app.storageIssue.startsWith('Не удалось'))" role="status">{{ app.storageIssue }}</p>
      <div class="row wrap gap">
        <button class="btn primary" @click="resumeSaving">Продолжить</button>
        <button class="btn" @click="exportSavedOriginal">Скачать исходный файл</button>
        <button class="btn" @click="useDefaultSavedModel">Открыть модель по умолчанию</button>
      </div>
    </section>
  </div>
</template>
<style scoped>
.migration-dialog { max-height: calc(100dvh - 32px); overflow: auto; width: min(560px, calc(100vw - 32px)); }
.migration-dialog h2 { font-size: 20px; }
.migration-dialog p, .migration-dialog li { line-height: 1.5; }
.migration-dialog button { min-height: 44px; }
</style>
