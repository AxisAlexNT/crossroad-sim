import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

const stub = fileURLToPath(new URL('./src/stubs/empty.ts', import.meta.url));

/**
 * Целевые браузеры: смартфоны с 2020 года и встроенные браузеры приложений,
 * которые поддерживают синтаксис ECMAScript 2019. Более новый синтаксис esbuild переписывает,
 * недостающие функции стандартной библиотеки добавляет src/polyfills.ts.
 */
const TARGET = ['es2019', 'chrome69', 'edge79', 'firefox68', 'safari13', 'ios13'];

/**
 * Интерпретатор песочницы получает байты WebAssembly из приложения. Ссылку на отдельный файл .wasm
 * в его загрузчике убираем, иначе сборщик встроил бы этот файл второй раз, а в воркере
 * import.meta.url указывал бы на несуществующий адрес.
 */
function quickjsNoWasmUrl(): Plugin {
  return {
    name: 'quickjs-no-wasm-url',
    enforce: 'pre',
    transform(code, id) {
      if (!/quickjs-wasmfile-release-sync[\\/]dist[\\/]emscripten-module/.test(id)) return null;
      return code
        .replace(/new URL\("emscripten-module\.wasm",\s*import\.meta\.url\)/g, 'new URL("about:blank")')
        .replace(/import\.meta\.url/g, '"about:blank"');
    },
  };
}

/**
 * После встраивания динамических импортов import.meta.url остаётся только в служебном помощнике
 * предзагрузки, где он не используется. Синтаксис import.meta — из ES2020, поэтому заменяем его.
 */
function noImportMeta(): Plugin {
  return {
    name: 'no-import-meta',
    renderChunk(code) {
      return code.includes('import.meta') ? { code: code.replace(/import\.meta\.url/g, 'document.baseURI'), map: null } : null;
    },
  };
}

// Всё (скрипты, стили, шрифты, воркеры, песочница, подложка) встраивается в один dist/index.html,
// который работает офлайн, без сервера и без сети.
export default defineConfig(({ command }) => ({
  base: './',
  plugins: [quickjsNoWasmUrl(), vue(), noImportMeta(), viteSingleFile({ removeViteModuleLoader: true })],
  resolve: {
    alias: {
      // jsPDF тянет необязательные зависимости для HTML→PDF, они нам не нужны
      html2canvas: stub,
      dompurify: stub,
      canvg: stub,
    },
  },
  // HMR использует import.meta.hot. Понижение до ES2019 в dev заменяет
  // import.meta пустым объектом и ломает запуск компонентов.
  esbuild: { target: command === 'build' ? TARGET : 'esnext' },
  // classic (iife) воркер: модульные blob-воркеры не запускаются из file:// в Chromium
  worker: { format: 'iife', plugins: () => [quickjsNoWasmUrl()] },
  build: {
    target: TARGET,
    cssTarget: ['chrome69', 'edge79', 'firefox68', 'safari13', 'ios13'],
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 6000,
    reportCompressedSize: false,
  },
}));
