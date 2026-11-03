import assert from 'node:assert/strict';
import { alignChartValues } from '../src/ui/chartAlignment';
assert.deepEqual(alignChartValues([0, 2], [0, 20], [-1, 0, 1, 2, 3]), [NaN, 0, 10, 20, NaN], 'Разные шаги отображаются без ложных разрывов и продолжения за границы прогона');
assert.deepEqual(alignChartValues([0, 1, 2], [0, NaN, 20], [.5, 1, 1.5]), [NaN, NaN, NaN], 'Отсутствующие измерения не заменяются вымышленными значениями');
assert.deepEqual(alignChartValues([], [], [0]), [NaN]);
assert.deepEqual(alignChartValues([1], [5], [0, 1, 2]), [NaN, 5, NaN]);
console.log('Сравнение графиков: разные шаги, границы и пропуски измерений проверены.');
