import { installInteractiveWorker } from './interactiveWorker';
import { installOptimizationWorker } from './optWorker';
import { installExperimentWorker } from './experimentWorker';

/** Один встроенный код, отдельное состояние и жизненный цикл каждого расчёта. */
self.onmessage = (event: MessageEvent<{ type: string; mode: string }>) => {
  if (event.data.type !== 'start-worker') throw new Error('Режим фонового расчёта не выбран.');
  switch (event.data.mode) {
    case 'interactive': installInteractiveWorker(); break;
    case 'optimization': installOptimizationWorker(); break;
    case 'experiment': installExperimentWorker(); break;
    default: throw new Error('Неизвестный режим фонового расчёта.');
  }
};
