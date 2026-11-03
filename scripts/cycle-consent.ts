import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';

// Неподвижный цикл из публичной модели v1/3042. Ни один из стоящих
// кузовов не пересекает полный путь принимающего адресную уступку.
const cfg = defaultModel('v1');
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  sim.runUntil(60); const base = sim.st.vehicles[0]; assert.ok(base);
  const make = (id: number, movement: string, variant: number, s: number, len: number, lat: number, lat2: number, entered: number): Vehicle => {
    const c = sim.net.conns.find(c => c.conn.id === movement && c.variant === variant)!; assert.ok(c);
    return { ...structuredClone(base), id, conn: c.idx, phase: 'conn', s, v: 0, a: 0,
      origin: c.conn.from.arm, dest: c.conn.to.arm, len, wid: 1.8, lat, lat2, tStop: entered,
      committed: [], acceptedGrants: undefined, why: 'yield', route: null, bayT: 0, bayShift: 0, crashed: false };
  };
  const first = make(10001, 'S0-W0', 1, 15.658858, 4.32587, .339016, -.244591, 4405.2);
  const second = make(10002, 'N0-S0', 1, 24.857983, 4.70877, -.586142, .971615, 4411.4);
  const third = make(10003, 'W1-E1', 0, 13.576733, 4.77357, .391951, -.867278, 4460);
  first.yieldTo = second.id; second.yieldTo = third.id; third.yieldTo = first.id;
  sim.st.vehicles = [first, second, third]; sim.st.peds = [];
  const internal = sim as unknown as { index(): void; acceptSiblingGrant(v: Vehicle, ci: number, other: Vehicle): boolean; firstHit(v: Vehicle, ci: number, from: number, until: number, other: Vehicle): number };
  for (const v of sim.st.vehicles) sim.pose(v);
  internal.index();
  assert.equal(internal.acceptSiblingGrant(second, second.conn, third), false, 'A later entrant cannot reverse the waiting cycle into a competing grant');
  assert.equal(internal.acceptSiblingGrant(third, third.conn, first), false);
  assert.equal(internal.acceptSiblingGrant(first, first.conn, second), true, 'A clear addressed cycle can release the earliest entrant');
  third.v = 1;
  assert.equal(internal.acceptSiblingGrant(first, first.conn, second), false, 'A moving participant cannot consent to a stationary-cycle transfer');
  third.v = 0; third.yieldTo = 99999;
  assert.equal(internal.acceptSiblingGrant(first, first.conn, second), false, 'Waiting for someone else is not consent to this recipient');
  third.yieldTo = first.id; third.s = 21;
  sim.pose(third); internal.index();
  assert.ok(Number.isFinite(internal.firstHit(first, first.conn, first.s, sim.net.conns[first.conn].path.length + first.len, third)));
  assert.equal(internal.acceptSiblingGrant(first, first.conn, second), false, 'Entry order cannot release a path physically occupied by a stopped body');
  console.log('Cycle consent: entry order, addressed consent and stationary bodies checked.');
} finally { sim.dispose(); }
