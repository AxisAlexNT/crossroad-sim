import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import { invalidRunReasons } from '../src/engine/runValidity';

const cfg = defaultModel('v5');
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  const replay = JSON.parse(readFileSync(new URL('../validation/replay-v25-v5-20042.json', import.meta.url), 'utf8'));
  const [leader, follower] = replay.vehicles as Vehicle[];
  const internal = sim as unknown as {
    siblingFollowing(v: Vehicle, other: Vehicle, until: number): { gap: number; speed: number } | null;
  };
  sim.pose(leader); sim.pose(follower);
  const until = sim.net.conns[follower.conn].path.length + 2;
  assert.ok(leader.s - leader.len - follower.s > 1.7, 'Raw distances incorrectly suggest a usable gap');
  const following = internal.siblingFollowing(follower, leader, until);
  assert.ok(following && following.gap < 0, 'The body envelope must prevent acceleration into the leader on a shorter variant');
  assert.equal(internal.siblingFollowing(leader, follower, until), null, 'The leader cannot follow its follower');
  follower.s -= 10; sim.pose(follower);
  assert.ok(internal.siblingFollowing(follower, leader, until)!.gap > 9, 'Backing away releases usable space');
  console.log('Sibling following: unequal path lengths, body clearance and consistent leader order.');
} finally { sim.dispose(); }

// Адресная уступка третьего участника не превращается в разрешение всему потоку.
for (const joiningId of ['S0-W0', 'S0-N0']) {
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
  try {
    sim.runUntil(60); const base = sim.st.vehicles[0]; assert.ok(base);
    const through = sim.net.conns.find(c => c.conn.id === 'E0-W0' && c.variant === 0)!;
    const turn = sim.net.conns.find(c => c.conn.id === 'E0-S0' && c.variant === 0)!;
    const cr = through.conflicts.find(c => c.conflict === 99)!; assert.ok(cr);
    const follower = { ...structuredClone(base), id: 2131, conn: through.idx, phase: 'conn' as const, origin: 'E', dest: 'W', s: 13.123210245720857, v: 0, a: 0, len: 4.425112426676788, committed: [] };
    const leader = { ...structuredClone(base), id: 2102, conn: turn.idx, phase: 'conn' as const, origin: 'E', dest: 'S', s: 26.16181938489778, v: 0, a: 0, len: 4.5230287542101, why: 'yield' as const, yieldTo: 10003, committed: [] };
    const joining = sim.net.conns.find(c => c.conn.id === joiningId && c.variant === 0)!;
    const granting = { ...structuredClone(base), id: 10003, conn: joining.idx, phase: 'conn' as const, s: 1, v: 0, why: 'yield' as const, yieldTo: follower.id, committed: [] as number[] };
    const internal = sim as unknown as { index(): void; siblingFollowing(v: Vehicle, other: Vehicle, until: number): { gap: number; speed: number } | null; wouldStopInside(v: Vehicle, ci: number, cr: typeof through.conflicts[number], offset: number): boolean; mustWait(v: Vehicle, ci: number, cr: typeof through.conflicts[number], start: number, end: number): boolean };
    sim.st.vehicles = [follower, leader, granting];
    for (const v of [follower, leader, granting]) sim.pose(v);
    const blocked = () => { internal.index(); return internal.wouldStopInside(follower, follower.conn, cr, -follower.s); };
    assert.equal(blocked(), false, 'An explicit grant to the follower releases a sibling whose body has cleared its path');
    assert.equal(internal.siblingFollowing(follower, leader, through.path.length), null, 'A clear diverging sibling must not remain a car-following obstacle after accepted passage');
    assert.ok(through.conflicts.some(ref => ref.other === joining.idx && sim.net.conflicts[ref.conflict].kind === (joiningId === 'S0-W0' ? 'merge' : 'cross') && follower.committed.includes(ref.conflict)), 'Accepting a grant must preserve merge order after the receiving vehicle starts');
    const merge = joining.conflicts.find(ref => ref.other === through.idx && sim.net.conflicts[ref.conflict].kind === (joiningId === 'S0-W0' ? 'merge' : 'cross'))!; assert.ok(merge);
    follower.why = 'merge'; follower.whyId = leader.id;
    assert.equal(internal.mustWait(granting, joining.idx, merge, merge.start - granting.s, merge.end - granting.s), true, 'The giver must honor the accepted merge grant even while the recipient is queued');
    const queuedAhead = { ...structuredClone(follower), id: 10004, s: follower.s + 8, v: 0 };
    sim.st.vehicles.push(queuedAhead); sim.pose(queuedAhead); internal.index();
    assert.notEqual(internal.siblingFollowing(follower, leader, through.path.length), null, 'A recipient blocked behind its own stopped leader cannot accept passage');
    sim.st.vehicles = sim.st.vehicles.filter(v => v.id !== queuedAhead.id); internal.index();
    granting.yieldTo = 99999;
    assert.equal(blocked(), true, 'A grant to someone else must not release the waiting follower');
    granting.yieldTo = follower.id; granting.v = 1;
    assert.equal(blocked(), true, 'A moving participant cannot be assumed to grant safe passage');
    granting.v = 0; follower.s = 5; leader.s = 10;
    sim.pose(follower); sim.pose(leader);
    assert.equal(blocked(), true, 'The explicit grant cannot override a body still in the shared corridor');
    const expectedGrant = structuredClone(sim.st.vehicles.find(v => v.id === follower.id)!.acceptedGrants);
    assert.ok(expectedGrant && Object.keys(expectedGrant).length > 0);
    sim.restore(structuredClone(sim.st));
    assert.deepEqual(sim.st.vehicles.find(v => v.id === follower.id)!.acceptedGrants, expectedGrant,
      'Snapshot restoration must preserve addressed merge grants');
  } finally { sim.dispose(); }
}

// Полный повтор цикла адресной уступки из трёх участников.
{
  const model = structuredClone(cfg); model.sim.seed = 4042;
  const sim = new Simulation(model, compileModel(model).code, { headless: true });
  try {
    sim.runUntil(7200);
    assert.deepEqual(invalidRunReasons(sim.st.counters, sim.logCounts['deadlock-manual'] ?? 0), []);
    assert.ok(sim.st.counters.exited > 2500, 'Resolving the cycle must preserve traffic discharge');
    console.log(`Sibling grant v5/4042: ${sim.st.counters.exited} exited without invalid events.`);
  } finally { sim.dispose(); }
}
