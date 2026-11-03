import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import { runChecks } from '../src/engine/checks';

for (const actualConflict of [false, true]) {
  const cfg = defaultModel('v4');
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
  try {
    sim.runUntil(30);
    const template = sim.st.vehicles[0]; assert.ok(template);
    const a = sim.net.conns.find(c => c.conn.id === (actualConflict ? 'W2-S0' : 'W0-N0') && c.variant === 0)!;
    const b = sim.net.conns.find(c => c.conn.id === (actualConflict ? 'S0-N0' : 'W1-E1') && c.variant === (actualConflict ? 2 : 0))!;
    const cr = a.conflicts.find(c => c.other === b.idx && sim.net.conflicts[c.conflict].body)!; assert.ok(cr);
    const back = b.conflicts.find(c => c.conflict === cr.conflict)!;
    const cf = sim.net.conflicts[cr.conflict];
    const oStart = back.start, oEnd = back.end;
    const x: Vehicle = { ...structuredClone(template), id: 10001, origin: a.conn.from.arm, dest: a.conn.to.arm, phase: 'conn', conn: a.idx,
      len: actualConflict ? 12 : 4.6, wid: actualConflict ? 2.55 : 1.8, lat: 0, lat2: 0, route: actualConflict ? 'test' : null,
      ps: cr.start - .1, s: cr.start + .1, crashed: false };
    const y: Vehicle = { ...structuredClone(template), id: 10002, origin: b.conn.from.arm, dest: b.conn.to.arm, phase: 'conn', conn: b.idx,
      len: actualConflict ? 5.4 : 6.3, wid: 2, lat: 0, lat2: 0, route: null, ps: oStart + 1, s: oStart + 1, crashed: false };
    // Isolate one zone so unrelated crossings cannot satisfy the assertions.
    a.conflicts = [cr]; b.conflicts = [back]; sim.st.vehicles = [x, y];
    const internal = sim as unknown as { index(): void; trackConflicts(): void; bodyConflictApplies(x: Vehicle, a: number, y: Vehicle, b: number): boolean };
    assert.equal(internal.bodyConflictApplies(x, a.idx, y, b.idx), actualConflict);
    const track = () => { internal.index(); const n = sim.st.counters.dangers; internal.trackConflicts(); return sim.st.counters.dangers - n; };
    assert.equal(track(), actualConflict ? 1 : 0, 'Only actual conflicting bodies produce an occupied-zone PET event');
    x.ps = x.s = cr.start - 1;
    y.phase = 'exit';
    y.ps = oEnd + y.len - .1 - b.path.length;
    y.s = oEnd + y.len + .1 - b.path.length;
    assert.equal(track(), 0);
    assert.equal(sim.st.confLast[cr.conflict].bodies?.[back.side].length, 1, 'Rear clearance on exit is recorded');
    const saved = structuredClone(sim.st);
    sim.st.vehicles = [x]; sim.st.t += .2; x.ps = cr.start - .1; x.s = cr.start + .1;
    assert.equal(track(), actualConflict ? 1 : 0, 'Recently cleared participants retain their actual body profile');
    sim.st = structuredClone(saved);
    sim.st.t += cfg.sim.petWindow + 1;
    sim.st.vehicles = [{ ...x, ps: cr.start - .1, s: cr.start + .1 }];
    assert.equal(track(), 0, 'Expired body history must not produce a PET event');
    assert.equal(sim.st.confLast[cr.conflict].bodies?.[back.side].length, 0, 'History is pruned to the PET time window');
    assert.equal(cf.body, true);
  } finally { sim.dispose(); }
}
const checks = runChecks(defaultModel('v1'));
assert.ok(checks.some(c => c.code === 'body-corridor' && c.level === 'warn'));
assert.ok(!checks.some(c => c.code === 'cross-straight' && /запад, полоса 1.*запад, полоса 2/.test(c.msg)), 'Body-only overlap must not be presented as a centerline intersection');
console.log('PET corridors: actual bodies, occupied/cleared zones, exit clearance, cloned history and expiration pass.');
