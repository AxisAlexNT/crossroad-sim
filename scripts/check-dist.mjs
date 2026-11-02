// Проверка готового файла: npm run check:dist [-- путь/к/index.html]
// 1. Размер не больше 5 МБ.
// 2. Весь JavaScript, включая встроенные Web Worker'ы, разбирается как ECMAScript 2019:
//    так файл работает в браузерах смартфонов с 2020 года и во встроенных браузерах приложений.
// 3. Нет внешних скриптов, стилей и import.meta, то есть файл работает без сети.
import { readFileSync, statSync } from 'node:fs';
import { parse } from 'acorn';

const file = process.argv[2] ?? 'dist/index.html';
const LIMIT = 5 * 1024 * 1024;
let fails = 0;
const fail = (msg) => { fails++; console.log('ОШИБКА:', msg); };

const size = statSync(file).size;
console.log(`размер ${(size / 1024 / 1024).toFixed(2)} МБ из ${LIMIT / 1024 / 1024} МБ`);
if (size > LIMIT) fail(`файл больше ${LIMIT / 1024 / 1024} МБ`);

const html = readFileSync(file, 'utf8');
if (/<script[^>]+\bsrc=/i.test(html)) fail('есть внешний скрипт <script src>');
if (/<link[^>]+rel=["']?stylesheet/i.test(html)) fail('есть внешняя таблица стилей');
if (/import\.meta/.test(html)) fail('в коде осталось import.meta, это ECMAScript 2020');

function check(label, code, sourceType) {
  try {
    parse(code, { ecmaVersion: 2019, sourceType });
    console.log(`ECMAScript 2019: ${label}, ${(code.length / 1024).toFixed(0)} КБ — да`);
  } catch (e) {
    fail(`${label} не разбирается как ECMAScript 2019: ${e.message}, рядом: ${JSON.stringify(code.slice(Math.max(0, e.pos - 120), e.pos + 60))}`);
  }
}
function walk(node, f) {
  if (!node || typeof node !== 'object') return;
  f(node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((x) => walk(x, f));
    else if (v && typeof v.type === 'string') walk(v, f);
  }
}

const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
if (!scripts.length) fail('в файле нет скриптов');
let workers = 0;
for (const m of scripts) {
  const code = m[2];
  if (!code.trim()) continue;
  const sourceType = /type=["']?module/.test(m[1]) ? 'module' : 'script';
  check('основной скрипт', code, sourceType);
  // встроенные воркеры лежат в коде строками: ищем длинные строки с кодом
  let ast;
  try { ast = parse(code, { ecmaVersion: 'latest', sourceType }); } catch { continue; }
  walk(ast, (n) => {
    const s = n.type === 'Literal' ? n.value : n.type === 'TemplateElement' ? n.value?.cooked : null;
    if (typeof s === 'string' && s.length > 50000 && /function|=>/.test(s.slice(0, 5000))) {
      workers++;
      check(`встроенный воркер № ${workers}`, s, 'script');
    }
  });
}
if (!workers) fail('не найден встроенный воркер подбора фаз');

if (fails) {
  console.log(`\nпроверка не пройдена, ошибок: ${fails}`);
  process.exit(1);
}
console.log('\nпроверка пройдена');
