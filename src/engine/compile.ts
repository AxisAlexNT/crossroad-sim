// TypeScript → JavaScript для кода узлов (sucrase: быстрый и лёгкий, только снятие типов).

import { transform } from 'sucrase';
import type { CompiledCode, ModelConfig } from './types';

export interface CompileResult {
  ok: boolean;
  js: string;
  error?: string;
}

export function compileTs(ts: string): CompileResult {
  try {
    const out = transform(ts, { transforms: ['typescript', 'imports'], disableESTransforms: true });
    return { ok: true, js: out.code };
  } catch (e) {
    return { ok: false, js: '', error: e instanceof Error ? e.message : String(e) };
  }
}

export function compileModel(cfg: ModelConfig): { code: CompiledCode; errors: string[] } {
  const errors: string[] = [];
  const code: CompiledCode = { spawners: {}, laneChoosers: {}, exits: {} };
  const take = (label: string, ts: string): string | undefined => {
    const r = compileTs(ts);
    if (!r.ok) {
      errors.push(`${label}: ${r.error}`);
      return undefined;
    }
    return r.js;
  };
  // узлы по параметрам работают встроенной логикой, компилируется только код, изменённый вручную
  for (const a of cfg.arms) {
    const d = a.id;
    if (cfg.spawners[d]?.manual) code.spawners[d] = take(`Появление машин, ${a.short}`, cfg.spawners[d].code);
    if (cfg.laneChoosers[d]?.manual) code.laneChoosers[d] = take(`Перестроение, ${a.short}`, cfg.laneChoosers[d].code);
    if (cfg.exits[d]?.manual) code.exits[d] = take(`Выезд, ${a.short}`, cfg.exits[d].code);
  }
  if (cfg.signals.controller === 'code') code.controller = take('Контроллер светофора', cfg.signals.code);
  return { code, errors };
}

/** Есть ли в модели пользовательский код, который нужно запускать в песочнице */
export function hasCustomCode(cfg: ModelConfig): boolean {
  if (cfg.signals.controller === 'code') return true;
  return cfg.arms.some((a) => cfg.spawners[a.id]?.manual || cfg.laneChoosers[a.id]?.manual || cfg.exits[a.id]?.manual);
}

/** Узлы с пользовательским кодом, для предупреждения при загрузке файла */
export function customCodeNodes(cfg: ModelConfig): string[] {
  const out: string[] = [];
  for (const a of cfg.arms) {
    if (cfg.spawners[a.id]?.manual) out.push(`появление машин, ${a.short}`);
    if (cfg.laneChoosers[a.id]?.manual) out.push(`перестроение, ${a.short}`);
    if (cfg.exits[a.id]?.manual) out.push(`выезд, ${a.short}`);
  }
  if (cfg.signals.controller === 'code') out.push('контроллер светофора');
  return out;
}
