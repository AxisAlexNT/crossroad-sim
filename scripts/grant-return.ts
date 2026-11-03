import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import type { ConflictRef } from '../src/engine/network';

const cfg = defaultModel('v1');
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60); const base = sim.st.vehicles[0]; assert.ok(base);
  const right = sim.net.conns.find(c => c.conn.id === 'E2-N0' && c.variant === 0)!;
  const left = sim.net.conns.find(c => c.conn.id === 'W0-N0' && c.variant === 0)!;
  const through = sim.net.conns.find(c => c.conn.id === 'S0-N0' && c.variant === 0)!;
  const cr = right.conflicts.find(ref => ref.other === left.idx && sim.net.conflicts[ref.conflict].kind === 'merge')!; assert.ok(cr);
  const zone = sim.net.conflicts[cr.conflict];
  const otherStart = cr.side === 'a' ? zone.bStart : zone.aStart;
  const make = (id: number, ci: number, s: number, len: number, entered: number): Vehicle => ({
    ...structuredClone(base), id, conn: ci, phase: 'conn', s, v: 0, a: 0, len, wid: 1.8, lat: 0, lat2: 0,
    origin: sim.net.conns[ci].conn.from.arm, dest: sim.net.conns[ci].conn.to.arm, tStop: entered,
    committed: [], acceptedGrants: undefined, why: 'yield', route: null, crashed: false, bayT: 0, bayShift: 0,
  });
  const giver = make(10001, right.idx, cr.start - 2.5, 4.5, 20);
  const recipient = make(10002, left.idx, otherStart - 13, 4.5, 10);
  const blockage = make(10003, through.idx, through.path.length - 12, 9.5, 30);
  giver.yieldTo = recipient.id; recipient.yieldTo = blockage.id; blockage.yieldTo = giver.id;
  recipient.committed = [cr.conflict]; recipient.acceptedGrants = { [cr.conflict]: giver.id };
  sim.st.vehicles = [giver, recipient, blockage]; sim.st.peds = []; sim.permit.fill('main');
  const internal = sim as unknown as { index(): void; firstHit(v: Vehicle, ci: number, start: number, end: number, o: Vehicle): number; mustWait(v: Vehicle, ci: number, ref: ConflictRef, start: number, end: number): boolean };
  const index = () => { for (const v of sim.st.vehicles) sim.pose(v); internal.index(); };
  const blocked = () => { index(); return internal.mustWait(giver, giver.conn, cr, cr.start - giver.s, cr.end - giver.s); };
  index();
  assert.equal(internal.firstHit(giver, giver.conn, giver.s, right.path.length + giver.len, blockage), Infinity);
  assert.ok(Number.isFinite(internal.firstHit(recipient, recipient.conn, recipient.s, left.path.length + recipient.len, blockage)));
  const stop = blockage.s;
  blockage.s = through.path.length + blockage.len + 2;
  assert.equal(blocked(), true, 'A recipient able to clear retains the accepted grant');
  blockage.s = stop; recipient.v = 1;
  assert.equal(blocked(), true, 'A moving recipient cannot return its grant');
  recipient.v = 0;
  const waiting = recipient.s; recipient.s = otherStart + .25;
  assert.equal(blocked(), true, 'An entered grant cannot be returned before rear clearance');
  recipient.s = waiting;
  assert.equal(blocked(), false, 'A blocked recipient can return an unentered grant through a stationary addressed cycle');
  assert.ok(!recipient.committed.includes(cr.conflict));
  assert.equal(recipient.acceptedGrants?.[cr.conflict], undefined);
  assert.ok(giver.committed.includes(cr.conflict));
  assert.equal(giver.acceptedGrants?.[cr.conflict], recipient.id);
  const reverse = left.conflicts.find(ref => ref.conflict === cr.conflict)!;
  assert.equal(internal.mustWait(recipient, recipient.conn, reverse, reverse.start - recipient.s, reverse.end - recipient.s), true,
    'The old recipient must honor the completed transfer instead of reclaiming it in the same cycle');
  console.log('Grant return: stationary consent, free path, entry order and atomic ownership checked.');
} finally { sim.dispose(); }
