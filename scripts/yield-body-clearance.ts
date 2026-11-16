import assert from 'node:assert/strict';
import { TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import type { ConflictRef } from '../src/engine/network';

const cfg = TEMPLATES.find(t => t.id === 'cross4')!.make();
cfg.sim.mode = 'strict'; cfg.sim.diagnosticRecovery = false;
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60); const base = sim.st.vehicles[0]; assert.ok(base);
  const straight = sim.net.conns.find(c => c.conn.id === 'S0-N0' && c.variant === 0)!;
  const turn = sim.net.conns.find(c => c.conn.id === 'E0-S0' && c.variant === 0)!;
  const ref = straight.conflicts.find(r => r.other === turn.idx)!; assert.ok(ref);
  const receiver: Vehicle = { ...structuredClone(base), id: 10001, origin: 'E', dest: 'S', conn: turn.idx,
    kind: 'truck', phase: 'conn', lane: 0, s: 5.823532167, v: 0, a: 0,
    len: 10.8950938, wid: 2.5, lat: -.47890796, lat2: .900522079, route: null,
    committed: [], acceptedGrants: undefined, yieldingAt: -1, yieldTo: -1, crashed: false };
  const giver: Vehicle = { ...structuredClone(receiver), id: 10002, origin: 'S', dest: 'N', conn: straight.idx,
    kind: 'car', phase: 'conn', s: 7.268852897, len: 4.684096874, wid: 1.8,
    lat: .875560837, lat2: -.538144943, why: 'yield', yieldingAt: ref.conflict,
    yieldTo: receiver.id, committed: [ref.conflict] };
  const receivingRef = turn.conflicts.find(r => r.other === straight.idx)!;
  sim.st.vehicles = [receiver, giver]; sim.st.peds = []; sim.permit.fill('none'); sim.permit[straight.idx] = 'main';
  for (const v of sim.st.vehicles) sim.pose(v);
  const internal = sim as unknown as {
    index(): void;
    mustWait(v: Vehicle, ci: number, r: ConflictRef, start: number, end: number): boolean;
    firstHit(v: Vehicle, ci: number, from: number, until: number, other: Vehicle): number;
  };
  internal.index();
  assert.ok(Number.isFinite(internal.firstHit(receiver, turn.idx, receiver.s, receivingRef.end + receiver.len, giver)),
    'Кузов уступающего автомобиля должен фактически занимать путь принимающего');
  const offset = -receiver.s;
  assert.equal(internal.mustWait(receiver, turn.idx, receivingRef, offset + receivingRef.start, offset + receivingRef.end), true,
    'Адресная уступка не разрешает въехать на занятый кузовом путь');
  assert.ok(giver.committed.includes(ref.conflict), 'Небезопасное принятие не отзывает прежний резерв');
  console.log('Адресная уступка принимается только при физически свободном пути.');
} finally { sim.dispose(); }
