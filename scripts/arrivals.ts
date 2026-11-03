import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nativeSpawn } from '../src/engine/nodes';
import { defaultModel, TEMPLATES } from '../src/engine/presets';
import { genSpawnerCode } from '../src/engine/codegen';
import { compileModel, compileTs } from '../src/engine/compile';
import { initSandbox, SandboxNode } from '../src/engine/sandbox';
import { Simulation } from '../src/engine/sim';
import { decidePriority } from '../src/engine/priority';
import { rngNext, seedRng, pickWeighted } from '../src/engine/rng';
import type { NewVehicle, SpawnContext, SpawnerParams } from '../src/engine/types';

const params = (): SpawnerParams => ({ ...structuredClone(defaultModel('v1').spawners.E.params), arrival: 'uniform', rate: 10000, profile: [] });
function context(dt: number): SpawnContext {
  const arrivals = seedRng(42), attributes = seedRng(123);
  return { t: 0, dt, arm: 'E', memory: {}, random: () => rngNext(arrivals),
    uniform: (a, b) => a + (b - a) * rngNext(attributes),
    pick: weights => pickWeighted(attributes, Object.entries(weights)),
    pickWeighted: items => pickWeighted(attributes, items) };
}
function collect(p: SpawnerParams, dt: number, horizon: number, manual = false) {
  const ctx = context(dt), spawn = nativeSpawn(p), out: NewVehicle[] = [];
  const sandbox = manual ? new SandboxNode(compileTs(genSpawnerCode('E', p)).js) : undefined;
  try {
    for (let tick = 1; tick <= Math.round(horizon / dt); tick++) {
      ctx.t = +(tick * dt).toFixed(6);
      out.push(...(sandbox ? sandbox.call('spawn', [], 0, { t: ctx.t, dt, arm: ctx.arm, memory: ctx.memory }, ctx.random, () => ctx.uniform(0, 1)) as NewVehicle[] : spawn(ctx)));
    }
    return out;
  } finally { sandbox?.dispose(); }
}
for (const dt of [.5, .2, .1, .05]) {
  const events = collect(params(), dt, 18);
  assert.equal(events.length, 50, 'A uniform source must deliver its full intensity even when several arrivals fit into one step');
  assert.deepEqual(events.map(v => v.at), Array.from({ length: 50 }, (_, i) => +(0.36 * (i + 1)).toFixed(6)));
}
for (const dt of [.5, .2, .1, .05]) {
  const p = params(); p.rate = 0; p.profile = [{ from: 1, rate: 7200 }, { from: 1.5, rate: 0 }];
  assert.deepEqual(collect(p, dt, 3).map(v => v.at), [1.5], 'Profile changes inside a step must integrate their actual durations');
  p.rate = 1800; p.profile = []; p.arrival = 'platoon'; p.platoonSize = 4;
  assert.deepEqual(collect(p, dt, 24).map(v => v.at), [8, 16, 24].flatMap(t => Array(4).fill(t)));
}
await initSandbox(new Uint8Array(readFileSync(new URL('../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm', import.meta.url))));
for (const arrival of ['poisson', 'uniform', 'platoon'] as const) {
  const p = params(); p.arrival = arrival; p.platoonSize = 4; p.rate = 1234.567891234;
  p.profile = [{ from: 1.23456789, rate: 0 }, { from: 2.75678912, rate: 14400.123456789 }];
  const fine = collect(p, .05, 6);
  for (const dt of [.5, .2, .1, .05]) {
    assert.deepEqual(collect(p, dt, 6), fine, `${arrival}: event times and attributes must survive a step change`);
    assert.deepEqual(collect(p, dt, 6, true), fine, `${arrival}: generated code and native source must agree`);
  }
}

