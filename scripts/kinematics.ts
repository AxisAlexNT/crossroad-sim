import assert from 'node:assert/strict';
import { travelDistance } from '../src/engine/kinematics';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);
// Остановка с 1 м/с при замедлении 7 м/с²: t = 1/7 с, путь = 1/14 м.
close(travelDistance(1, -7, .2), 1 / 14);
close(travelDistance(1, -7, .15), 1 / 14);
for (const dt of [.2, .1, .05, .02]) {
  let speed = 1, distance = 0;
  for (let t = 0; t < 1; t += dt) {
    distance += travelDistance(speed, -7, dt);
    speed = Math.max(0, speed - 7 * dt);
  }
  close(distance, 1 / 14);
}
close(travelDistance(2, 3, .2), .46);
close(travelDistance(5, 0, .2), 1);
close(travelDistance(0, -7, .2), 0);
close(travelDistance(.001, -.01, .2), .00005);
close(travelDistance(3, -15, .2), .3);
console.log('Кинематика: аналитический тормозной путь и разбиение шага совпадают.');
