/** Путь при постоянном ускорении без движения задним ходом. Единицы: м/с, м/с², с. */
export function travelDistance(speed: number, acceleration: number, dt: number): number {
  if (acceleration < 0 && speed + acceleration * dt < 0) {
    return speed * speed / (-2 * acceleration);
  }
  return speed * dt + .5 * acceleration * dt * dt;
}

/** Верхняя граница ускорения, сохраняющая возможность остановки после следующего шага. */
export function stopPointAcceleration(speed: number, room: number, dt: number, braking: number): number {
  if (2 * room < speed * dt) return -speed * speed / (2 * room);
  const term = braking * dt;
  return (Math.sqrt(Math.max(0, term * term + 8 * braking * room - 4 * term * speed)) - term - 2 * speed) / (2 * dt);
}
