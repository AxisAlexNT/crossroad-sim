import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation } from '../src/engine/sim';
import { invalidRunReasons } from '../src/engine/runValidity';

const cfg = defaultModel('v1');
const make = () => new Simulation(structuredClone(cfg), compileModel(cfg).code, { headless: true });
const free = make(), capped = make();
try {
  free.runUntil(30); capped.runUntil(30);
  assert.ok(capped.st.peds.length);
  capped.st.peds = Array.from({ length: 600 }, () => structuredClone(capped.st.peds[0]));
  const before = free.st.counters.pedSpawned;
  const spawn = (sim: Simulation) => (sim as unknown as { spawnPeds(): void }).spawnPeds();
  for (let i = 0; i < 1000; i++) { spawn(free); spawn(capped); }
  const demand = free.st.counters.pedSpawned - before;
  assert.ok(demand > 0);
  assert.equal(free.st.counters.pedDropped, 0);
  assert.equal(capped.st.peds.length, 600, 'Capacity remains bounded');
  assert.equal(capped.st.counters.pedDropped, demand, 'Every rejected person is counted');
  assert.deepEqual(capped.st.arrivals, free.st.arrivals, 'Capacity must not pause arrival clocks');
  assert.ok(invalidRunReasons(capped.st.counters, 0).includes('потеря пешеходного спроса'));
  assert.equal(capped.logCounts['ped-capacity'], 1, 'Overflow warning is bounded');
  capped.st.peds = [];
  const freeStart = free.st.peds.length;
  for (let i = 0; i < 100; i++) { spawn(free); spawn(capped); }
  assert.ok(capped.st.peds.length > 0);
  assert.deepEqual(capped.st.peds.map(p => [p.size, p.speed, p.origin, p.dest]), free.st.peds.slice(freeStart).map(p => [p.size, p.speed, p.origin, p.dest]), 'Attributes remain reproducible after capacity is released');
  console.log('Pedestrian capacity: bounded groups, explicit rejected demand, continuous arrival and attribute streams.');
} finally { free.dispose(); capped.dispose(); }
