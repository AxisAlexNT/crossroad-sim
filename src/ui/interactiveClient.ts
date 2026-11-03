import { createCalculationWorker } from './calculationWorker';
import { InteractiveChannel } from './interactiveChannel';

export class InteractiveClient extends InteractiveChannel {
  constructor(wasm?: ArrayBuffer) {
    const worker = createCalculationWorker('interactive');
    super(worker);
    if (wasm) {
      try { worker.postMessage({ type: 'sandbox', wasm }); }
      catch (error) { this.dispose(); throw error; }
    }
  }
}
