import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation, type Vehicle } from '../src/engine/sim';

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
