<script setup lang="ts">
// Редактор TypeScript на CodeMirror 6 (подсветка, отступы, поиск). Работает офлайн.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const props = defineProps<{ modelValue: string; readonly?: boolean; minHeight?: string }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();
const host = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;
let internal = false;

const hl = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--code-kw)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--code-str)' },
  { tag: t.comment, color: 'var(--code-cmt)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null], color: 'var(--code-num)' },
  { tag: [t.typeName, t.className], color: 'var(--code-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--code-fn)' },
  { tag: t.propertyName, color: 'var(--code-prop)' },
]);

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--code-bg)', color: 'var(--fg)', fontSize: '12.5px', borderRadius: '8px' },
  '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--code-active)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--code-active)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--code-sel) !important' },
  '&.cm-focused': { outline: '1px solid var(--accent)' },
});

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        javascript({ typescript: true }),
        syntaxHighlighting(hl),
        theme,
        EditorView.lineWrapping,
        EditorState.readOnly.of(!!props.readonly),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            internal = true;
            emit('update:modelValue', u.state.doc.toString());
            internal = false;
          }
        }),
      ],
    }),
  });
});

watch(() => props.modelValue, (v) => {
  if (internal || !view) return;
  if (v !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
});

onBeforeUnmount(() => view?.destroy());
</script>

<template>
  <div ref="host" class="code-editor" :style="{ minHeight: minHeight ?? '160px' }" />
</template>
