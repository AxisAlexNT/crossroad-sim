import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { buildNetwork, sweptBodyRadius } from '../src/engine/network';
import { compileModel } from '../src/engine/compile';
import { Simulation } from '../src/engine/sim';
import { invalidRunReasons } from '../src/engine/runValidity';
import { makePolyline } from '../src/engine/geometry';

const straight = makePolyline([{ x: 0, y: 0 }, { x: 50, y: 0 }]);
for (const length of [4, 12, 18]) assert.ok(Math.abs(sweptBodyRadius(straight, length, 2.55) - 1.275) < 1e-8, 'Straight bodies must not occupy adjacent lanes merely because they are long');
const cfg = defaultModel('v4');
const net = buildNetwork(cfg);
const cached = buildNetwork(structuredClone(cfg));
assert.deepEqual(cached.conflicts, net.conflicts, 'Repeated geometry must produce identical conflicts');
const changed = structuredClone(cfg);
changed.arms.find(a => a.id === 'S')!.angle += 13;
const changedNet = buildNetwork(changed);
assert.notDeepEqual(changedNet.conflicts, net.conflicts, 'Geometry edits must invalidate cached corridors');
assert.deepEqual(buildNetwork(cfg).conflicts, net.conflicts, 'Returning to a model must reproduce its original conflicts');
const turn = net.conns.find(c => c.conn.id === 'W2-S0' && c.variant === 0)!;
const through = net.conns.find(c => c.conn.id === 'S0-N0' && c.variant === 2)!;
assert.ok(sweptBodyRadius(turn.path, 12, 2.55) > 1.275, 'A turning bus sweeps beyond the nominal half width');
assert.ok(turn.conflicts.some(c => c.other === through.idx), 'Body corridor conflict must exist even without centerline intersection');
const parallel = net.conns.filter(c => c.conn.id === 'W0-E0' || c.conn.id === 'W1-E1');
assert.ok(parallel.length === 2);
assert.ok(!parallel[0].conflicts.some(c => c.other === parallel[1].idx), 'Separated straight lanes must remain independent');
console.log('Body corridor: straight lanes remain independent; turning bus conflict exists.');

// Независимый длинный регрессионный случай пропущенного конфликта кузовов.
// Критерий длительного отсутствия продвижения дополнительно проверяет test:stall.
cfg.sim.seed = 7042;
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true, dt: .1 });
try {
  sim.runUntil(10);
  const template = sim.st.vehicles[0];
  assert.ok(template);
  const left = net.conns.find(c => c.conn.id === 'W0-N0' && c.variant === 0)!;
  const straight = net.conns.find(c => c.conn.id === 'W1-E1' && c.variant === 0)!;
  const short = { ...template, id: -1, origin: 'W', dest: 'N', len: 4.6, wid: 1.8, lat: 0, lat2: 0, route: null };
  const van = { ...template, id: -2, origin: 'W', dest: 'E', len: 6.3, wid: 2, lat: 0, lat2: 0, route: null };
  assert.equal((sim as any).bodyConflictApplies(short, left.idx, van, straight.idx), false, 'Small vehicles must not reserve the corridor of a long bus');
  const bus = { ...short, id: -3, dest: 'S', len: 12, wid: 2.55, route: 'test' };
  const opposing = { ...van, id: -4, origin: 'S', dest: 'N', len: 5.4 };
  assert.equal((sim as any).bodyConflictApplies(bus, turn.idx, opposing, through.idx), true, 'Actual bus and van bodies conflict');
  sim.runUntil(7200);
  assert.deepEqual(invalidRunReasons(sim.st.counters, sim.logCounts['deadlock-manual'] ?? 0), []);
  assert.ok(sim.st.counters.crossedStop > 2000, 'The corridor fix must preserve traffic flow');
  console.log(`Body corridor replay: ${sim.st.counters.crossedStop} stop-line passages without invalid events.`);
} finally { sim.dispose(); }
