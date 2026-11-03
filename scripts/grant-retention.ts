import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import type { ConflictRef } from '../src/engine/network';

const cfg = defaultModel('v1');
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60); const base = sim.st.vehicles[0]; assert.ok(base);
  const giverPath = sim.net.conns.find(c => c.conn.id === 'E0-S0' && c.variant === 0)!;
  const busPath = sim.net.conns.find(c => c.conn.id === 'N0-S0' && c.variant === 0)!;
  const cr = giverPath.conflicts.find(ref => ref.other === busPath.idx && sim.net.conflicts[ref.conflict].kind === 'merge')!; assert.ok(cr);
  const zone = sim.net.conflicts[cr.conflict];
  assert.equal(cr.side === 'a' ? zone.bEnd : zone.aEnd, busPath.path.length);
  const giver: Vehicle = { ...structuredClone(base), id: 10001, origin: 'E', dest: 'S', conn: giverPath.idx,
    phase: 'approach', lane: 0, s: sim.net.arms.E.cfg.approachLength - 20, v: 0, a: 0,
    committed: [], acceptedGrants: undefined, crashed: false, route: null };
  const bus: Vehicle = { ...structuredClone(base), id: 10002, origin: 'N', dest: 'S', conn: busPath.idx,
    phase: 'exit', outLane: 0, s: 11.75, v: 0, a: 0, len: 12, wid: 2.55,
    committed: [cr.conflict], acceptedGrants: { [cr.conflict]: giver.id }, crashed: false, route: null, inBay: false, bayT: 0, bayShift: 0 };
  sim.st.vehicles = [giver, bus]; sim.st.peds = []; sim.permit.fill('main');
  const internal = sim as unknown as { index(): void; mustWait(v: Vehicle, ci: number, ref: ConflictRef, start: number, end: number): boolean };
  const blocked = () => {
    for (const v of sim.st.vehicles) sim.pose(v);
    internal.index();
    return internal.mustWait(giver, giver.conn, cr, 20 + cr.start, 20 + cr.end);
  };
  assert.equal(blocked(), true, 'The accepted grant survives connector-to-exit transition until the bus rear clears');
  bus.s = 12.25;
  assert.equal(blocked(), false, 'Rear clearance releases accepted passage on the exit');
  bus.s = 11.75; bus.acceptedGrants = undefined;
  assert.equal(blocked(), false, 'An ungranted exit vehicle is handled by ordinary exit-capacity rules');
  console.log('Accepted passage: bus rear clearance across connector-to-exit transition checked.');
} finally { sim.dispose(); }
