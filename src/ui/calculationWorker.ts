import CalculationWorker from '../engine/calculationWorker?worker&inline';

export function createCalculationWorker(mode: 'interactive' | 'optimization' | 'experiment'): Worker {
  const worker = new CalculationWorker();
  // Сообщения одного отправителя поступают по порядку: сначала выбирается
  // обработчик, затем загружается песочница и принимаются задания клиента.
  worker.postMessage({ type: 'start-worker', mode });
  return worker;
}
