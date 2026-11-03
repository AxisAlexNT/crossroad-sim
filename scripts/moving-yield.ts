import assert from 'node:assert/strict';
import { TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import type { ConflictRef } from '../src/engine/network';

const cfg = TEMPLATES.find(t => t.id === 'skew')!.make();
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60);
  const base = sim.st.vehicles[0]; assert.ok(base);
  const straight = sim.net.conns.find(c => c.conn.id === 'SW0-NE0')!;
  const left = sim.net.conns.find(c => c.conn.id === 'NE0-E0')!;
  const cr = straight.conflicts.find(ref => ref.other === left.idx)!; assert.ok(cr);
  const zone = sim.net.conflicts[cr.conflict];
  const leftStart = cr.side === 'a' ? zone.bStart : zone.aStart;
  const priority: Vehicle = { ...structuredClone(base), id: 134, origin: 'SW', dest: 'NE', lane: 0, conn: straight.idx, phase: 'conn', s: 2.8, v: 2.04, a: 2.8, why: 'free', yieldingAt: -1, yieldTo: -1, committed: [] };
  const yielding: Vehicle = { ...structuredClone(base), id: 93, origin: 'NE', dest: 'E', lane: 0, conn: left.idx, phase: 'conn', s: leftStart - 3, v: 2.05, a: -7, why: 'yield', yieldingAt: cr.conflict, yieldTo: priority.id, committed: [] };
  sim.st.vehicles = [priority, yielding]; sim.st.peds = [];
  const internal = sim as unknown as {
    index(): void;
    yieldsTo(v: Vehicle, a: number, other: Vehicle, b: number): boolean;
    mustWait(v: Vehicle, ci: number, ref: ConflictRef, start: number, end: number): boolean;
  };
  const waits = () => {
    for (const v of sim.st.vehicles) sim.pose(v);
    internal.index();
    return internal.mustWait(priority, straight.idx, cr, cr.start - priority.s, cr.end - priority.s);
  };
  assert.equal(internal.yieldsTo(priority, straight.idx, yielding, left.idx), false);
  assert.equal(waits(), false, 'A priority driver must not brake for its addressed, braking yielder that can stop before the zone');
  yielding.yieldTo = 99999;
  assert.equal(waits(), true, 'Yielding to someone else cannot release the priority driver');
  yielding.yieldTo = priority.id; yielding.yieldingAt = cr.conflict + 1;
  assert.equal(waits(), true, 'An addressed yield in another zone cannot release this crossing');
  yielding.yieldingAt = cr.conflict;
  yielding.yieldTo = priority.id; yielding.a = 1;
  assert.equal(waits(), true, 'A moving participant still accelerating cannot be assumed to stop');
  yielding.a = -.1;
  assert.equal(waits(), true, 'Weak braking that does not stop before the zone cannot release passage');
  yielding.a = -7; yielding.committed = [cr.conflict];
  assert.equal(waits(), true, 'An addressed moving yield cannot silently revoke an existing reservation');
  yielding.committed = [];
  yielding.a = -7; yielding.s = leftStart - .1; yielding.v = 4;
  assert.equal(waits(), true, 'An addressed yield cannot override insufficient stopping distance');
  yielding.s = leftStart + .1; yielding.v = 2;
  assert.equal(waits(), true, 'A vehicle already in the conflict zone retains physical occupancy');
  yielding.phase = 'approach'; yielding.lane = left.conn.from.lane;
  sim.permit[left.idx] = 'main';
  yielding.s = sim.net.arms[yielding.origin].cfg.approachLength - 2;
  yielding.v = 3.75; yielding.a = -2; yielding.committed = [];
  assert.ok(leftStart + 2 > yielding.v * yielding.v / 8 + 1);
  assert.equal(waits(), false, 'Inability to stop at the line does not imply inability to stop before the conflict');
  yielding.s += leftStart + 1;
  assert.equal(waits(), true, 'A priority participant still yields to an unavoidable arrival at the conflict itself');
  console.log('Уступка в движении: приоритет, адресат, замедление и возможность остановки проверены.');
} finally { sim.dispose(); }
