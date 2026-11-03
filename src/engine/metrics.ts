/** Потеря времени на шаге относительно движения с заданной свободной скоростью. */
export function timeLoss(dt: number, distance: number, freeSpeed: number): number {
  if (!(dt >= 0) || !Number.isFinite(dt) || !Number.isFinite(distance) || !(freeSpeed > 0) || !Number.isFinite(freeSpeed)) throw new Error('Недопустимые параметры измерения задержки.');
  return Math.max(0, dt - Math.max(0, distance) / freeSpeed);
}
