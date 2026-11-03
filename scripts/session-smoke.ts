import assert from 'node:assert/strict';
import { defaultModel, PRESETS, TEMPLATES } from '../src/engine/presets';
import { migrateSession, serializeSession } from '../src/engine/session';
import { serializeModel } from '../src/engine/model';

let cases = 0;
for (const cfg of [...PRESETS.map(p => defaultModel(p.id)), ...TEMPLATES.slice(1).map(t => t.make())]) {
  const arm = cfg.arms[0].id;
  cfg.spawners[arm].manual = true;
  cfg.spawners[arm].code = 'function spawn(ctx) { return []; }\n// сохранённая правка\n';
  const expected = serializeModel(cfg);
  const session = JSON.parse(serializeSession(cfg, 'custom', { theme: 'light', draftAsError: true, showTimers: false }));
  const raw = JSON.parse(expected);
  const unversioned = structuredClone(raw); delete unversioned.version;
  for (const input of [session, raw, unversioned, { cfg: raw, theme: 'light', draftAsError: true, showTimers: false }]) {
    const original = structuredClone(input);
    const loaded = migrateSession(input);
    assert.equal(serializeModel(loaded.cfg), expected);
    assert.deepEqual(input, original, 'Импорт не изменяет исходные данные');
    assert.deepEqual(loaded.report.warnings, []);
    assert.equal(loaded.report.sourceVersion, 2);
    if ('cfg' in input) assert.deepEqual(loaded.preferences, { theme: 'light', draftAsError: true, showTimers: false });
    cases++;
  }
}
const cfg = defaultModel('v1');
cfg.peds.sources[0].rate = 17;
const legacy = JSON.parse(serializeModel(cfg));
legacy.version = 1;
legacy.arms = Object.fromEntries(legacy.arms.map((arm: { id: string }) => [arm.id, { ...arm, dir: arm.id }]));
const original = structuredClone(legacy);
const imported = migrateSession({ cfg: legacy, theme: 'light', preferences: { showTimers: false } });
assert.equal(serializeModel(imported.cfg), serializeModel(cfg));
assert.deepEqual(imported.preferences, { theme: 'light', showTimers: false });
assert.deepEqual(imported.report.warnings, []);
assert.deepEqual(legacy, original);
const damaged = structuredClone(legacy);
damaged.arms.N.speedLimit = 900;
damaged.arms.N.unknownGeometry = 42;
assert.ok(migrateSession(damaged).report.warnings.some(x => x.includes('speedLimit')));
assert.ok(migrateSession(damaged).report.warnings.some(x => x.includes('unknownGeometry')));
const oldPeds = structuredClone(legacy); delete oldPeds.peds; delete oldPeds.transit;
oldPeds.sim.pedestrians = { rate: 100, speedMin: 1.2, speedMax: 1.4 };
const generated = migrateSession(oldPeds);
assert.ok(generated.report.changes.some(x => x.includes('пешеход')));
assert.ok(generated.cfg.peds.sources.every(s => s.speedMin === 1.2 && s.speedMax === 1.4));
const invalidOldPeds = structuredClone(oldPeds); invalidOldPeds.sim.pedestrians.speedMin = -2;
assert.ok(migrateSession(invalidOldPeds).report.warnings.some(x => x.includes('speedMin')));
const raw = JSON.parse(serializeModel(cfg)); delete raw.version; raw.unknownSetting = 1;
assert.ok(migrateSession(raw).report.warnings.some(x => x.includes('unknownSetting')));
const unknownPrefs = migrateSession({ cfg: JSON.parse(serializeModel(cfg)), preferences: { theme: 'sepia', futureSetting: true } });
assert.equal(unknownPrefs.report.warnings.filter(x => x.startsWith('настройки.')).length, 2);
assert.throws(() => migrateSession({ cfg: { ...JSON.parse(serializeModel(cfg)), format: 'other-format' } }));
assert.throws(() => migrateSession({ cfg: JSON.parse(serializeModel(cfg)), version: 999 }));
assert.ok(migrateSession({ cfg: JSON.parse(serializeModel(cfg)), oldPreference: 12 }).report.warnings.some(x => x.includes('oldPreference')));
console.log(`Совместимость: ${cases} вариантов сохранения, ручной код, граф, старые настройки и отчёты потерь`);
