import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import type { ConflictRef } from '../src/engine/network';

const cfg = defaultModel('v1');
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60); const base = sim.st.vehicles[0]; assert.ok(base);
  const turn = sim.net.conns.find(c => c.conn.id === 'E0-S0' && c.variant === 0)!;
  const through = sim.net.conns.find(c => c.conn.id === 'W1-E1' && c.variant === 0)!;
  const downstream = sim.net.conns.find(c => c.conn.id === 'S0-W0' && c.variant === 1)!;
  const cr = turn.conflicts.find(ref => ref.other === through.idx)!; assert.ok(cr);
  const later = turn.conflicts.find(ref => ref.other === downstream.idx)!; assert.ok(later);
  const zone = sim.net.conflicts[later.conflict];
  const otherStart = later.side === 'a' ? zone.bStart : zone.aStart;
  const otherEnd = later.side === 'a' ? zone.bEnd : zone.aEnd;
  const make = (id: number, ci: number, s: number): Vehicle => ({
    ...structuredClone(base), id, conn: ci, phase: 'conn', s, v: 0, a: 0,
    origin: sim.net.conns[ci].conn.from.arm, dest: sim.net.conns[ci].conn.to.arm,
    len: 4.5, wid: 1.8, lat: 0, lat2: 0, s0: 1.5, committed: [], acceptedGrants: undefined,
    why: 'free', route: null, bayT: 0, bayShift: 0, crashed: false, stuckSince: 0,
  });
  const waiting = make(10001, turn.idx, cr.start - 6);
  const crossing = make(10002, through.idx, 0);
  const blockage = make(10003, downstream.idx, (otherStart + otherEnd) / 2);
  sim.st.vehicles = [waiting, crossing, blockage]; sim.st.peds = [];
  sim.permit.fill('main');
  for (const v of sim.st.vehicles) sim.pose(v);
  const internal = sim as unknown as { index(): void; wouldStopInside(v: Vehicle, ci: number, ref: ConflictRef, offset: number): boolean };
  internal.index();
  const blocked = () => internal.wouldStopInside(waiting, waiting.conn, cr, -waiting.s);
  cfg.sim.deadlockBreak = 0;
  assert.equal(blocked(), true, 'The downstream blockage leaves no room to clear the crossing');
  cfg.sim.deadlockBreak = 15;
  assert.equal(blocked(), true, 'Waiting longer cannot create storage beyond a conflict zone');
  blockage.s = downstream.path.length + blockage.len + 2;
  sim.pose(blockage); internal.index();
  assert.equal(blocked(), false, 'Clearing the downstream obstacle releases the crossing');
  console.log('Storage: prolonged waiting preserves downstream clearance, actual release restores passage.');
} finally { sim.dispose(); }
