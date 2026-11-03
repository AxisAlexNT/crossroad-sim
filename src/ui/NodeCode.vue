<script setup lang="ts">
// Блок «код узла»: показывает TS-код, даёт править, проверять и применять.
import { computed, ref, watch } from 'vue';
import CodeEditor from './CodeEditor.vue';
import { compileTs } from '../engine/compile';
import { SandboxNode } from '../engine/sandbox';
import { ensureSandbox, sandboxFailure } from './sandboxLoader';

const props = defineProps<{ code: string; manual: boolean; fnName: string; test?: (node: SandboxNode) => string | null }>();
const emit = defineEmits<{ (e: 'apply', code: string): void; (e: 'regen'): void }>();
const draft = ref(props.code);
const technical = ref('');
const status = ref<{ ok: boolean; msg: string } | null>(null);
watch(() => props.code, (v) => { draft.value = v; status.value = null; technical.value = ''; });
const dirty = computed(() => draft.value !== props.code);

const busy = ref(false);

/** Проверка кода в той же песочнице, где он потом работает в симуляции */
async function check(): Promise<boolean> {
  technical.value = '';
  const r = compileTs(draft.value);
  if (!r.ok) { technical.value = r.error ?? 'Не удалось разобрать код.'; status.value = { ok: false, msg: 'В коде есть ошибка. Исправьте её перед применением.' }; return false; }
  busy.value = true;
  status.value = { ok: true, msg: 'Готовлю песочницу…' };
  const ready = await ensureSandbox();
  busy.value = false;
  if (!ready) {
    status.value = { ok: false, msg: 'Изолированный запуск кода недоступен в этом браузере. Узлы работают по параметрам.' };
    technical.value = sandboxFailure() ?? '';
    return false;
  }
  let node: SandboxNode | null = null;
  try {
    node = new SandboxNode(r.js);
    if (!node.has(props.fnName)) { technical.value = `Требуется функция ${props.fnName}()`; status.value = { ok: false, msg: 'В коде отсутствует обязательная функция узла.' }; return false; }
    const err = props.test?.(node);
    if (err) { technical.value = err; status.value = { ok: false, msg: 'Проверка поведения узла обнаружила ошибку.' }; return false; }
  } catch (e) {
    technical.value = e instanceof Error ? e.message : String(e);
    status.value = { ok: false, msg: 'Не удалось выполнить код узла. Проверьте функции и возвращаемые значения.' };
    return false;
  } finally {
    node?.dispose();
  }
  status.value = { ok: true, msg: 'Код проверен в песочнице' };
  return true;
}

async function apply() {
  if (await check()) {
    emit('apply', draft.value);
    status.value = { ok: true, msg: 'Код применён, модель перезапущена' };
  }
}
</script>

<template>
  <div class="node-code">
    <div class="row between">
      <span class="muted small">Код узла · {{ manual ? 'изменён вручную' : 'сгенерирован из параметров' }}</span>
      <span class="row gap">
        <button class="btn small" :disabled="busy" @click="check">Проверить</button>
        <button class="btn small primary" :disabled="busy || (!dirty && !manual)" @click="apply">Применить код</button>
        <button v-if="manual" class="btn small" title="Перезаписать код по текущим параметрам" @click="emit('regen')">Из параметров</button>
      </span>
    </div>
    <CodeEditor v-model="draft" />
    <div class="small muted">Код, изменённый вручную, выполняется в изолированной песочнице: без доступа к странице, сети и файлам, с ограничением времени и памяти. Узлы без правок работают по параметрам встроенной логикой.</div>
    <details v-if="technical"><summary>Подробности для разработчика</summary><pre>{{ technical }}</pre></details>
    <div v-if="status" class="small" :class="status.ok ? 'ok' : 'bad'">{{ status.msg }}</div>
  </div>
</template>
