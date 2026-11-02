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
const status = ref<{ ok: boolean; msg: string } | null>(null);
watch(() => props.code, (v) => { draft.value = v; status.value = null; });
const dirty = computed(() => draft.value !== props.code);

const busy = ref(false);

/** Проверка кода в той же песочнице, где он потом работает в симуляции */
async function check(): Promise<boolean> {
  const r = compileTs(draft.value);
  if (!r.ok) { status.value = { ok: false, msg: 'Ошибка TypeScript: ' + r.error }; return false; }
  busy.value = true;
  status.value = { ok: true, msg: 'Готовлю песочницу…' };
  const ready = await ensureSandbox();
  busy.value = false;
  if (!ready) {
    status.value = { ok: false, msg: 'Песочница для кода не запускается в этом браузере' + (sandboxFailure() ? ': ' + sandboxFailure() : '') + '. Узлы работают по параметрам.' };
    return false;
  }
  let node: SandboxNode | null = null;
  try {
    node = new SandboxNode(r.js);
    if (!node.has(props.fnName)) { status.value = { ok: false, msg: `Нужна экспортируемая функция ${props.fnName}()` }; return false; }
    const err = props.test?.(node);
    if (err) { status.value = { ok: false, msg: err }; return false; }
  } catch (e) {
    status.value = { ok: false, msg: 'Ошибка выполнения: ' + (e instanceof Error ? e.message : String(e)) };
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
      <span class="muted small">TypeScript · {{ manual ? 'изменён вручную' : 'сгенерирован из параметров' }}</span>
      <span class="row gap">
        <button class="btn small" :disabled="busy" @click="check">Проверить</button>
        <button class="btn small primary" :disabled="busy || (!dirty && !manual)" @click="apply">Применить код</button>
        <button v-if="manual" class="btn small" title="Перезаписать код по текущим параметрам" @click="emit('regen')">Из параметров</button>
      </span>
    </div>
    <CodeEditor v-model="draft" />
    <div class="small muted">Код, изменённый вручную, выполняется в изолированной песочнице: без доступа к странице, сети и файлам, с ограничением времени и памяти. Узлы без правок работают по параметрам встроенной логикой.</div>
    <div v-if="status" class="small" :class="status.ok ? 'ok' : 'bad'">{{ status.msg }}</div>
  </div>
</template>
