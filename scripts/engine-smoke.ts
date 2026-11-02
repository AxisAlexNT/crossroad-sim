// Быстрая проверка движка без интерфейса: npm run test:engine
import { defaultModel, PRESETS, TEMPLATES } from '../src/engine/presets';
import { compileModel } from '../src/engine/compile';
import { Simulation } from '../src/engine/sim';
import { cycleLength } from '../src/engine/signals';
import { runChecks } from '../src/engine/checks';
import { normalizeModel, serializeModel } from '../src/engine/model';
import type { ModelConfig } from '../src/engine/types';

const horizon = Number(process.argv[2] ?? 900);

function run(label: string, cfg: ModelConfig) {
  const { code, errors } = compileModel(cfg);
  if (errors.length) throw new Error(errors.join('\n'));
  const sim = new Simulation(cfg, code, { headless: true });
  const t0 = performance.now();
  sim.runUntil(120);
  const warm = { counters: structuredClone(sim.st.counters), t: sim.st.t };
  sim.runUntil(horizon);
  const ms = performance.now() - t0;
  const s = sim.summary(warm);
  const checks = runChecks(cfg);
  console.log(
    `${label.padEnd(20)} цикл ${String(cycleLength(cfg.signals)).padStart(3)} с | ` +
    `${s.crossed} авт (${s.throughputVph.toFixed(0)}/ч) ожид ${s.avgWait.toFixed(1)} с очередь ${s.maxQueue} | ` +
    `опасн ${s.dangers} столкн ${s.collisions} ошиб ${s.errors} | пеш ${s.pedDone} ожид ${s.pedAvgWait.toFixed(1)} с опасн ${s.pedDangers} наезд ${s.pedHits} | ` +
    `проп ${s.missedTurns} наруш ${s.violations} блок ${s.deadlocks} автоб ${s.busServed} | ` +
    `проверки E${checks.filter((c) => c.level === 'error').length} W${checks.filter((c) => c.level === 'warn').length} | ${ms.toFixed(0)} мс`,
  );
  const lc = Object.entries(sim.logCounts).map(([k, n]) => `${k}:${n}`).join(' ');
  console.log('   журнал:', lc);
  return checks;
}

for (const p of PRESETS) {
  const checks = run(p.id, defaultModel(p.id));
  if (process.argv.includes('-v')) for (const c of checks.filter((x) => x.level !== 'info')) console.log('     ', c.level, c.code, c.msg);
}
for (const t of TEMPLATES.slice(1)) {
  const checks = run('шаблон ' + t.id, t.make());
  if (process.argv.includes('-v')) for (const c of checks.filter((x) => x.level !== 'info')) console.log('     ', c.level, c.code, c.msg);
}
// круговая проверка формата
const m = defaultModel('v1');
const back = normalizeModel(JSON.parse(serializeModel(m)));
if (JSON.stringify(back) !== JSON.stringify(m)) console.log('ВНИМАНИЕ: модель меняется при сохранении и загрузке');
else console.log('формат: сохранение и загрузка без потерь');

