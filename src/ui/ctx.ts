// Контекст правки: модель симулятора (живая) или черновик в редакторе.
import { computed, reactive } from 'vue';
import type { ModelConfig } from '../engine/types';
import { buildNetwork, type Network } from '../engine/network';
import { app, simRef, type Selection } from './store';

export type Ctx = 'sim' | 'editor';

export const editor = reactive({
  cfg: JSON.parse(JSON.stringify(app.cfg)) as ModelConfig,
  selected: null as Selection | null,
  /** что правится на карте редактора */
  layer: 'veh' as 'arms' | 'veh' | 'ped' | 'stops',
  /** черновик отличается от модели в симуляторе */
  dirty: false,
  version: 0,
});

/** Геометрия черновика (пересчитывается при любой правке) */
export const editorNet = computed<Network | null>(() => {
  void editor.version;
  try { return buildNetwork(JSON.parse(JSON.stringify(editor.cfg))); } catch { return null; }
});

export function useCtx(ctx: () => Ctx | undefined) {
  const isEditor = computed(() => ctx() === 'editor');
  const cfg = computed<ModelConfig>(() => (isEditor.value ? editor.cfg : app.cfg));
  const selected = computed<Selection | null>(() => (isEditor.value ? editor.selected : app.selected));
  const select = (s: Selection | null) => {
    if (isEditor.value) editor.selected = s;
    else app.selected = s;
  };
  const net = computed<Network | null>(() => { void app.version; return isEditor.value ? editorNet.value : simRef.value?.net ?? null; });
  return { isEditor, cfg, selected, select, net };
}
