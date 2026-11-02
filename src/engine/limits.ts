// Пределы для загружаемых моделей и сессий. Файл модели может прийти откуда угодно, поэтому
// его размер, число объектов, длина строк и диапазоны чисел ограничены: слишком большой или
// странный файл не должен подвешивать страницу, а значения из него не должны попадать в разметку как есть.

import { ModelFormatError } from './modelError';

export const LIMITS = {
  /** Размер файла модели или сессии, байт */
  fileBytes: 12 * 1024 * 1024,
  arms: 8,
  lanesPerDirection: 6,
  connections: 400,
  groups: 80,
  phases: 32,
  pedNodes: 200,
  pedEdges: 400,
  pedSources: 120,
  pedGroupSizes: 10,
  stops: 40,
  routes: 80,
  routeStops: 10,
  vehicleTypes: 12,
  profilePoints: 200,
  exitBlocks: 100,
  basemapFeatures: 30000,
  /** Всего чисел в координатах подложки */
  basemapNumbers: 1_500_000,
  /** Код одного узла или контроллера, символов */
  code: 100_000,
  name: 200,
  id: 64,
  description: 4000,
} as const;

/** Цвет только в виде #RRGGBB или #RGB, иначе значение по умолчанию. Короткая запись разворачивается */
export function safeColor(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
  return fallback;
}

/** Строка ограниченной длины без управляющих символов */
export function safeStr(v: unknown, fallback: string, max: number = LIMITS.name): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return fallback;
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return s.length > max ? s.slice(0, max) : s;
}

/** Идентификатор: короткая строка */
export const safeId = (v: unknown, fallback: string): string => safeStr(v, fallback, LIMITS.id) || fallback;

/** Конечное число в диапазоне, иначе значение по умолчанию */
export function clampNum(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const clampInt = (v: unknown, fallback: number, min: number, max: number): number => Math.round(clampNum(v, fallback, min, max));

/** Массив не длиннее предела. Если длиннее — модель не загружается: обрезка молча изменила бы её смысл */
export function limitedArray(v: unknown, max: number, what: string): unknown[] {
  if (!Array.isArray(v)) return [];
  if (v.length > max) throw new ModelFormatError(`В файле слишком много объектов «${what}»: ${v.length}, допустимо не больше ${max}.`);
  return v;
}

/** Код ограниченной длины */
export function limitedCode(v: unknown, what: string): string {
  if (typeof v !== 'string') return '';
  if (v.length > LIMITS.code) throw new ModelFormatError(`Код «${what}» слишком длинный: ${v.length} символов, допустимо не больше ${LIMITS.code}.`);
  return v;
}

/** Размер файла до чтения */
export function checkFileSize(bytes: number) {
  if (bytes > LIMITS.fileBytes) {
    throw new ModelFormatError(`Файл слишком большой: ${(bytes / 1024 / 1024).toFixed(1)} МБ, допустимо не больше ${LIMITS.fileBytes / 1024 / 1024} МБ.`);
  }
}
