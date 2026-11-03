import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateSession } from '../src/engine/session';
import { compileModel } from '../src/engine/compile';
import { Simulation, type SimState, type Vehicle } from '../src/engine/sim';
import { invalidRunReasons } from '../src/engine/runValidity';

// Зафиксированный цикл слияния: порядок по оставшейся длине траекторий
// не должен отменять уже согласованное адресное уступание при свободном пути.
const { cfg } = migrateSession(JSON.parse(readFileSync(new URL('../validation/repro-interlocking-v106.session.json', import.meta.url), 'utf8')));
const replay = JSON.parse(readFileSync(new URL('../validation/repro-interlocking-v106.replay.json', import.meta.url), 'utf8')) as { state: SimState };
const sim = new Simulation(cfg, compileModel(cfg).code, { headless: true });
try {
  const internal = sim as unknown as { accel(v: Vehicle): number; index(): void; firstHit(v: Vehicle, ci: number, start: number, end: number, other: Vehicle): number; acceptSiblingGrant(v: Vehicle, ci: number, other: Vehicle): boolean };
  const reset = () => {
    sim.restore(replay.state);
    return [4135, 4194, 4248].map(id => sim.st.vehicles.find(v => v.id === id)!);
  };
  {
    const [receiver, relay, other] = reset();
    relay.yieldTo = 99999;
    assert.ok(internal.accel(receiver) < 0);
    assert.equal(receiver.why, 'merge', 'Без адресного согласия порядок слияния сохраняется');
    assert.equal(receiver.whyId, other.id);
  }
  {
    const [receiver, relay, other] = reset();
    relay.v = 1;
    assert.ok(internal.accel(receiver) < 0);
    assert.equal(receiver.whyId, other.id, 'Движущийся участник цепочки не подтверждает передачу проезда');
  }
  {
    const [receiver, , other] = reset();
    other.s = sim.net.conns[other.conn].path.length - 3;
    sim.pose(other); internal.index();
    assert.ok(Number.isFinite(internal.firstHit(receiver, receiver.conn, receiver.s, sim.net.conns[receiver.conn].path.length + receiver.len, other)));
    assert.equal(internal.acceptSiblingGrant(receiver, receiver.conn, other), false, 'Занятый кузовом путь не допускает передачи проезда');
    assert.ok(Number.isFinite(internal.accel(receiver)));
    assert.ok((receiver.why === 'merge' && receiver.whyId === other.id)
      || (receiver.why === 'yield' && sim.net.conns[receiver.conn].conflicts.some(cr => cr.conflict === receiver.whyId && cr.other === other.conn)),
    'Адресное согласие не отменяет ограничение перед занятым кузовом путём');
  }
  sim.restore(replay.state);
  const ids = sim.st.status.deadlock!.vids;
  const before = structuredClone(sim.st.counters);
  sim.runUntil(sim.st.t + 60);
  for (const id of ids) {
    const v = sim.st.vehicles.find(v => v.id === id);
    assert.ok(!v || v.phase === 'exit', `Участник #${id} должен освободить перекрёсток после адресной уступки`);
  }
  const delta = Object.fromEntries(Object.entries(sim.st.counters).map(([k, v]) => [k, v - before[k as keyof typeof before]])) as typeof before;
  assert.deepEqual(invalidRunReasons(delta, sim.logCounts['deadlock-manual'] ?? 0, cfg.sim.diagnosticRecovery), [], 'Продолжение снимка не должно добавлять события непригодности');
  assert.equal(sim.st.status.deadlock, null);
  console.log('Merge consent: the recorded stationary cycle clears without new invalid events.');
} finally { sim.dispose(); }
