import '../polyfills';
import { runExperiment, type ExperimentSpec } from './experiment';
import { initSandbox } from './sandbox';
self.onmessage = async (e: MessageEvent<{ spec: ExperimentSpec; wasm?: ArrayBuffer }>) => {
  try {
    if (e.data.wasm) await initSandbox(e.data.wasm);
    const result = runExperiment(e.data.spec, progress => self.postMessage({ progress }));
    self.postMessage({ result });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
