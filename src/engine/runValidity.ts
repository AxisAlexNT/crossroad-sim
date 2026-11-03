import type { Counters } from './sim';

/** Проверяется весь прогон, включая прогрев: его отказы меняют начальное состояние окна. */
export function invalidRunReasons(c: Counters, interventions: number, recoveryEnabled = false): string[] {
  const reasons: string[] = [];
  const checks: Array<[number, string]> = [
    [c.interventions ?? 0, 'вмешательства модели'], [c.removedRecovery ?? 0, 'эвакуация при разъезде'],
    [c.errors, 'ошибки модели'], [c.codeErrors, 'ошибки пользовательского кода'],
    [c.collisions, 'столкновения'], [c.pedHits, 'наезды на пешеходов'],
    [c.dropped, 'потеря входного спроса'], [c.pedDropped, 'потеря пешеходного спроса'], [c.removedCrash, 'удаление участников после столкновения'],
    [c.pedRouteErrors, 'ошибки пешеходных маршрутов'], [c.deadlocks, 'взаимные блокировки'],
    [interventions, 'диагностические вмешательства'],
  ];
  for (const [count, label] of checks) if (!Number.isFinite(count) || count !== 0) reasons.push(label);
  if (recoveryEnabled) reasons.push('включён диагностический разъезд');
  return reasons;
}
