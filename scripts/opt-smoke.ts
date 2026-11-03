// Короткий прогон подбора фаз без интерфейса: npm run test:opt
import assert from 'node:assert/strict';
import { defaultModel } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { evaluateCandidate } from '../src/engine/evaluate';
import { Optimizer, crowding, defaultOptSettings, meanCi, type Candidate } from '../src/engine/optimizer';
import { webster } from '../src/engine/webster';

const cfg = defaultModel('v1');
const { code } = compileModel(cfg);
const s = defaultOptSettings(cfg);
console.log(`по умолчанию: фаза не короче ${s.bounds[0].min} с, красный до ${s.maxRed} с, цикл до ${s.maxCycle} с, прогонов ${s.seeds}, перепроверка ${s.reevalTop}×${s.reevalSeeds}`);
if (s.bounds.some((b) => b.min !== s.minGreen)) { console.log('ВНИМАНИЕ: нижняя граница фаз не равна minGreen'); process.exitCode = 1; }

// расстояние скученности не должно становиться NaN у недопустимых вариантов
const inf: Candidate[] = [0, 1, 2, 3].map((i) => ({ x: [10 + i, 20 - i], obj: [Infinity, Infinity], violation: 1, cycle: 0, gen: 0 }));
crowding(inf);
if (inf.some((c) => Number.isNaN(c.crowd))) { console.log('ВНИМАНИЕ: NaN в расстоянии скученности'); process.exitCode = 1; } else console.log('скученность для недопустимых: без NaN');
console.log('доверительный интервал [10, 12, 14]:', JSON.stringify(meanCi([10, 12, 14])));
const symmetric = meanCi(Array.from({ length: 40 }, (_, i) => i % 2 ? 1 : -1));
assert.equal(symmetric.mean, 0);
assert.ok(symmetric.ci > 1.96 / Math.sqrt(39), 'Конечная выборка не должна получать более узкий нормальный интервал');

const w = webster(cfg);
console.log(`Вебстер: цикл ${w.cycle} с, Y ${w.Y.toFixed(2)}, фазы ${w.durations.join(' / ')}`);

s.objectives = ['avgWait', 'worstWait'];
s.budgetSeconds = 25; s.simSeconds = 400; s.warmup = 120; s.population = 8; s.seeds = 2; s.reevalTop = 3; s.reevalSeeds = 3; s.maxCycle = 0;
const opt = new Optimizer(cfg, s, async (xs, o) => xs.map((x) => evaluateCandidate({ id: 0, cfg, code, durations: x, dt: s.dt, warmup: s.warmup, horizon: s.simSeconds, seeds: o?.seeds ?? s.seeds, seedBase: o?.seedBase })), () => {}, w.ok ? w.durations : null);
const best = await opt.run();
console.log(opt.logLines.slice(-4).join('\n'));
console.log('итог:\n' + best.map((b) => `[${b.x}] ${b.final ? b.final.mean.map((m, j) => `${m.toFixed(1)}±${b.final!.ci[j].toFixed(1)}`).join(' ') : b.obj.map((v) => v.toFixed(1)).join(' ')}`).join('\n'));
if (!opt.final.length) { console.log('ВНИМАНИЕ: перепроверки не было'); process.exitCode = 1; }
