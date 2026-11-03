import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateSession } from '../src/engine/session';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import type { ConflictRef } from '../src/engine/network';
const { cfg } = migrateSession(JSON.parse(readFileSync(new URL('../validation/repro-interlocking-v106.session.json', import.meta.url), 'utf8')));
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60); const base = sim.st.vehicles[0]; assert.ok(base);
  const busPath = sim.net.conns.find(c => c.conn.id === 'W2-S0' && c.variant === 0)!;
  const turn = sim.net.conns.find(c => c.conn.id === 'S0-W0' && c.variant === 1)!;
  const cr = busPath.conflicts.find(cr => cr.other === turn.idx && sim.net.conflicts[cr.conflict].body)!; assert.ok(cr);
  const make = (id: number, conn: number, phase: Vehicle['phase'], s: number, len: number, wid: number): Vehicle => ({
    ...structuredClone(base), id, conn, phase, s, v: 0, a: 0, len, wid, lat: 0, lat2: 0,
    origin: sim.net.conns[conn].conn.from.arm, dest: sim.net.conns[conn].conn.to.arm, lane: sim.net.conns[conn].conn.from.lane,
    committed: [], acceptedGrants: undefined, route: null, crashed: false, bayT: 0, bayShift: 0, tStop: 10,
  });
  const bus = make(10001, busPath.idx, 'conn', 18.0594, 12.2183, 2.55);
  const follower = make(10002, turn.idx, 'approach', sim.net.arms[turn.conn.from.arm].cfg.approachLength - 2.5, 4.6808, 1.8);
  const leader = make(10003, turn.idx, 'conn', 4.9749, 4.3505, 1.8);
  Object.assign(bus, {kind: 'bus', lat: .86023024, lat2: -.52540888}); Object.assign(follower, {lat: .08804312, lat2: .56845972}); Object.assign(leader, {lat: .27496355, lat2: -.65811499});
  follower.why = 'yield'; follower.yieldTo = leader.id; leader.why = 'yield'; leader.yieldTo = bus.id;
  sim.st.vehicles = [bus, follower, leader]; sim.st.peds = []; sim.permit.fill('main'); sim.permit[bus.conn] = 'arrow'; bus.entryPermit = 'arrow';
  const internal = sim as unknown as { index(): void; mustWait(v: Vehicle, ci: number, cr: ConflictRef, start: number, end: number): boolean };
  const waiting = () => { for (const v of sim.st.vehicles) sim.pose(v); internal.index(); return internal.mustWait(bus, bus.conn, cr, cr.start - bus.s, cr.end - bus.s); };
  assert.equal(waiting(), false, 'Очередь перед занятой собственной траекторией не резервирует чужой проезд');
  leader.v = 1;
  assert.equal(waiting(), true, 'Тронувшийся лидер снова делает подходящий поток возможной помехой');
  leader.v = 0;
  follower.committed = [cr.conflict]; follower.acceptedGrants = { [cr.conflict]: bus.id };
  assert.equal(waiting(), true, 'Уже принятая адресная уступка не отменяется распознаванием очереди');
  console.log('Очередь на подходе: остановившийся лидер, возобновление движения и адресный резерв проверены.');
} finally { sim.dispose(); }
