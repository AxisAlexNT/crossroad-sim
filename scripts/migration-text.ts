import assert from 'node:assert/strict';
import { migrationLabels, humanFileError } from '../src/ui/migrationText';
const labels = migrationLabels([
  'модель.sim.drivers.reactionMax: значение преобразовано или не поддерживается.',
  'настройки.showTimers: значение не поддерживается.',
  'модель.connections[3].variants[0].shiftIn: значение преобразовано.',
  'настройки.unknown: параметр не поддерживается.',
]);
assert.deepEqual(labels, ['Водители: наибольшее время реакции', 'Отображение времени на светофорах', 'Сдвиг траектории у стоп-линии', 'Другие изменённые или неподдерживаемые параметры: 1']);
assert.ok(labels.every(label => !/[a-z]/i.test(label)));
assert.equal(migrationLabels(['модель.sim.drivers.a: changed', 'модель.sim.drivers.b: changed']).length, 1);
for (const err of [new SyntaxError('Unexpected token'), new Error('model.sim.private'), null]) {
  const message = humanFileError(err); assert.ok(!/[a-z]/i.test(message)); assert.ok(message.length > 20);
}
console.log('Сообщения миграции: понятные подписи, объединение параметров и безопасные ошибки.');
