/** Путь при постоянном ускорении без движения задним ходом. Единицы: м/с, м/с², с. */
export function travelDistance(speed: number, acceleration: number, dt: number): number {
  if (acceleration < 0 && speed + acceleration * dt < 0) {
    return speed * speed / (-2 * acceleration);
  }
  return speed * dt + .5 * acceleration * dt * dt;
}