// Момент появления внутри шага имеет аналитическое время движения и ожидания.
{
  const cfg = defaultModel('v1'); cfg.sim.dt = .2;
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
  try {
    const internal = sim as any;
    internal.spawnFns = { E: (ctx: SpawnContext) => ctx.t === .2 ? [{ destination: 'W', kind: 'car', length: 4.5, at: .15 }] : [] };
    internal.spawnBuses = () => {}; internal.spawnPeds = () => {}; internal.accel = () => 0;
    sim.step(); const v = sim.st.vehicles[0]; assert.ok(v);
    assert.equal(v.tWanted, .15); assert.equal(v.tEnter, .15);
    const speed = cfg.arms.find(a => a.id === 'E')!.speedLimit / 3.6 * .9;
    assert.ok(Math.abs(v.s - speed * .05) < 1e-10, 'A newborn vehicle moves only after its actual arrival');
    assert.equal(v.stopTime, 0); assert.equal(sim.st.counters.waitArea, 0);
    const state = structuredClone(sim.st); sim.runUntil(1); const expected = structuredClone(sim.st);
    sim.restore(state); sim.runUntil(1); assert.deepEqual(sim.st, expected, 'Demand sequence must survive rewind');
  } finally { sim.dispose(); }
}
{
  const cfg = defaultModel('v1'); cfg.sim.dt = .2;
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
  try {
    const internal = sim as any, insert = internal.insertFromQueue.bind(sim);
    internal.spawnFns = { E: (ctx: SpawnContext) => ctx.t === .2 ? [{ destination: 'W', kind: 'car', length: 4.5, at: .15 }] : [] };
    internal.spawnBuses = () => {}; internal.spawnPeds = () => {}; internal.accel = () => 0;
    internal.insertFromQueue = () => {};
    sim.runUntil(.4);
    assert.ok(Math.abs(sim.st.counters.waitArea - .25) < 1e-10);
    assert.ok(Math.abs(sim.st.counters.delayArea - .25) < 1e-10);
    internal.insertFromQueue = insert; sim.step();
    const v = sim.st.vehicles[0]; assert.ok(v);
    assert.equal(v.tEnter, .4); assert.ok(Math.abs(v.stopTime - .25) < 1e-10);
    assert.ok(Math.abs(sim.st.counters.waitArea - v.stopTime) < 1e-10, 'Admission must not count external waiting twice');
  } finally { sim.dispose(); }
}
{
  const cfg = defaultModel('v1'); cfg.sim.dt = .5;
  cfg.transit.routes.forEach((r, i) => { r.perHour = i === 0 ? 100000 : 0; r.enabled = i === 0; });
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
  try {
    const route = cfg.transit.routes[0], arm = route.from;
    for (let i = 0; i < 1500; i++) sim.st.queue[arm].push({ nv: { destination: route.to, kind: 'car', length: 4.5 }, t: 0, rs: i });
    (sim as any).spawnFns = {}; (sim as any).insertFromQueue = () => {};
    sim.step();
    const rejected = sim.st.counters.busSpawned;
    assert.ok(rejected > 0); assert.equal(sim.st.queue[arm].length, 1500);
    assert.equal(sim.st.counters.dropped, rejected, 'Bus input must share the bounded external queue and account for rejected demand');
    sim.st.queue[arm] = []; sim.step();
    assert.equal(sim.st.queue[arm][0].demand!.serial, rejected + 1, 'Rejected demand must still advance its source identity');
  } finally { sim.dispose(); }
}

const births: unknown[][] = [];
for (const dt of [.2, .1, .05]) {
  const cfg = TEMPLATES.find(t => t.id === 'skew')!.make(); cfg.sim.seed = 1042; cfg.sim.dt = dt;
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
  const seen = new Set<number>(), rows: Array<{ demand: NonNullable<typeof sim.st.vehicles[number]['demand']>; [k: string]: unknown }> = [];
  try {
    while (sim.st.t < 1500) {
      sim.step();
      for (const v of sim.st.vehicles) if (!seen.has(v.id)) {
        seen.add(v.id); assert.ok(v.demand);
        rows.push({ demand: structuredClone(v.demand), time: v.tWanted, origin: v.origin, dest: v.dest, len: v.len, amax: v.amax, reaction: v.reaction, v0f: v.v0f });
      }
    }
    assert.equal(rows.length, 377);
    rows.sort((a, b) => a.demand.source < b.demand.source ? -1 : a.demand.source > b.demand.source ? 1 : a.demand.serial - b.demand.serial);
    births.push(rows);
    const legacy = structuredClone(sim.st); delete legacy.demandSerials;
    for (const v of legacy.vehicles) delete v.demand;
    for (const q of Object.values(legacy.queue)) for (const item of q) delete item.demand;
    sim.restore(legacy); sim.runUntil(1501); assert.ok(sim.st.vehicles.every(v => Number.isFinite(v.s)));
  } finally { sim.dispose(); }
}
assert.deepEqual(births[0], births[2], 'Exact input events and immutable driver attributes must agree across step sizes');
assert.deepEqual(births[1], births[2]);
const empty = { A: null, B: null };
const earlier = { id: 200, arm: 'A', left: false, illegal: false, clearing: false, arrow: false, tWanted: 1, demand: { source: 'car:A', serial: 1 } };
const later = { ...earlier, id: 1, arm: 'B', tWanted: 2, demand: { source: 'car:B', serial: 1 } };
assert.equal(decidePriority(earlier, later, empty, empty).yields, false, 'An arbitrary display number must not reverse equal-priority arrival order');
assert.equal(decidePriority(later, earlier, empty, empty).yields, true);
console.log('Прибытия: интенсивность, точные моменты, профиль, код, первый шаг и перемотка проверены.');
