import assert from 'node:assert/strict';
import { defaultModel, TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';
import { invalidRunReasons } from '../src/engine/runValidity';

for (const state of ['stopped', 'stopped-after-commit', 'moving'] as const) {
  const cfg = defaultModel('v1');
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true, dt: .05 });
  try {
    sim.runUntil(30.05);
    const template = sim.st.vehicles[0]; assert.ok(template);
    const conn = sim.net.conns.find(c => c.conn.id === 'N0-S0' && c.variant === 0)!;
    const L = sim.net.arms.N.cfg.approachLength;
    const moving = state === 'moving';
    const v: Vehicle = { ...structuredClone(template), id: 10001, origin: 'N', dest: 'S', conn: conn.idx,
      phase: 'approach', lane: 0, targetLane: 0, lcT: -1, s: L - (moving ? 1 : .36), v: moving ? 12 : 0,
      a: 0, committed: state === 'stopped-after-commit' ? [conn.conflicts[0].conflict] : [], yellowDecision: state === 'stopped-after-commit' ? 1 : 0, crashed: false,
      route: null, stopsLeft: [], overStop: false, overStopDist: 0, viol: { solid: false, stop: false, red: false, turn: false } };
    sim.st.vehicles = [v]; sim.st.peds = [];
    assert.equal(sim.st.lamps.N, 'Y');
    sim.runUntil(moving ? 30.5 : 36);
    if (moving) {
      assert.notEqual(v.phase, 'approach', 'A moving vehicle unable to stop safely can clear the yellow signal');
    } else {
      assert.equal(v.phase, 'approach', 'A vehicle already stopped before the line stays there through yellow and red');
      assert.ok(v.s < L);
      assert.equal(v.yellowDecision, 2, 'A prior decision to continue cannot restart a stopped queue on red');
      assert.deepEqual(v.committed, [], 'A reservation from the cancelled entry attempt must not survive a stop before red');
    }
  } finally { sim.dispose(); }
}
for (const [label, seed] of [['v5', 18042], ['v5', 20042], ['cross4', 19042], ['cross4', 28042]] as const) for (const dt of [.2, .1, .05]) {
  const cfg = label === 'cross4' ? TEMPLATES.find(t => t.id === label)!.make() : defaultModel(label); cfg.sim.seed = seed;
  const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true, dt });
  try {
    sim.runUntil(1500);
    assert.deepEqual(invalidRunReasons(sim.st.counters, sim.logCounts['deadlock-manual'] ?? 0), [], `${label}/${seed} dt=${dt}`);
    assert.ok(sim.st.counters.exited > 250);
    console.log(`Phase transition replay ${label}/${seed} dt=${dt}: ${sim.st.counters.exited} exited without invalid events.`);
  } finally { sim.dispose(); }
}
console.log('Yellow signal: stationary queue stays before the line; moving dilemma-zone vehicle may clear.');
