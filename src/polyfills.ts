// Недостающие функции стандартной библиотеки для смартфонов с 2020 года и встроенных браузеров.
// Синтаксис до ECMAScript 2019 переписывает сборщик, а здесь — только то, что нельзя переписать.
// Подключается первой строкой и в основной странице, и в воркерах подбора фаз.

/* eslint-disable @typescript-eslint/no-explicit-any */
const g: any = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : {};
if (typeof g.globalThis === 'undefined') g.globalThis = g;

if (!Object.fromEntries) {
  (Object as any).fromEntries = (it: Iterable<[PropertyKey, unknown]>) => {
    const o: Record<PropertyKey, unknown> = {};
    for (const [k, v] of it) o[k] = v;
    return o;
  };
}

if (!(String.prototype as any).matchAll) {
  (String.prototype as any).matchAll = function* (this: string, re: RegExp) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const r = new RegExp(re.source, flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(this)) !== null) {
      yield m;
      if (m[0] === '') r.lastIndex++;
    }
  };
}

if (typeof g.queueMicrotask !== 'function') {
  g.queueMicrotask = (cb: () => void) => { Promise.resolve().then(cb).catch((e) => setTimeout(() => { throw e; })); };
}

if (!(Array.prototype as any).at) {
  (Array.prototype as any).at = function (this: unknown[], i: number) {
    const n = Math.trunc(i) || 0;
    return this[n < 0 ? this.length + n : n];
  };
}

if (!(Object as any).hasOwn) {
  (Object as any).hasOwn = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k);
}

/** Глубокая копия данных модели и состояния симуляции: объекты, массивы, Map, Set, Date, типизированные массивы */
function cloneDeep(v: unknown, seen: Map<unknown, unknown>): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) return seen.get(v);
  if (Array.isArray(v)) {
    const out: unknown[] = new Array(v.length);
    seen.set(v, out);
    for (let i = 0; i < v.length; i++) out[i] = cloneDeep(v[i], seen);
    return out;
  }
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof Map) {
    const out = new Map();
    seen.set(v, out);
    v.forEach((x, k) => out.set(cloneDeep(k, seen), cloneDeep(x, seen)));
    return out;
  }
  if (v instanceof Set) {
    const out = new Set();
    seen.set(v, out);
    v.forEach((x) => out.add(cloneDeep(x, seen)));
    return out;
  }
  if (ArrayBuffer.isView(v)) return (v as unknown as { slice(): unknown }).slice();
  if (v instanceof ArrayBuffer) return v.slice(0);
  const out: Record<string, unknown> = {};
  seen.set(v, out);
  for (const k of Object.keys(v)) out[k] = cloneDeep((v as Record<string, unknown>)[k], seen);
  return out;
}
if (typeof g.structuredClone !== 'function') g.structuredClone = (v: unknown) => cloneDeep(v, new Map());

// ResizeObserver появился в Safari 13.1: для более ранних версий — упрощённая замена по событию resize
if (typeof g.window !== 'undefined' && typeof g.ResizeObserver === 'undefined') {
  g.ResizeObserver = class {
    private els = new Set<Element>();
    private cb: (entries: unknown[], o: unknown) => void;
    private on = () => this.cb([...this.els].map((target) => ({ target, contentRect: target.getBoundingClientRect() })), this);
    constructor(cb: (entries: unknown[], o: unknown) => void) { this.cb = cb; }
    observe(el: Element) { if (!this.els.size) { g.addEventListener('resize', this.on); g.addEventListener('orientationchange', this.on); } this.els.add(el); setTimeout(this.on, 0); }
    unobserve(el: Element) { this.els.delete(el); }
    disconnect() { this.els.clear(); g.removeEventListener('resize', this.on); g.removeEventListener('orientationchange', this.on); }
  };
}

// Отступы flex-контейнеров: свойство gap для flex есть с Chrome 84 и Safari 14.1, для старых — запасные отступы в CSS
if (typeof g.document !== 'undefined') {
  try {
    const d = g.document as Document;
    const box = d.createElement('div');
    box.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
    box.appendChild(d.createElement('div'));
    box.appendChild(d.createElement('div'));
    d.documentElement.appendChild(box);
    if (box.scrollHeight !== 1) d.documentElement.classList.add('no-flex-gap');
    box.remove();
  } catch {
    // проверка не обязательна
  }
}

export {};
