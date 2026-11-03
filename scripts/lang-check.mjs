// Проверяется статический текст шаблонов Vue, подписи атрибутов и текст уведомлений.
// Код, имена полей, адреса ссылок, закрытые технические подробности и динамические
// значения из модели не проверяются. Это не замена проверке готового интерфейса.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { parse as parseTemplate } from '@vue/compiler-dom';
import ts from 'typescript';

// Названия форматов, атрибуция и подписи клавиш сохраняют общепринятое написание.
const allowed = new Set(['PDF', 'SVG', 'CSV', 'OpenStreetMap', 'ODbL', 'v', 'F', 'T', 'Escape']);
const visibleAttributes = new Set(['title', 'aria-label', 'placeholder', 'alt']);
let checked = 0;
const issues = [];
function inspect(text, path, line, kind) {
  checked++;
  for (const word of text.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? []) {
    if (allowed.has(word)) continue;
    if (word === 'JSON' && /файл(?:а|е|ом|ы|ов)?\s+JSON/i.test(text)) continue;
    issues.push(`${path}:${line}: ${kind}: ${word}`);
  }
}
function scriptCheck(source, path, offset = 0) {
  const file = ts.createSourceFile(path + '.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const line = node => offset + file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const hasRawError = node => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'message') return true;
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'String' && /^(err|error|e)$/.test(node.arguments[0]?.getText(file) ?? '')) return true;
    return ts.forEachChild(node, hasRawError) ?? false;
  };
  const literalText = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) inspect(node.text, path, line(node), 'уведомление');
    else if (ts.isTemplateExpression(node)) {
      inspect(node.head.text, path, line(node), 'уведомление');
      for (const span of node.templateSpans) inspect(span.literal.text, path, line(span), 'уведомление');
    } else if (ts.isBinaryExpression(node)) { literalText(node.left); literalText(node.right); }
  };
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'toast') {
      for (const argument of node.arguments) {
        if (hasRawError(argument)) issues.push(`${path}:${line(node)}: сырое исключение в уведомлении`);
        literalText(argument);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && /^(app\.interactiveError|error\.value|jsonErr\.value)$/.test(node.left.getText(file)) && hasRawError(node.right)) {
      issues.push(`${path}:${line(node)}: сырое исключение в сообщении`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}
function walkTemplate(node, path, offset) {
  if (node.type === 1) {
    if (['code', 'pre', 'script', 'style'].includes(node.tag)) return;
    for (const prop of node.props) if (prop.type === 6 && visibleAttributes.has(prop.name) && prop.value) inspect(prop.value.content, path, offset + prop.loc.start.line - 1, 'подпись');
    if (node.tag === 'details' && node.children.some(child => child.type === 1 && child.tag === 'summary' && /Подробности для разработчика/.test(child.loc.source))) {
      for (const child of node.children.filter(child => child.type === 1 && child.tag === 'summary')) walkTemplate(child, path, offset);
      return;
    }
  }
  if (node.type === 2) inspect(node.content, path, offset + node.loc.start.line - 1, 'текст');
  for (const child of node.children ?? []) walkTemplate(child, path, offset);
}
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (entry.name.endsWith('.vue')) {
      const { descriptor } = parseSfc(readFileSync(path, 'utf8'));
      if (descriptor.template) walkTemplate(parseTemplate(descriptor.template.content), path, descriptor.template.loc.start.line);
      for (const block of [descriptor.script, descriptor.scriptSetup]) if (block) scriptCheck(block.content, path, block.loc.start.line - 1);
    } else if (entry.name.endsWith('.ts')) scriptCheck(readFileSync(path, 'utf8'), path);
  }
}
// Контроль самого сканера: служебный код не виден, английские подписи
// и прямой вывод исключений должны обнаруживаться.
walkTemplate(parseTemplate('<label title="Choose File">No file chosen</label>'), 'контроль', 1);
assert.equal(issues.length, 5);
issues.length = 0;
walkTemplate(parseTemplate('<p>Скачать PDF</p><pre>technical source</pre><p>{{ internal.field }}</p>'), 'контроль', 1);
scriptCheck("toast('Модель открыта'); const internal = 'identifier';", 'контроль');
assert.equal(issues.length, 0);
scriptCheck('toast(error.message); error.value = err.message;', 'контроль');
assert.equal(issues.length, 2);
issues.length = 0; checked = 0;
scan('src/ui');
const { descriptor } = parseSfc(readFileSync('src/App.vue', 'utf8'));
if (descriptor.template) walkTemplate(parseTemplate(descriptor.template.content), 'src/App.vue', descriptor.template.loc.start.line);
if (issues.length) { console.error([...new Set(issues)].join('\n')); process.exitCode = 1; }
else console.log(`Язык интерфейса: проверено ${checked} статических фрагментов и путей уведомлений. Динамические значения требуют отдельной проверки.`);
