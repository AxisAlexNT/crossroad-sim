import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import type { ConflictRef } from '../src/engine/network';

const cfg = defaultModel('v1');
cfg.sim.mode = 'strict';
cfg.sim.diagnosticRecovery = false;
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(30);
  const base = sim.st.vehicles[0]; assert.ok(base);
  const turn = sim.net.conns.find(c => c.conn.id === 'W0-N0' && c.variant === 0)!;
  const through = sim.net.conns.find(c => c.conn.id === 'E1-W1' && c.variant === 0)!;
  const ref = turn.conflicts.find(r => r.other === through.idx && !sim.net.conflicts[r.conflict].body)!;
  assert.ok(ref);
  const bus: Vehicle = { ...structuredClone(base), id: 10001, kind: 'bus', phase: 'conn',
    conn: turn.idx, origin: 'W', dest: 'N', lane: 0,
    s: 18.776875770149307, v: 0.6014548892335814, a: -4.587744369257543,
    len: 12, wid: 2.55, s0: 1.5, route: null, stopsLeft: [],
    committed: turn.conflicts.map(r => r.conflict), acceptedGrants: undefined,
    crashed: false, entryPermit: 'main', yellowDecision: 0, stopSince: -1 };
  const car: Vehicle = { ...structuredClone(base), id: 10002, phase: 'approach',
    conn: through.idx, origin: 'E', dest: 'W', lane: 1,
    s: 127.25812248699371, v: 15.891339575965565, a: -0.032130702097823614,
    route: null, committed: [], acceptedGrants: undefined,
    crashed: false, entryPermit: 'none', yellowDecision: 0, stopSince: -1 };
  const internal = sim as unknown as {
    yellowMain: boolean[];
    index(): void;
    yieldsTo(a: Vehicle, ai: number, b: Vehicle, bi: number): boolean;
    mustWait(v: Vehicle, ci: number, ref: ConflictRef, start: number, end: number): boolean;
    clearYieldGap(v: Vehicle, conflict: number, gap: number): number;
    accel(v: Vehicle): number;
  };
  sim.st.vehicles = [bus, car]; sim.st.peds = [];
  sim.permit.fill('none'); internal.yellowMain[through.idx] = true;
  sim.pose(bus); sim.pose(car); internal.index();
  // Оценка одного снимка не зависит от порядка вызовов ускорения.
  assert.equal(internal.yieldsTo(bus, turn.idx, car, through.idx), true);
  assert.equal(internal.mustWait(bus, turn.idx, ref, ref.start - bus.s, ref.end - bus.s), true);
  assert.equal(car.yellowDecision, 0, 'Проверка чужого решения не меняет состояние водителя');

  // В следующем шаге доступное место мало, но остановка ещё физически возможна.
  bus.s = 18.82618005289669; bus.v = 0.38463076571403343;
  car.yellowDecision = 1;
  sim.pose(bus); internal.index();
  const room = internal.clearYieldGap(bus, ref.conflict, ref.start - bus.s - 1) - bus.s0;
  assert.ok(room > 0 && bus.v * bus.v / 14 <= room);
  const acceleration = internal.accel(bus);
  assert.ok(acceleration < 0);
  assert.ok(bus.v * bus.v / (-2 * acceleration) <= room + 1e-9,
    'Торможение сохраняет выбранную точку ожидания и не переводит машину обратно к разгону');

  car.yellowDecision = 2; car.v = 0;
  assert.equal(internal.yieldsTo(bus, turn.idx, car, through.idx), false,
    'Останавливающийся участник не получает права завершения фазы');
  car.yellowDecision = 0; sim.permit[through.idx] = 'main';
  assert.equal(internal.yieldsTo(bus, turn.idx, car, through.idx), false,
    'Новый зелёный уступает завершающему поворот');
} finally { sim.dispose(); }
