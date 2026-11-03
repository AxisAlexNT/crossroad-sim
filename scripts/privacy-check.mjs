import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
let terms = [];
if (process.env.PRIVACY_TERMS) terms = JSON.parse(process.env.PRIVACY_TERMS);
else if (process.env.PRIVACY_TERMS_FILE) terms = JSON.parse(readFileSync(process.env.PRIVACY_TERMS_FILE, 'utf8'));
if (!Array.isArray(terms) || terms.some(t => typeof t !== 'string' || !t.trim())) throw new Error('Список запрещённых строк должен быть массивом непустых строк.');
const failures = new Set();
const credentials = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}/;
const scan = (label, text) => {
  if (text.includes('\0')) return;
  const lower = text.toLowerCase();
  if (credentials.test(text) || terms.some(term => lower.includes(term.toLowerCase()))) failures.add(label);
};
for (const file of new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))) {
  if (existsSync(file)) scan(file, readFileSync(file, 'utf8'));
}
for (const file of git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean)) scan('index:' + file, git(['show', ':' + file]));
if (existsSync('dist/index.html')) scan('dist/index.html', readFileSync('dist/index.html', 'utf8'));
scan('сообщения коммитов', git(['log', '-30', '--format=%B']));
if (failures.size) { console.error('Обнаружены закрытые данные в файлах:\n' + [...failures].join('\n')); process.exitCode = 1; }
else console.log(terms.length ? 'Конфиденциальность: проверены файлы, индекс, сборка и сообщения коммитов.' : 'Проверка ключей доступа пройдена. Для полной проверки частных упоминаний задайте внешний список PRIVACY_TERMS или PRIVACY_TERMS_FILE.');
