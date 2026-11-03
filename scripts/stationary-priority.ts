import assert from 'node:assert/strict';
import { TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import type { ConflictRef } from '../src/engine/network';

const cfg = TEMPLATES.find(t => t.id === 'skew')!.make();
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(30); const base = sim.st.vehicles[0]; assert.ok(base);
  const turn = sim.net.conns.find(c => c.conn.id === 'W0-NE0')!;
  const through = sim.net.conns.find(c => c.conn.id === 'E0-W0')!;
  const ref = turn.conflicts.find(r => r.other === through.idx)!; assert.ok(ref);
  const zone = sim.net.conflicts[ref.conflict];
  const otherStart = ref.side === 'a' ? zone.bStart : zone.aStart;
  const bus: Vehicle = { ...structuredClone(base), id: 10001, origin: 'W', dest: 'NE', conn: turn.idx, phase: 'conn', s: 8.35, v: 0, a: 0, kind: 'bus', len: 11.5, wid: 2.55, amax: 1.35, reaction: .5, yieldingAt: -1, yieldTo: -1, committed: [], dwellUntil: -1 };
  const truck: Vehicle = { ...structuredClone(base), id: 10002, origin: 'E', dest: 'W', conn: through.idx, phase: 'conn', s: 2.25, v: 0, a: 0, kind: 'truck', len: 11.3, wid: 2.5, amax: 1.35, why: 'free', yieldingAt: -1, yieldTo: -1, committed: [], dwellUntil: -1 };
  const internal = sim as unknown as { index(): void; mustWait(v: Vehicle, ci: number, ref: ConflictRef, start: number, end: number): boolean };
  sim.st.vehicles = [bus, truck]; sim.st.peds = [];
  sim.permit[turn.idx] = sim.permit[through.idx] = 'main';
  const waits = () => { internal.index(); return internal.mustWait(bus, turn.idx, ref, ref.start - bus.s, ref.end - bus.s); };
  assert.equal(waits(), true, 'An unreserved stationary priority vehicle may restart before the turning bus can clear');
  truck.why = 'yield'; truck.yieldTo = 99999;
  assert.equal(waits(), true, 'Waiting for someone else does not make arrival time infinite');
  truck.yieldingAt = ref.conflict; truck.yieldTo = bus.id;
  assert.equal(waits(), false, 'An addressed stationary grant still permits safe passage');
  truck.yieldingAt = -1; truck.yieldTo = -1; truck.why = 'bus'; truck.dwellUntil = sim.st.t + 60;
  assert.equal(waits(), false, 'A known remaining dwell may establish a usable gap');
  truck.dwellUntil = -1; truck.phase = 'approach'; truck.s = sim.net.arms.E.cfg.approachLength + otherStart - 50;
  truck.v = 1; truck.a = 1; truck.amax = 3; truck.v0f = 1; truck.why = 'free';
  assert.equal(waits(), true, 'The estimate must account for the actual acceleration and road speed of a distant fast participant');
  sim.permit[through.idx] = 'none';
  assert.equal(waits(), false, 'A participant still held before its stop line by a prohibiting signal does not approach the conflict');
  console.log('Приоритет: трогание стоящего участника, адресная уступка, стоянка и быстрый подход проверены.');
} finally { sim.dispose(); }
