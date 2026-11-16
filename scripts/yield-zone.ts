import assert from 'node:assert/strict';
import { TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';

const cfg = TEMPLATES.find(t => t.id === 'cross4')!.make();
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60); const base = sim.st.vehicles[0]; assert.ok(base);
  const turn = sim.net.conns.find(c => c.conn.id === 'W0-N0' && c.variant === 0)!;
  const straight = sim.net.conns.find(c => c.conn.id === 'N0-S0' && c.variant === 0)!;
  const common = turn.conflicts.find(r => r.other === straight.idx)!; assert.ok(common);
  const make = (id: number, ci: number, s: number, len: number, lat: number, lat2: number): Vehicle => ({
    ...structuredClone(base), id, conn: ci, origin: sim.net.conns[ci].conn.from.arm,
    dest: sim.net.conns[ci].conn.to.arm, lane: 0, outLane: 0, phase: 'conn', s, v: 0, a: 0,
    len, kind: len > 10 ? 'bus' : 'car', wid: len > 10 ? 2.55 : 1.8,
    amax: len > 10 ? 1.35 : base.amax, bcomf: len > 10 ? 2 : 2.5,
    lat, lat2, route: null, stopsLeft: [],
    committed: [], acceptedGrants: undefined, why: 'free', whyId: -1, yieldingAt: -1, yieldTo: -1,
    crashed: false, entryPermit: 'main', stuckSince: -1, overStop: false, s0: 1.5,
  });
  const bus = make(10001, turn.idx, 9.287832463, 11.792563613, .438310101, -.566707252);
  const car = make(10002, straight.idx, 4.895161278, 4.686019291, .996883153, .054393924);
  bus.tStop = 10; car.tStop = 20;
  sim.st.vehicles = [bus, car]; sim.st.peds = []; sim.permit.fill('none');
  for (const v of sim.st.vehicles) sim.pose(v);
  const internal = sim as unknown as { index(): void; accel(v: Vehicle): number };
  internal.index(); internal.accel(car);
  assert.equal(car.why, 'yield'); assert.equal(car.yieldTo, bus.id);
  assert.equal(car.whyId, common.conflict, 'Причина должна указывать общее пересечение с фактическим адресатом уступки');
  assert.equal(car.yieldingAt, common.conflict, 'Адресная уступка относится к реальной общей зоне, даже при остановке перед более ранней зоной');
  console.log('Вложенная проверка сохраняет зону фактической уступки.');
} finally { sim.dispose(); }
