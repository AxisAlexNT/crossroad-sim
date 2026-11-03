import { normalizeModel, serializeModel } from './model';
import { ModelFormatError } from './modelError';
import type { ModelConfig } from './types';

export interface Preferences {
  theme?: 'dark' | 'light';
  draftAsError?: boolean;
  showTimers?: boolean;
}
export interface MigrationReport {
  sourceVersion: number;
  targetVersion: number;
  changes: string[];
  warnings: string[];
}
export interface LoadedSession {
  cfg: ModelConfig;
  presetId?: string;
  preferences: Preferences;
  report: MigrationReport;
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Одна точка входа для файла и локального сохранения. Исходные данные не изменяются. */
export function migrateSession(input: unknown): LoadedSession {
  if (!object(input)) throw new ModelFormatError('Сессия должна быть объектом.');
  const wrapped = object(input.cfg);
  const raw = wrapped ? input.cfg as Record<string, unknown> : input;
  for (const x of wrapped ? [input, raw] : [raw]) {
    if (x.format && x.format !== 'crossroad-sim-session' && x.format !== 'crossroad-model') throw new ModelFormatError('Неизвестный формат файла.');
    if (x.version !== undefined && (!Number.isInteger(x.version) || Number(x.version) < 1 || Number(x.version) > 2)) {
      throw new ModelFormatError('Версия формата не поддерживается. Исходный файл сохранён без изменений; откройте его в совместимой версии приложения.');
    }
  }
  const cfg = normalizeModel(input);
  const prefs = { ...(wrapped ? input : {}), ...(object(input.preferences) ? input.preferences : {}) };
  const preferences: Preferences = {};
  if (prefs.theme === 'dark' || prefs.theme === 'light') preferences.theme = prefs.theme;
  if (typeof prefs.draftAsError === 'boolean') preferences.draftAsError = prefs.draftAsError;
  if (typeof prefs.showTimers === 'boolean') preferences.showTimers = prefs.showTimers;
  const report: MigrationReport = { sourceVersion: Number(raw.version ?? (Array.isArray(raw.arms) ? 2 : 1)), targetVersion: 2, changes: [], warnings: [] };
  if (report.sourceVersion < 2) report.changes.push('Модель преобразована в формат 2.');
  // Сравниваем только предоставленные поля. Новые значения по умолчанию не являются потерей.
  const compare = (before: unknown, after: unknown, path: string) => {
    if (report.warnings.length >= 30) return;
    if (object(before) && object(after)) {
      for (const key of Object.keys(before)) compare(before[key], after[key], path ? `${path}.${key}` : key);
    } else if (Array.isArray(before) && Array.isArray(after)) {
      if (before.length !== after.length) report.warnings.push(`${path}: изменилось число элементов.`);
      before.slice(0, after.length).forEach((v, i) => compare(v, after[i], `${path}[${i}]`));
    } else if (JSON.stringify(before) !== JSON.stringify(after)) report.warnings.push(`${path}: значение преобразовано или не поддерживается.`);
  };
  const normalized = JSON.parse(serializeModel(cfg));
  if (report.sourceVersion === 2) compare(raw, normalized, 'модель');
  else {
    const legacy = { ...raw };
    delete legacy.version;
    delete legacy.arms;
    if (object(raw.sim)) {
      legacy.sim = { ...raw.sim };
      delete (legacy.sim as Record<string, unknown>).pedestrians;
      if (object(raw.sim.pedestrians)) {
        if (object(raw.peds)) report.warnings.push('модель.sim.pedestrians: общие параметры заменены явно заданным пешеходным графом.');
        else {
          report.changes.push('Общие параметры пешеходов перенесены в источники пешеходного графа.');
          const old = raw.sim.pedestrians;
          for (const key of ['speedMin', 'speedMax'] as const) if (old[key] !== undefined && cfg.peds.sources.some(source => source[key] !== old[key])) {
            report.warnings.push(`модель.sim.pedestrians.${key}: значение преобразовано.`);
          }
          if (old.rate !== undefined && cfg.peds.sources.reduce((n, source) => n + source.rate, 0) !== old.rate) {
            report.warnings.push('модель.sim.pedestrians.rate: общий поток изменён при распределении или проверке значений.');
          }
        }
        for (const key of Object.keys(raw.sim.pedestrians)) {
          if (report.warnings.length >= 30) break;
          if (!['rate', 'speedMin', 'speedMax'].includes(key)) report.warnings.push(`модель.sim.pedestrians.${key}: параметр не поддерживается.`);
        }
      }
    }
    compare(legacy, normalized, 'модель');
    if (object(raw.arms)) for (const [id, arm] of Object.entries(raw.arms)) {
      const converted = normalized.arms.find((a: { id: string }) => a.id === id);
      const supplied = object(arm) ? { ...arm } : arm;
      if (object(supplied) && supplied.dir === id) delete supplied.dir;
      compare(supplied, converted, `модель.arms.${id}`);
    }
    if (!object(raw.peds)) report.changes.push('Создан пешеходный граф для геометрии первой версии.');
    if (!object(raw.transit)) report.changes.push('Добавлены параметры общественного транспорта первой версии.');
  }
  for (const key of ['theme', 'draftAsError', 'showTimers'] as const) {
    if (prefs[key] !== undefined && prefs[key] !== preferences[key]) report.warnings.push(`настройки.${key}: значение не поддерживается.`);
  }
  if (object(input.preferences)) for (const key of Object.keys(input.preferences)) {
    if (report.warnings.length >= 30) break;
    if (!['theme', 'draftAsError', 'showTimers'].includes(key)) report.warnings.push(`настройки.${key}: параметр не поддерживается.`);
  }
  if (wrapped) for (const key of Object.keys(input)) {
    if (report.warnings.length >= 30) break;
    if (!['format', 'version', 'savedAt', 'presetId', 'preferences', 'cfg', 'theme', 'draftAsError', 'showTimers'].includes(key)) {
      report.warnings.push(`сессия.${key}: поле не поддерживается.`);
    }
  }
  return { cfg, presetId: typeof input.presetId === 'string' ? input.presetId : undefined, preferences, report };
}

export function serializeSession(cfg: ModelConfig, presetId: string, preferences: Preferences): string {
  return JSON.stringify({ format: 'crossroad-sim-session', version: 2, savedAt: new Date().toISOString(), presetId, preferences, cfg: JSON.parse(serializeModel(cfg)) }, null, 2);
}
