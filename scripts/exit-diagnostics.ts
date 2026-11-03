import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
const cfg = defaultModel('v1');
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(30);
  const template = sim.st.vehicles[0]; assert.ok(template);
  const conn = sim.net.conns.find(c => c.conn.id === 'W0-E0')!;
  const car: Vehicle = { ...structuredClone(template), id: 10001, origin: 'W', dest: 'E', phase: 'approach', lane: 0,
    conn: conn.idx, len: 4.5, wid: 1.8, s: sim.net.arms.W.cfg.approachLength - 2, why: 'exit', v: 0, bayT: 0, inBay: false };
  const bus: Vehicle = { ...structuredClone(template), id: 10002, kind: 'bus', origin: 'W', dest: 'E', phase: 'exit', outLane: 0,
    conn: conn.idx, len: 12, wid: 2.55, s: 8, v: 0, inBay: true, bayT: .1, bayShift: 0 };
  sim.st.vehicles = [car, bus];
  const internal = sim as unknown as { index(): void; exitBlocked(ci: number, v: Vehicle): boolean };
  internal.index();
  assert.equal(internal.exitBlocked(car.conn, car), true);
  assert.match(sim.explainVehicle(car), /свободно -4\.0 м/, 'Bus entering a bay still occupies the lane in both control and explanation');
  bus.s = 30; bus.bayT = 1; internal.index();
  assert.equal(internal.exitBlocked(car.conn, car), false);
  assert.match(sim.explainVehicle(car), new RegExp(`свободно ${sim.net.arms.E.cfg.exitLength.toFixed(1)} м`));
  bus.inBay = false; bus.bayT = 0; car.phase = 'conn'; car.s = 5; car.whyId = bus.id; internal.index();
  assert.match(sim.explainVehicle(car), /Впереди на выезде участник #10002, зазор/);
  console.log('Exit diagnostics: partial bay occupancy, released lane and downstream leader.');
} finally { sim.dispose(); }
