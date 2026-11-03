/** Подписи изменений сохранения без внутренних имён полей. */
export function migrationLabels(warnings: string[]): string[] {
  const labels = new Set<string>();
  const fields: Record<string, string> = {
    reactionMax: 'Водители: наибольшее время реакции', reactionMin: 'Водители: наименьшее время реакции',
    showTimers: 'Отображение времени на светофорах', theme: 'Цветовая тема', draftAsError: 'Проверка рекомендаций стандартов',
    shiftIn: 'Сдвиг траектории у стоп-линии', bend: 'Изгиб траектории', seed: 'Номер случайного прогона',
    dt: 'Шаг расчёта', crashDuration: 'Время освобождения места аварии', deadlockBreak: 'Время ожидания при блокировке',
  };
  let other = 0;
  for (const warning of warnings) {
    const path = warning.split(':')[0];
    const field = path.split('.').pop() ?? '';
    const label = fields[field];
    if (label) labels.add(label);
    else if (path.includes('.drivers.')) labels.add('Параметры поведения водителей');
    else if (path.includes('.connections')) labels.add('Направления движения и траектории');
    else if (path.includes('.signals')) labels.add('Программа светофоров');
    else if (path.includes('.peds')) labels.add('Пешеходные переходы и потоки');
    else if (path.includes('.transit')) labels.add('Маршруты и остановки общественного транспорта');
    else if (path.includes('.arms')) labels.add('Дороги и полосы');
    else if (path.includes('.sim.')) labels.add('Параметры расчёта движения');
    else other++;
  }
  if (other) labels.add(`Другие изменённые или неподдерживаемые параметры: ${other}`);
  return [...labels];
}

export function humanFileError(error: unknown): string {
  if (error instanceof SyntaxError) return 'Не удалось прочитать файл. Выберите файл модели или сессии, сохранённый этой программой.';
  return 'Не удалось открыть файл. Возможно, он повреждён, слишком большой или создан в неподдерживаемой версии. Исходное сохранение не изменено.';
}