// загрузка чужого файла: цвета, строки, числа и размеры ограничены
{
  const { sceneSvg, LIGHT } = await import('../src/ui/scene');
  const { buildNetwork } = await import('../src/engine/network');
  const evil = JSON.parse(serializeModel(defaultModel('v1')));
  evil.arms[0].color = '"/><script>alert(1)</script><x a="';
  evil.arms[1].laneWidth = 'NaN';
  evil.arms[2].approachLength = 1e9;
  evil.signals.groups[0].color = 'red" onload="alert(1)';
  evil.name = 'x'.repeat(10000);
  evil.sim.dt = 0;
  evil.basemap = { origin: { lat: 0, lon: 0 }, rotation: 'a', dx: 0, dy: 0, attribution: '<b>', features: [{ k: 'building', g: [0, 0, 1, '1"/><script>', 2, 2], closed: true }, { k: 'road', g: [0, 0, 5, 5], closed: false }] };
  const m2 = normalizeModel(evil);
  const svg = sceneSvg(buildNetwork(m2), m2, { palette: LIGHT, graph: true, basemap: true });
  const bad = /<script|onload=|alert\(/.test(svg);
  console.log('чужой файл:', bad ? 'ВНИМАНИЕ: в схему попала разметка из файла' : 'разметка из файла в схему не попадает',
    `| цвет ${m2.arms[0].color}, ширина полосы ${m2.arms[1].laneWidth}, длина подхода ${m2.arms[2].approachLength}, шаг ${m2.sim.dt}, имя ${m2.name.length} симв., объектов подложки ${m2.basemap?.features.length}`);
  let refused = '';
  try { const big = JSON.parse(serializeModel(defaultModel('v1'))); big.connections = Array.from({ length: 5000 }, (_, i) => ({ id: 'c' + i, from: { arm: 'E', lane: 0 }, to: { arm: 'W', lane: 0 } })); normalizeModel(big); } catch (e) { refused = (e as Error).message; }
  console.log('слишком большой файл:', refused || 'ВНИМАНИЕ: принят');
  if (bad || !refused) process.exitCode = 1;
}

// пользовательский код в песочнице: узел с ручными правками и попытка выйти за её пределы
{
  const { readFileSync } = await import('node:fs');
  const { initSandbox } = await import('../src/engine/sandbox');
  const ok = await initSandbox(new Uint8Array(readFileSync(new URL('../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm', import.meta.url))));
  if (!ok) throw new Error('песочница не загрузилась');
  const cfg = defaultModel('v1');
  const sp = cfg.spawners.W;
  sp.manual = true;
  sp.code = sp.code.replace('const RATE_VPH = ', 'const LEAK = typeof fetch + typeof document + typeof alert + typeof XMLHttpRequest;\nconst RATE_VPH = 2 * ');
  sp.code += '\nexport function leak() { return LEAK; }\n';
  const { code, errors } = compileModel(cfg);
  if (errors.length) throw new Error(errors.join('\n'));
  const sim = new Simulation(cfg, code, { headless: true });
  sim.runUntil(600);
  const crossed = sim.st.counters.crossedStop;
  sim.dispose();
  const back = normalizeModel(JSON.parse(serializeModel(cfg)));
  console.log(`песочница: проехало ${crossed} за 600 с, ошибок кода ${sim.st.counters.codeErrors}, ручной код сохранён: ${back.spawners.W.manual && back.spawners.W.code === sp.code}`);
  const { SandboxNode } = await import('../src/engine/sandbox');
  const n = new SandboxNode(compileModel(cfg).code.spawners.W!);
  console.log('песочница: доступ к fetch, document, alert, XMLHttpRequest —', n.call('leak', [], 0, { memory: {} }, Math.random));
  n.dispose();

  // сгенерированный код в песочнице и встроенная логика по параметрам дают одинаковый результат
  const runOf = (manual: boolean) => {
    const m = defaultModel('v1');
    if (manual) for (const k of Object.keys(m.spawners)) m.spawners[k].manual = true;
    const c = compileModel(m);
    const s2 = new Simulation(m, c.code, { headless: true });
    s2.runUntil(600);
    const r = `${s2.st.counters.spawned}/${s2.st.counters.crossedStop}/${s2.st.vehicles.map((v) => v.len.toFixed(3)).join(',').length}`;
    s2.dispose();
    return r;
  };
  const a = runOf(false), b = runOf(true);
  console.log('код узлов и параметры:', a === b ? `совпадают (${a})` : `ВНИМАНИЕ: различаются ${a} и ${b}`);
  if (a !== b) process.exitCode = 1;
}

// общие случайные числа: другая программа светофора не меняет поток машин, а шаг симуляции — моменты их появления
{
  const arrivals = (mut: (m: ReturnType<typeof defaultModel>) => void) => {
    const m = defaultModel('v1');
    mut(m);
    const s2 = new Simulation(m, compileModel(m).code, { headless: true });
    s2.runUntil(900);
    const n = s2.st.counters.spawned + s2.st.queue.E.length + s2.st.queue.W.length + s2.st.queue.N.length + s2.st.queue.S.length;
    s2.dispose();
    return `${s2.st.counters.spawned}+${n - s2.st.counters.spawned}, пеш ${s2.st.counters.pedSpawned}`;
  };
  const base = arrivals(() => {});
  const otherPlan = arrivals((m) => { m.signals.phases[0].duration += 15; });
  const otherDt = arrivals((m) => { m.sim.dt = 0.05; });
  console.log(`общие случайные числа: исходный ${base}, другая длительность фазы ${otherPlan}, шаг 0,05 с ${otherDt}`);
}
