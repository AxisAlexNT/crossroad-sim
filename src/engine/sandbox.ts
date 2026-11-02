// Песочница для пользовательского кода узлов. Код выполняется в отдельном интерпретаторе
// JavaScript QuickJS, скомпилированном в WebAssembly. У него нет доступа к странице, сети,
// файлам, хранилищу браузера и окнам: alert, prompt, fetch и document там просто отсутствуют.
// Наружу код получает только данные контекста в виде JSON и одну функцию случайных чисел,
// а возвращает только результат и состояние memory. Время одного вызова и память ограничены.
import {
  newQuickJSWASMModuleFromVariant, newVariant,
  type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSSyncVariant, type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import { QuickJSFFI } from '@jitl/quickjs-wasmfile-release-sync/ffi';
import moduleLoader from '@jitl/quickjs-wasmfile-release-sync/emscripten-module';

/** Предел времени одного вызова функции узла, мс */
const CALL_LIMIT_MS = 250;
/** Предел времени загрузки кода узла, мс */
const LOAD_LIMIT_MS = 1000;
/** Предел памяти одного узла, байт */
const MEMORY_LIMIT = 16 * 1024 * 1024;
/** После стольких ошибок подряд узел отключается, чтобы не тормозить симуляцию */
export const MAX_FAILS = 20;

let QJS: QuickJSWASMModule | null = null;
let loading: Promise<boolean> | null = null;
let failure = '';

const baseVariant: QuickJSSyncVariant = {
  type: 'sync',
  importFFI: () => Promise.resolve(QuickJSFFI),
  importModuleLoader: () => Promise.resolve(moduleLoader),
} as unknown as QuickJSSyncVariant;

/** Загрузить интерпретатор из байтов WebAssembly. Повторные вызовы возвращают тот же результат */
export function initSandbox(wasm: ArrayBuffer | Uint8Array): Promise<boolean> {
  if (QJS) return Promise.resolve(true);
  if (loading) return loading;
  // Загрузчик интерпретатора создаёт представления памяти BigInt64Array, но не пользуется ими.
  // В Safari до 15 их нет: подставляем пустые конструкторы, чтобы песочница работала и там
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of ['BigInt64Array', 'BigUint64Array']) if (typeof g[k] === 'undefined') g[k] = function Unsupported64() { /* не используется */ };
  const buf = wasm instanceof Uint8Array ? wasm.slice().buffer : wasm.slice(0);
  loading = newQuickJSWASMModuleFromVariant(newVariant(baseVariant, { wasmBinary: buf }))
    .then((m) => { QJS = m; return true; })
    .catch((e: unknown) => { failure = e instanceof Error ? e.message : String(e); return false; });
  return loading;
}

export const sandboxReady = (): boolean => QJS !== null;
/** Текст ошибки, если интерпретатор не удалось загрузить в этом браузере */
export const sandboxFailure = (): string => failure;

const PRELUDE = `
var exports = {}; var module = { exports: exports };
function require(n) {
  if (n === 'sim') return {};
  throw new Error('Импорт «' + n + '» недоступен: код узла работает без внешних модулей');
}
function __pickWeighted(items) {
  if (!items || items.length === 0) throw new Error('pickWeighted: пустой список');
  var total = 0, i;
  for (i = 0; i < items.length; i++) total += Math.max(0, items[i][1]);
  if (total <= 0) return items[0][0];
  var r = __random2() * total;
  for (i = 0; i < items.length; i++) { r -= Math.max(0, items[i][1]); if (r <= 0) return items[i][0]; }
  return items[items.length - 1][0];
}
function __call(name, json) {
  var f = __ex[name];
  if (typeof f !== 'function') throw new Error('нет экспортируемой функции ' + name + '()');
  var a = JSON.parse(json);
  var ctx = a.ctx;
  ctx.random = function () { return __random(); };
  ctx.uniform = function (x, y) { return x + (y - x) * __random2(); };
  ctx.pick = function (w) { return __pickWeighted(Object.keys(w).map(function (k) { return [k, w[k] || 0]; })); };
  ctx.pickWeighted = __pickWeighted;
  var args = a.args.slice();
  args.splice(a.at, 0, ctx);
  var r = f.apply(undefined, args);
  return JSON.stringify({ r: r === undefined ? null : r, m: ctx.memory });
}
function __has(name) { return typeof __ex[name] === 'function'; }
`;

