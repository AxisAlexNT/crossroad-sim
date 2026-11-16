import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Counters, type Vehicle } from '../src/engine/sim';

const cfg = defaultModel('v1');
cfg.sim.mode = 'strict'; cfg.sim.diagnosticRecovery = false;
const sim = new Simulation(cfg, compileModel(cfg).code);
try {
  sim.runUntil(60);
  const base = sim.st.vehicles[0]; assert.ok(base);
  const turn = sim.net.conns.find(c => c.conn.id === 'E0-S0' && c.variant === 0)!;
  const waiting: Vehicle = { ...structuredClone(base), id: 10001, phase: 'conn',
    conn: turn.idx, origin: 'E', dest: 'S', lane: 0, s: 3, v: 0, a: 0,
    why: 'yield', whyId: -1, yieldTo: -1, yieldingAt: -1, yieldKind: 'oncoming',
    stopSince: 60, holdLogged: false, crashed: false, route: null, dwellUntil: -1 };
  sim.st.vehicles = [waiting]; sim.st.peds = [];
  const before = sim.st.counters.longHolds;
  const internal = sim as unknown as { diagnose(): void };
  const diagnose = (t: number) => { sim.st.t = t; internal.diagnose(); };
  const holds = () => sim.log.filter(e => e.code === 'hold' && e.vid === waiting.id);
  diagnose(79.9);
  assert.equal(sim.st.counters.longHolds, before, 'До 20 секунд событие не учитывается');
  diagnose(80);
  assert.equal(sim.st.counters.longHolds, before + 1);
  assert.equal(holds().length, 1);
  assert.equal(holds()[0].level, 'info');
  assert.match(holds()[0].msg, /встречный поток/);
  const saved = structuredClone(sim.st);
  diagnose(81);
  waiting.v = 1; diagnose(82);
  waiting.v = 0; diagnose(83); diagnose(104);
  assert.equal(sim.st.counters.longHolds, before + 1, 'Повторная остановка той же машины не создаёт второе событие');
  assert.equal(holds().length, 1);
  const excluded = (id: number, phase: Vehicle['phase'], why: Vehicle['why']): Vehicle => ({
    ...structuredClone(waiting), id, phase, why, stopSince: 80, holdLogged: false,
    crashed: why === 'crash',
  });
  sim.st.vehicles.push(excluded(10002, 'conn', 'signal'), excluded(10003, 'conn', 'crash'),
    excluded(10004, 'approach', 'yield'), excluded(10005, 'exit', 'yield'));
  diagnose(110);
  assert.equal(sim.st.counters.longHolds, before + 1, 'Красный сигнал, авария и остановки вне перекрёстка исключаются');
  assert.match(sim.explainVehicle(sim.st.vehicles[1]), /за стоп-линией/);
  assert.equal(sim.explainVehicle({ ...waiting, why: 'ped' }), 'Ждёт пешеходов на переходе.');

  sim.restore(saved); diagnose(81);
  assert.equal(sim.st.counters.longHolds, before + 1, 'Восстановление снимка сохраняет счётчик');
  assert.equal(sim.st.vehicles[0].holdLogged, true);
  assert.equal(sim.st.vehicles[0].yieldKind, 'oncoming');
  assert.equal(holds().length, 1, 'Восстановленная машина не создаёт дубликат');
  const legacy = structuredClone(saved);
  delete (legacy.counters as Partial<Counters>).longHolds;
  for (const v of legacy.vehicles) {
    delete (v as Partial<Vehicle>).yieldKind;
    delete (v as Partial<Vehicle>).holdLogged;
  }
  sim.restore(legacy);
  assert.equal(sim.st.counters.longHolds, 0, 'Старый снимок получает безопасный нулевой счётчик');
  assert.equal(sim.st.vehicles[0].yieldKind, '');
  assert.equal(sim.st.vehicles[0].holdLogged, false);
  diagnose(81);
  assert.equal(sim.st.counters.longHolds, 1);
  console.log('Длительная остановка: порог, исключения, однократный учёт и восстановление снимков проверены.');
} finally { sim.dispose(); }
