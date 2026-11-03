import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation } from '../src/engine/sim';
import { sceneSvg, DARK, LIGHT } from '../src/ui/scene';

const cfg = defaultModel('v1');
const sim = new Simulation(cfg, compileModel(cfg).code);
try {
  for (const [time, expected] of [[0, 'red'], [115, 'green'], [116.1, 'green'], [116.6, 'off'], [117.1, 'green'], [119.1, 'red']] as const) {
    sim.runUntil(time);
    for (const palette of [DARK, LIGHT]) {
      const svg = sceneSvg(sim.net, cfg, { palette, state: sim.st, basemap: false });
      const heads = [...svg.matchAll(/<circle cy="-0\.72" r="0\.55" fill="([^"]+)"\/><circle cy="0\.72" r="0\.55" fill="([^"]+)"\/>/g)];
      assert.ok(heads.length > 0);
      for (const [, red, green] of heads) {
        assert.equal(red, expected === 'red' ? palette.red : palette.lampOff, `Red lamp at ${time}`);
        assert.equal(green, expected === 'green' ? palette.green : palette.lampOff, `Green lamp at ${time}`);
      }
    }
  }
  assert.equal(sim.back(2.5), true);
  assert.equal(sim.st.t, 116.6);
  const svg = sceneSvg(sim.net, cfg, { palette: DARK, state: sim.st, basemap: false });
  assert.ok(svg.includes(`<circle cy="-0.72" r="0.55" fill="${DARK.lampOff}"/><circle cy="0.72" r="0.55" fill="${DARK.lampOff}"/>`));
  console.log('Signal export: pedestrian green flash never lights red; both palettes and rewind pass.');
} finally { sim.dispose(); }