export interface CallContext {
  memory: Record<string, unknown>;
  [key: string]: unknown;
}

/** Код одного узла в собственном изолированном окружении */
export class SandboxNode {
  private rt: QuickJSRuntime;
  private vm: QuickJSContext;
  private callH: QuickJSHandle;
  private hasH: QuickJSHandle;
  private deadline = 0;
  private rand: () => number = () => 0;
  private rand2: () => number = () => 0;
  fails = 0;
  disposed = false;

  constructor(js: string) {
    if (!QJS) throw new Error(failure ? `песочница недоступна в этом браузере: ${failure}` : 'песочница ещё загружается');
    this.rt = QJS.newRuntime();
    this.rt.setMemoryLimit(MEMORY_LIMIT);
    this.rt.setMaxStackSize(512 * 1024);
    this.rt.setInterruptHandler(() => Date.now() > this.deadline);
    this.vm = this.rt.newContext();
    const vm = this.vm;
    const fn = vm.newFunction('__random', () => vm.newNumber(this.rand()));
    vm.setProp(vm.global, '__random', fn);
    fn.dispose();
    const fn2 = vm.newFunction('__random2', () => vm.newNumber(this.rand2()));
    vm.setProp(vm.global, '__random2', fn2);
    fn2.dispose();
    try {
      this.deadline = Date.now() + LOAD_LIMIT_MS;
      const src = `${PRELUDE}\n(function (exports, require, module) { "use strict";\n${js}\n})(exports, require, module);\nvar __ex = module.exports || exports;`;
      const res = vm.evalCode(src, 'node.js');
      if (res.error) {
        const msg = this.errText(res.error);
        res.error.dispose();
        throw new Error(msg);
      }
      res.value.dispose();
      this.callH = vm.getProp(vm.global, '__call');
      this.hasH = vm.getProp(vm.global, '__has');
    } catch (e) {
      this.dispose();
      throw e;
    }
  }

  private errText(h: QuickJSHandle): string {
    const d = this.vm.dump(h) as unknown;
    if (Date.now() > this.deadline) return 'код выполнялся слишком долго и был остановлен';
    if (d && typeof d === 'object' && 'message' in (d as Record<string, unknown>)) return String((d as Record<string, unknown>).message);
    return String(d);
  }

  has(name: string): boolean {
    if (this.disposed) return false;
    this.deadline = Date.now() + CALL_LIMIT_MS;
    const n = this.vm.newString(name);
    const r = this.vm.callFunction(this.hasH, this.vm.undefined, n);
    n.dispose();
    if (r.error) { r.error.dispose(); return false; }
    const ok = this.vm.dump(r.value) === true;
    r.value.dispose();
    return ok;
  }

  /**
   * Вызвать экспортируемую функцию. ctx — только данные, без функций. Функции random, uniform,
   * pick и pickWeighted создаются внутри песочницы: random берёт случайные числа из rand,
   * остальные — из rand2, если он задан. memory после вызова переносится обратно в ctx.memory
   */
  call(name: string, args: unknown[], at: number, ctx: CallContext, rand: () => number, rand2?: () => number): unknown {
    if (this.disposed) throw new Error('узел выключен');
    this.rand = rand;
    this.rand2 = rand2 ?? rand;
    this.deadline = Date.now() + CALL_LIMIT_MS;
    const vm = this.vm;
    const n = vm.newString(name);
    const j = vm.newString(JSON.stringify({ args, at, ctx }));
    const r = vm.callFunction(this.callH, vm.undefined, n, j);
    n.dispose();
    j.dispose();
    if (r.error) {
      const msg = this.errText(r.error);
      r.error.dispose();
      this.fails++;
      throw new Error(msg);
    }
    const out = JSON.parse(vm.getString(r.value)) as { r: unknown; m: unknown };
    r.value.dispose();
    this.fails = 0;
    const mem = ctx.memory;
    for (const k of Object.keys(mem)) delete mem[k];
    if (out.m && typeof out.m === 'object') Object.assign(mem, out.m);
    return out.r;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.callH?.dispose();
      this.hasH?.dispose();
      this.vm?.dispose();
      this.rt?.dispose();
    } catch {
      // освобождение памяти интерпретатора не должно ломать приложение
    }
  }
}
