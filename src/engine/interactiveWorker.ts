import '../polyfills';
import { initSandbox } from './sandbox';
import { InteractiveRuntime, type InteractiveRequest, type InteractiveReply } from './interactiveRuntime';

export function installInteractiveWorker() {
const runtime = new InteractiveRuntime();
let ready: Promise<unknown> = Promise.resolve();
let sandboxError: string | null = null;
type Request = InteractiveRequest | { type: 'sandbox'; wasm: ArrayBuffer };
self.onmessage = (event: MessageEvent<Request>) => {
  const message = event.data;
  if ('type' in message) {
    ready = ready.then(() => initSandbox(message.wasm)).catch(error => { sandboxError = error instanceof Error ? error.message : String(error); });
    return;
  }
  // Сериализация сохраняет порядок команд, пока загружается песочница.
  ready = ready.then(() => {
    let reply: InteractiveReply;
    try {
      if (sandboxError) throw new Error(sandboxError);
      reply = { id: message.id, frame: runtime.execute(message.command, message.details) }; }
    catch (error) { reply = { id: message.id, error: error instanceof Error ? error.message : String(error) }; }
    self.postMessage(reply);
  });
};

}
