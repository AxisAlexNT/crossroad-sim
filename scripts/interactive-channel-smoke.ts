import assert from 'node:assert/strict';
import { InteractiveChannel } from '../src/ui/interactiveChannel';

class TestWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  failSend = false;
  sent: Array<{ id: number }> = [];
  postMessage(message: { id: number }) {
    if (this.failSend) throw new Error('clone failure');
    this.sent.push(message);
  }
  terminate() { this.terminated = true; }
  reply(id: number, extra = { frame: null } as object) { this.onmessage?.({ data: { id, ...extra } }); }
}
const make = (timeout = 1000) => {
  const worker = new TestWorker();
  return { worker, client: new InteractiveChannel(worker as unknown as Worker, timeout) };
};
{
  const { worker, client } = make();
  const first = client.request({ type: 'snapshot' });
  await assert.rejects(client.request({ type: 'snapshot' }), /ещё не завершён/);
  worker.reply(999);
  assert.equal(client.busy, true, 'Чужой ответ не освобождает запрос');
  worker.reply(worker.sent[0].id);
  assert.equal(await first, null);
  assert.equal(client.busy, false);
  const second = client.request({ type: 'snapshot' });
  worker.reply(worker.sent[0].id);
  assert.equal(client.busy, true, 'Повтор старого ответа не завершает новую команду');
  worker.reply(worker.sent[1].id, { error: 'model failure' });
  await assert.rejects(second, /model failure/);
  worker.failSend = true;
  await assert.rejects(client.request({ type: 'snapshot' }), /clone failure/);
  assert.equal(client.busy, false);
  client.dispose();
}
for (const mode of ['dispose', 'error', 'messageerror', 'timeout']) {
  const { worker, client } = make(mode === 'timeout' ? 10 : 1000);
  const request = client.request({ type: 'snapshot' });
  const rejected = assert.rejects(request);
  if (mode === 'dispose') client.dispose();
  if (mode === 'error') worker.onerror?.({ message: 'worker failure' });
  if (mode === 'messageerror') worker.onmessageerror?.();
  await rejected;
  assert.equal(worker.terminated, true, mode);
  assert.equal(client.busy, false, mode);
  worker.reply(1);
  await assert.rejects(client.request({ type: 'snapshot' }), /остановлена/);
  client.dispose();
}
console.log('Канал фоновой модели: порядок ответов, ограничение запросов, ошибки, отмена и тайм-аут');
