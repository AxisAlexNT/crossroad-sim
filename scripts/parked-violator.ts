import assert from 'node:assert/strict';
import { TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation } from '../src/engine/sim';

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
