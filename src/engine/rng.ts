// Детерминированный генератор случайных чисел (sfc32): одинаковый seed → одинаковая симуляция.
// Состояние — 4 числа, поэтому его легко сохранять в снимках для перемотки назад.

export type RngState = [number, number, number, number];

export function seedRng(seed: number): RngState {
  // splitmix32 для развёртки seed в 4 слова
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  const st: RngState = [next(), next(), next(), next()];
  // прогрев
  for (let i = 0; i < 12; i++) rngNext(st);
  return st;
}

export function rngNext(st: RngState): number {
  let [a, b, c, d] = st;
  a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
  const t = (a + b) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  d = (d + 1) | 0;
  const r = (t + d) | 0;
  c = (c + r) | 0;
  st[0] = a; st[1] = b; st[2] = c; st[3] = d;
  return (r >>> 0) / 4294967296;
}

export function pickWeighted<T>(st: RngState, items: Array<[T, number]>): T {
  let total = 0;
  for (const [, w] of items) total += Math.max(0, w);
  if (total <= 0 || items.length === 0) {
    if (items.length === 0) throw new Error('pickWeighted: пустой список');
    return items[0][0];
  }
  let r = rngNext(st) * total;
  for (const [item, w] of items) {
    r -= Math.max(0, w);
    if (r <= 0) return item;
  }
  return items[items.length - 1][0];
}

/**
 * Зерно отдельного потока случайных чисел по общему зерну и имени потока (FNV-1a).
 * Потоки разных подходов, пешеходов и автобусов независимы: изменение одного подхода
 * или программы светофора не сдвигает случайные числа остальных, и варианты сравниваются
 * на одних и тех же потоках машин и пешеходов
 */
export function streamSeed(seed: number, key: string): number {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Целое зерно для дочернего генератора: одно обращение к родительскому */
export const rngSeedFrom = (st: RngState): number => Math.floor(rngNext(st) * 4294967296) >>> 0;
