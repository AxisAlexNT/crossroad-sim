import InteractiveWorker from '../engine/interactiveWorker?worker&inline';
import { InteractiveChannel } from './interactiveChannel';

export class InteractiveClient extends InteractiveChannel {
  constructor(wasm?: ArrayBuffer) {
    const worker = new InteractiveWorker();
    super(worker);
    if (wasm) {
      try { worker.postMessage({ type: 'sandbox', wasm }); }
      catch (error) { this.dispose(); throw error; }
    }
  }
}
