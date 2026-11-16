import assert from 'node:assert/strict';
import { TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';

const cfg = TEMPLATES.find(t => t.id === 'worked')!.make();
cfg.sim.seed = 42;
cfg.sim.mode = 'strict';
cfg.sim.diagnosticRecovery = false;
const { code, errors } = compileModel(cfg);
assert.deepEqual(errors, []);
const sim = new Simulation(cfg, code, { headless: true });
try {
  let sawParked = false, sawTarget = false;
  let clearedAt = Infinity;
  while (sim.st.t < 200) {
    sim.step();
    const target = sim.st.vehicles.find(v => v.id === 52);
    if (target?.phase === 'conn') sawTarget = true;
    if (sawTarget && target?.phase !== 'conn') clearedAt = Math.min(clearedAt, sim.st.t);
    if (sim.st.t < 100) continue;
    for (const v of sim.st.vehicles) {
      if (!v.overStop || sim.permit[v.conn] !== 'none') continue;
      sawParked = true;
      assert.deepEqual(v.committed, [], `Стоящий на красный автомобиль № ${v.id} удерживает зоны при t=${sim.st.t}`);
      assert.ok(!v.acceptedGrants || Object.keys(v.acceptedGrants).length === 0,
        `Стоящий на красный автомобиль № ${v.id} удерживает адресное разрешение`);
    }
  }
  assert.ok(sawParked, 'Сценарий должен включать остановку за стоп-линией на красный');
  assert.ok(sawTarget, 'Контрольный автомобиль должен въехать на перекрёсток');
  assert.ok(clearedAt < 165, `Автомобиль № 52 должен освободить перекрёсток до t=165, получено ${clearedAt}`);
  assert.equal(sim.st.counters.collisions, 0);
  assert.equal(sim.st.counters.deadlocks, 0);
  console.log(`Стоящие на красный не удерживают зоны, автомобиль № 52 освободил перекрёсток при t=${clearedAt.toFixed(1)}.`);
} finally { sim.dispose(); }

const priorityCfg = TEMPLATES.find(t => t.id === 'kolpino')!.make();
priorityCfg.sim.seed = 42; priorityCfg.sim.mode = 'strict'; priorityCfg.sim.diagnosticRecovery = false;
const prioritySim = new Simulation(priorityCfg, compileModel(priorityCfg).code, { headless: true });
try {
  prioritySim.runUntil(60);
  const base = prioritySim.st.vehicles[0]; assert.ok(base);
  const turn = prioritySim.net.conns.find(c => c.conn.id === 'E0-S0' && c.variant === 0)!;
  const straight = prioritySim.net.conns.find(c => c.conn.id === 'W1-E1' && c.variant === 0)!;
  assert.equal(turn.kind, 'left');
  const waiting: Vehicle = { ...structuredClone(base), id: 10001, origin: 'E', dest: 'S',
    conn: turn.idx, phase: 'approach', lane: 0, targetLane: 0, lcT: -1,
    s: prioritySim.net.arms.E.cfg.approachLength - 2.5, v: 0, a: 0,
    kind: 'car', len: 4.5, wid: 1.8, route: null, stopsLeft: [], dwellUntil: -1,
    committed: [], acceptedGrants: undefined, yieldTo: -1, yieldingAt: -1,
    crashed: false, overStop: false, goSince: -1 };
  const oncoming: Vehicle = { ...structuredClone(waiting), id: 10002, origin: 'W', dest: 'E',
    conn: straight.idx, lane: 1, targetLane: 1,
    s: prioritySim.net.arms.W.cfg.approachLength - 8, v: 8 };
  prioritySim.st.vehicles = [waiting, oncoming]; prioritySim.st.peds = []; prioritySim.permit.fill('main');
  for (const v of prioritySim.st.vehicles) prioritySim.pose(v);
  const internal = prioritySim as unknown as { index(): void; accel(v: Vehicle): number };
  internal.index(); internal.accel(waiting);
  assert.equal(waiting.why, 'yield', 'Левый поворот должен уступить приближающемуся встречному потоку');
  assert.equal(waiting.yieldTo, oncoming.id);
  assert.equal(waiting.yieldKind, 'oncoming', 'Причина ожидания должна объяснять встречный приоритет');
  assert.match(prioritySim.explainVehicle(waiting), /встречный поток/);
  console.log('Незащищённый левый поворот объясняет ожидание встречного потока.');
} finally { prioritySim.dispose(); }
