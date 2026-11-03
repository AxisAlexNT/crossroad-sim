import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
const cfg = defaultModel('v1');
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60); const base = sim.st.vehicles[0]; assert.ok(base);
  const turn = sim.net.conns.find(c => c.conn.id === 'E0-S0' && c.variant === 0)!;
  const straight = sim.net.conns.find(c => c.conn.id === 'W1-E1' && c.variant === 0)!;
  const screen = sim.net.conns.find(c => c.conn.id === 'W0-N0' && c.variant === 0)!;
  const cr = straight.conflicts.find(c => c.other === turn.idx)!;
  const cf = sim.net.conflicts[cr.conflict];
  const otherStart = cr.side === 'a' ? cf.bStart : cf.aStart;
  const make = (id: number, conn: number, s: number, speed: number): Vehicle => ({
    ...structuredClone(base), id, conn, phase: 'conn', origin: sim.net.conns[conn].conn.from.arm,
    dest: sim.net.conns[conn].conn.to.arm, s, v: speed, a: 0, crashed: false, route: null,
    lcT: -1, stopsLeft: [], dwellUntil: -1, bayT: 0, bayShift: 0, ghostUntil: 0,
    entryPermit: 'main', committed: [cr.conflict], stuckSince: -1, yieldingAt: -1, yieldTo: -1,
  });
  const bus = make(10001, straight.idx, cr.start - 19, 10.5); bus.len = 12; bus.wid = 2.55;
  const car = make(10002, turn.idx, otherStart - .6, 2.8); car.len = 4.8; car.wid = 1.8;
  const blocker = make(10003, screen.idx, 6, 0); blocker.committed = [];
  sim.st.vehicles = [bus, car, blocker]; sim.st.peds = [];
  for (const v of sim.st.vehicles) sim.pose(v);
  const internal = sim as unknown as { index(): void; accel(v: Vehicle): number; occluded(v: Vehicle, a: number, b: number): boolean };
  internal.index(); sim.permit[straight.idx] = 'main'; sim.permit[turn.idx] = 'main';
  assert.equal(internal.occluded(bus, straight.idx, turn.idx), true);
  const acceleration = internal.accel(bus);
  assert.ok(acceleration < 0 && bus.why === 'yield' && bus.whyId === cr.conflict,
    `A reserved approach must brake for a newly visible conflicting reservation; got a=${acceleration}, ${bus.why}/${bus.whyId}`);
  sim.st.vehicles = [bus, car]; internal.index();
  assert.equal(internal.occluded(bus, straight.idx, turn.idx), false);
  const exposed = internal.accel(bus);
  assert.ok(exposed < 0 && bus.why === 'yield' && bus.whyId === cr.conflict,
    'Removing the screening vehicle must not disable conflict rechecking');
  car.s = (cr.side === 'a' ? cf.bEnd : cf.aEnd) + car.len + 2;
  sim.pose(car); internal.index();
  assert.ok(internal.accel(bus) > 0, 'A cleared participant must release the reserved crossing');
  console.log('Reserved crossing: newly visible conflicting participant triggers braking before the zone.');
} finally { sim.dispose(); }
