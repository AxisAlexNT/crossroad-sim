// Сборка файла THIRD_PARTY_LICENSES.txt: полные тексты лицензий сторонних компонентов,
// которые входят в готовый HTML-файл. Запуск: node scripts/licenses.mjs
// Список пакетов совпадает с тем, что сборщик включает в dist/index.html.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const PACKAGES = [
  'vue', '@vue/reactivity', '@vue/runtime-core', '@vue/runtime-dom', '@vue/shared',
  'uplot',
  'codemirror', '@codemirror/autocomplete', '@codemirror/commands', '@codemirror/lang-javascript', '@codemirror/language',
  '@codemirror/lint', '@codemirror/search', '@codemirror/state', '@codemirror/view',
  '@lezer/common', '@lezer/highlight', '@lezer/javascript', '@lezer/lr', '@marijn/find-cluster-break', 'crelt', 'style-mod', 'w3c-keyname',
  'sucrase', 'lines-and-columns', 'ts-interface-checker', '@jridgewell/gen-mapping', '@jridgewell/resolve-uri', '@jridgewell/sourcemap-codec',
  'jspdf', 'fflate', 'fast-png', 'iobuffer', 'pako', '@babel/runtime', 'svg2pdf.js', 'svgpath', 'cssesc', 'font-family-papandreou', 'specificity',
  'quickjs-emscripten-core', '@jitl/quickjs-ffi-types', '@jitl/quickjs-wasmfile-release-sync',
  '@fontsource/inter', 'dejavu-fonts-ttf',
];

function licenseText(dir) {
  const f = readdirSync(dir).find((x) => /^(licen[cs]e|copying)(\b|[.-])/i.test(x));
  return f ? readFileSync(join(dir, f), 'utf8').trim() : null;
}

let out = `Сторонние компоненты в файле приложения и их лицензии
=====================================================

Приложение собрано из собственного кода и перечисленных ниже компонентов с открытыми лицензиями.
Тексты лицензий приведены полностью, как того требуют условия распространения.
Данные OpenStreetMap во встроенной подложке: © участники OpenStreetMap, лицензия Open Database License 1.0,
https://www.openstreetmap.org/copyright

`;
const missing = [];
for (const name of PACKAGES) {
  const dir = join(root, 'node_modules', name);
  if (!existsSync(dir)) { missing.push(name); continue; }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const text = licenseText(dir);
  if (!text) { missing.push(name); continue; }
  const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'см. текст';
  const home = pkg.homepage || (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) || '';
  out += `\n------------------------------------------------------------------------\n${name} ${pkg.version ?? ''} — ${lic}\n${home}\n\n${text}\n`;
}
out += `\n------------------------------------------------------------------------\nШрифт DejaVu Sans в PDF — урезанная версия шрифта DejaVu, лицензия приведена выше в разделе dejavu-fonts-ttf.\nШрифт Inter — лицензия SIL Open Font License 1.1, приведена выше в разделе @fontsource/inter.\nИнтерпретатор QuickJS (Fabrice Bellard, Charlie Gordon) входит в @jitl/quickjs-wasmfile-release-sync, его лицензия приведена в том же разделе.\n`;
if (missing.length) throw new Error('нет текста лицензии: ' + missing.join(', '));
writeFileSync(join(root, 'THIRD_PARTY_LICENSES.txt'), out);
console.log('THIRD_PARTY_LICENSES.txt:', out.length, 'символов,', PACKAGES.length, 'пакетов');
