// Загрузка песочницы для пользовательского кода по требованию: интерпретатор встроен в файл
// приложения, но разворачивается только тогда, когда в модели есть код, изменённый вручную.
import wasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url';
import { initSandbox, sandboxFailure } from '../engine/sandbox';

let bytes: Promise<Uint8Array> | null = null;

/** Байты WebAssembly интерпретатора, их же получают воркеры подбора фаз */
export function sandboxWasm(): Promise<Uint8Array> {
  if (!bytes) {
    bytes = (async () => {
      if (wasmUrl.startsWith('data:')) {
        const bin = atob(wasmUrl.slice(wasmUrl.indexOf(',') + 1));
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8;
      }
      const r = await fetch(wasmUrl);
      return new Uint8Array(await r.arrayBuffer());
    })();
  }
  return bytes;
}

/** Подготовить песочницу. false — в этом браузере она не запускается, текст причины в sandboxFailure() */
export async function ensureSandbox(): Promise<boolean> {
  try {
    return await initSandbox(await sandboxWasm());
  } catch {
    return false;
  }
}

export { sandboxFailure };
