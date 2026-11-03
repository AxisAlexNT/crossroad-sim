// Статические проверки конфигурации: нормативы (со ссылками на источник) и логические ошибки модели.

import type { ArmId, ModelConfig, SignalProgram } from './types';
import { armRelations, buildNetwork, pedRouteOptions, type Network } from './network';
import { buildTimeline, groupBands, intergreen, cycleLength } from './signals';
import { busStopPose } from './network';

export type CheckLevel = 'error' | 'warn' | 'info';

export interface CheckResult {
  level: CheckLevel;
  code: string;
  msg: string;
  /** id источника из sources.ts. Если его нет — это оценка модели */
  source?: string;
  where?: string;
}

const LABEL = { straight: 'прямо', left: 'налево', right: 'направо', uturn: 'разворот' } as const;

function armShort(cfg: ModelConfig, id: ArmId): string {
  return cfg.arms.find((a) => a.id === id)?.short ?? id;
}

export function connLabel(net: Network, ci: number, cfg?: ModelConfig): string {
  const c = net.conns[ci];
  const nm = (id: ArmId) => (cfg ? armShort(cfg, id) : net.arms[id]?.cfg.short ?? id);
  return `${nm(c.conn.from.arm)}, полоса ${c.conn.from.lane} → ${nm(c.conn.to.arm)}, полоса ${c.conn.to.lane}, ${LABEL[c.kind]}`;
}

export function pedEdgeLabel(cfg: ModelConfig, net: Network, ei: number): string {
  const e = net.pedEdges[ei];
  const a = net.pedNodes[e.from].node.label, b = net.pedNodes[e.to].node.label;
  return `${a} — ${b}`;
}

/** Какие манёвры разрешены в фазе и как (основной сигнал или стрелка) */
export function phasePermits(p: SignalProgram, net: Network, phaseIdx: number): Array<'main' | 'arrow' | 'none'> {
  const ph = p.phases[phaseIdx];
  return net.conns.map((c) => {
    let r: 'main' | 'arrow' | 'none' = 'none';
    for (const g of p.groups) {
      if (!ph.green.includes(g.id) || g.kind === 'pedestrian') continue;
      if (!g.movements.includes(c.conn.id)) continue;
      if (g.kind === 'vehicle') return 'main';
      r = 'arrow';
    }
    return r;
  });
}

/** Пешеходные рёбра, открытые в фазе */
export function phasePedEdges(p: SignalProgram, net: Network, phaseIdx: number): Set<number> {
  const ph = p.phases[phaseIdx];
  const out = new Set<number>();
  for (const g of p.groups) {
    if (g.kind !== 'pedestrian' || !ph.green.includes(g.id)) continue;
    for (const m of g.movements) {
      const ei = net.pedEdgeById.get(m);
      if (ei !== undefined) out.add(ei);
    }
  }
  return out;
}

/** Оценка интенсивности манёвра (авт/ч) по параметрам узлов появления машин */
export function demandTo(cfg: ModelConfig, from: ArmId, to: ArmId): number {
  const sp = cfg.spawners[from]?.params;
  if (!sp) return 0;
  const total = Object.values(sp.destinations).reduce((a, b) => a + (b ?? 0), 0) || 1;
  return (sp.rate * (sp.destinations[to] ?? 0)) / total;
}

/** Оценка пешеходного потока по каждому ребру графа (чел/ч в обе стороны) по кратчайшим маршрутам */
export function pedEdgeFlows(cfg: ModelConfig, net: Network): number[] {
  const flows = net.pedEdges.map(() => 0);
  const routes = pedRouteOptions(net);
  for (const s of cfg.peds.sources) {
    const total = Object.values(s.destinations).reduce((a, b) => a + (b ?? 0), 0);
    if (!total) continue;
    for (const [to, w] of Object.entries(s.destinations)) {
      const r = routes.get(`${s.node}>${to}`)?.[0];
      if (!r) continue;
      for (const st of r.steps) flows[st.edge] += (s.rate * (w ?? 0)) / total;
    }
  }
  return flows;
}

/** Самый долгий непрерывный разрешающий сигнал группы (зелёный и мигающий зелёный), с */
function longestGreen(p: SignalProgram, groupId: string): number {
  const g = p.groups.find((x) => x.id === groupId);
  if (!g) return 0;
  const bands = groupBands(p, g);
  const cyc = bands.length ? bands[bands.length - 1].to : 0;
  let best = 0, cur = 0;
  const isGreen = (l: string) => l === 'G' || l === 'FG';
  if (bands.length && bands.every((b) => isGreen(b.lamp))) return cyc;
  for (let k = 0; k < 2; k++) {
    for (const b of bands) {
      if (isGreen(b.lamp)) { cur += b.to - b.from; best = Math.max(best, Math.min(cur, cyc)); }
      else cur = 0;
    }
  }
  return best;
}

export interface CheckOptions {
  /** Нарушения положений проектов стандартов показывать как ошибки, а не как предупреждения */
  draftAsError?: boolean;
}

export function runChecks(cfg: ModelConfig, opts: CheckOptions = {}): CheckResult[] {
  const out = runChecksRaw(cfg);
  // проект стандарта обязательной силы не имеет: по умолчанию его нарушения — предупреждения
  for (const r of out) if (r.source === 'gost-draft' && r.level !== 'info') r.level = opts.draftAsError ? 'error' : 'warn';
  return out;
}

function runChecksRaw(cfg: ModelConfig): CheckResult[] {
  const out: CheckResult[] = [];
  const net = buildNetwork(cfg);
  const rel = armRelations(cfg.arms);
  const p = cfg.signals;
  const t = p.timing;
  const add = (r: CheckResult) => out.push(r);
  const lbl = (ci: number) => connLabel(net, ci, cfg);
  void lbl;

  // --- Длительности сигналов ---
  if (t.yellow !== 3) add({ level: 'warn', code: 'yellow', msg: `Жёлтый сигнал ${t.yellow} с. Методическое руководство Минтранса рекомендует 3 с во всех случаях.`, source: 'mintrans-guide' });
  if (t.redYellow > 2) add({ level: 'warn', code: 'red-yellow', msg: `Красный с жёлтым ${t.redYellow} с. Методическое руководство Минтранса рекомендует не более 2 с.`, source: 'mintrans-guide' });
  if (t.flashGreen !== 3) add({ level: 'warn', code: 'flash', msg: `Мигание зелёного ${t.flashGreen} с. Действующая редакция ГОСТ Р 52289-2019 с изменениями № 1 и № 2 предусматривает 3 с для транспортных и пешеходных светофоров и допсекций.`, source: 'gost52289-amend' });
  p.phases.forEach((ph, i) => {
    if (!Number.isInteger(ph.duration)) add({ level: 'error', code: 'int', msg: `Фаза «${ph.name}»: длительность должна быть целым числом секунд.`, where: `фаза ${i + 1}` });
    if (ph.duration < t.flashGreen + 1) add({ level: 'warn', code: 'short', msg: `Фаза «${ph.name}» длится ${ph.duration} с, это короче мигания зелёного с запасом. Вероятно, ошибка.`, where: `фаза ${i + 1}` });
    if (ph.green.length === 0) add({ level: 'warn', code: 'empty-phase', msg: `Фаза «${ph.name}»: ни у одной группы нет разрешающего сигнала.`, where: `фаза ${i + 1}` });
    for (const gid of ph.green) if (!p.groups.some((g) => g.id === gid)) add({ level: 'warn', code: 'phase-dangling', msg: `Фаза «${ph.name}» ссылается на удалённую группу «${gid}».`, where: `фаза ${i + 1}` });
  });
  if (p.phases.length === 0) add({ level: 'error', code: 'no-phases', msg: 'В программе нет ни одной фазы.' });

  // --- Связь направлений и светофоров ---
  net.conns.forEach((c, ci) => {
    if (c.illegal || c.variant > 0) return;
    const groups = p.groups.filter((g) => g.kind !== 'pedestrian' && g.movements.includes(c.conn.id));
    if (groups.length === 0) add({ level: 'error', code: 'unsignalled', msg: `Направление «${lbl(ci)}» не управляется ни одной сигнальной группой, по нему никогда не будет зелёного.` });
    const mains = groups.filter((g) => g.kind === 'vehicle');
    if (mains.length > 1) add({ level: 'warn', code: 'multi-main', msg: `Направление «${lbl(ci)}» входит в несколько основных групп: ${mains.map((g) => g.name).join(', ')}.` });
  });
  for (const g of p.groups) {
    if (!p.phases.some((ph) => ph.green.includes(g.id))) add({ level: 'info', code: 'unused-group', msg: `Группа «${g.name}» не горит зелёным ни в одной фазе.` });
    for (const m of g.movements) {
      const ok = g.kind === 'pedestrian' ? net.pedEdgeById.has(m) : net.connById.has(m);
      if (!ok) add({ level: 'warn', code: 'dangling', msg: `Группа «${g.name}» ссылается на удалённое ${g.kind === 'pedestrian' ? 'пешеходное ребро' : 'направление'} ${m}.` });
    }
  }

  // --- Конфликты в фазах ---
  const flows = pedEdgeFlows(cfg, net);
  p.phases.forEach((ph, pi) => {
    const pm = phasePermits(p, net, pi);
    const pedOpen = phasePedEdges(p, net, pi);
    const seen = new Set<string>();
    for (const cf of net.conflicts) {
      const a = net.conns[cf.a], b = net.conns[cf.b];
      // дополнительные траектории повторяют основные: проверяем по основным
      if (a.variant > 0 || b.variant > 0) continue;
      if (pm[cf.a] === 'none' || pm[cf.b] === 'none') continue;
      const key = `${cf.a}-${cf.b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (cf.body) {
        add({ level: 'warn', code: 'body-corridor', msg: `Фаза «${ph.name}»: габаритные коридоры «${lbl(cf.a)}» и «${lbl(cf.b)}» могут пересекаться для части типов транспорта. Требуется проверка габаритов и очередности движения; пересечение осей траекторий отсутствует.`, where: `фаза ${pi + 1}` });
        continue;
      }
      const turnA = a.kind === 'left' || a.kind === 'uturn';
      const turnB = b.kind === 'left' || b.kind === 'uturn';
      const opposite = rel.opposite[a.conn.from.arm] === b.conn.from.arm;
      // п. 7.5.8: стрелка допсекции налево или на разворот при встречном прямом
      const arrowLeftVsStraight =
        (pm[cf.a] === 'arrow' && turnA && b.kind === 'straight' && opposite) ||
        (pm[cf.b] === 'arrow' && turnB && a.kind === 'straight' && opposite);
      if (arrowLeftVsStraight) {
        add({ level: 'error', code: '7.5.8', msg: `Фаза «${ph.name}»: допсекция разрешает ${turnA ? lbl(cf.a) : lbl(cf.b)} одновременно со встречным прямым потоком. Это запрещено пунктом 7.5.8 ГОСТ Р 52289-2019 в редакции Изменения № 1, действует с 1 января 2026 года.`, source: 'gost52289-ch1', where: `фаза ${pi + 1}` });
        continue;
      }
      if (pm[cf.a] === 'arrow' || pm[cf.b] === 'arrow') {
        add({ level: 'warn', code: 'arrow-conflict', msg: `Фаза «${ph.name}»: при движении по стрелке «${pm[cf.a] === 'arrow' ? lbl(cf.a) : lbl(cf.b)}» есть конфликтующий разрешённый поток «${pm[cf.a] === 'arrow' ? lbl(cf.b) : lbl(cf.a)}». В этой фазе основной сигнал для стрелки запрещающий, поэтому по пункту 13.5 ПДД водители по стрелке уступают транспортным средствам с других направлений. Обычно допсекцию включают, когда таких конфликтов нет.`, source: 'pdd', where: `фаза ${pi + 1}` });
        continue;
      }
      if (cf.kind === 'merge') {
        add({ level: 'info', code: 'merge', msg: `Фаза «${ph.name}»: «${lbl(cf.a)}» и «${lbl(cf.b)}» сливаются в одну полосу выезда.`, where: `фаза ${pi + 1}` });
        continue;
      }
      if (!turnA && !turnB) {
        add({ level: 'error', code: 'cross-straight', msg: `Фаза «${ph.name}»: одновременно разрешены пересекающиеся потоки «${lbl(cf.a)}» и «${lbl(cf.b)}». Ни одно из этих направлений не обязано уступать другому, поэтому возможно столкновение.`, where: `фаза ${pi + 1}` });
        continue;
      }
      if (turnA !== turnB && opposite) {
        const left = turnA ? cf.a : cf.b;
        const lc = net.conns[left];
        const vph = demandTo(cfg, lc.conn.from.arm, lc.conn.to.arm);
        add({
          level: vph > 100 ? 'warn' : 'info',
          code: 'permissive-left',
          msg: `Фаза «${ph.name}»: «${lbl(left)}» — незащищённый левый поворот через встречный поток, водители уступают по пункту 13.4 ПДД.` +
            (vph > 100 ? ` Оценка интенсивности ${vph.toFixed(0)} авт/ч больше 100 авт/ч, методическое руководство рекомендует отдельную полосу или фазу.` : ''),
          source: 'mintrans-guide',
          where: `фаза ${pi + 1}`,
        });
      }
    }

    // --- Пешеходы и машины в одной фазе ---
    const pedEdgeSeen = new Set<string>();
    for (const ei of pedOpen) {
      const e = net.pedEdges[ei];
      const crossing = net.conns.filter((c, ci) => c.variant === 0 && pm[ci] !== 'none' && c.crossings.some((x) => x.edge === ei));
      if (!crossing.length) continue;
      const name = pedEdgeLabel(cfg, net, ei);
      if (e.kind === 'free') {
        add({ level: 'error', code: 'diag-phase', msg: `Фаза «${ph.name}»: переход «${name}» идёт не поперёк дороги, а по диагонали или через перекрёсток. В проекте стандарта о безопасности пешеходов предусмотрено открывать такой переход только в отдельной пешеходной фазе, когда все машины стоят.`, source: 'gost-draft', where: `фаза ${pi + 1}` });
        continue;
      }
      for (const c of crossing) {
        const kind = pm[c.idx];
        const key = `${ei}-${c.idx}`;
        if (pedEdgeSeen.has(key)) continue;
        pedEdgeSeen.add(key);
        if (c.kind === 'straight') {
          add({ level: 'error', code: 'ped-straight', msg: `Фаза «${ph.name}»: пешеходам на переходе «${name}» горит зелёный одновременно с прямым потоком «${lbl(c.idx)}», который через этот переход проезжает.`, source: 'gost52289-amend', where: `фаза ${pi + 1}` });
        } else if (kind === 'arrow') {
          add({ level: 'warn', code: 'ped-arrow', msg: `Фаза «${ph.name}»: стрелка «${lbl(c.idx)}» включена одновременно с пешеходами на переходе «${name}». Допсекцию обычно включают, когда пересекающих её траекторию пешеходов нет.`, source: 'pdd', where: `фаза ${pi + 1}` });
        }
      }
      const turning = crossing.filter((c) => c.kind !== 'straight' && pm[c.idx] === 'main');
      if (turning.length) {
        // ГОСТ Р 52289-2019, 7.2.6: учитывается суммарная интенсивность машин, поворачивающих в одно направление
        const byDest = new Map<string, number>();
        for (const c of turning) byDest.set(c.conn.to.arm, (byDest.get(c.conn.to.arm) ?? 0) + demandTo(cfg, c.conn.from.arm, c.conn.to.arm));
        const vph = Math.max(...byDest.values());
        const ped = flows[ei];
        // в действующей редакции — не более 120 ед./ч при не более 600 пеш./ч, изменение № 1 также допускает не более 600 ед./ч при не более 150 пеш./ч
        const flowsOk = (vph <= 120 && ped <= 600) || (vph <= 600 && ped <= 150);
        // информационная секция нужна на светофорах всех поворачивающих через переход направлений
        const noInfo = turning.filter((c) => !p.groups.some((g) => g.kind === 'vehicle' && g.pedInfo && g.movements.includes(c.conn.id) && ph.green.includes(g.id)));
        const parts: string[] = [];
        if (!flowsOk) parts.push(`По оценке условных интенсивностей модели поворачивающих в одно направление около ${vph.toFixed(0)} ед./ч, пешеходов около ${ped.toFixed(0)} пеш./ч, а пункт 7.2.6 допускает не более 120 ед./ч при не более 600 пеш./ч или, с изменением № 1, не более 600 ед./ч при не более 150 пеш./ч.`);
        if (noInfo.length) parts.push(`Для «${noInfo.map((c) => lbl(c.idx)).join('», «')}» в модели не отмечена информационная секция, которая бело-лунным мигающим сигналом предупреждает водителей о пешеходах. Пункт 7.2.6 называет её одним из условий, отметить секцию можно в свойствах светофора.`);
        add({
          level: parts.length ? 'warn' : 'info',
          code: '7.2.6',
          msg: `Фаза «${ph.name}»: пешеходы на переходе «${name}» идут одновременно с поворачивающими машинами, направлений ${turning.length}. ` +
            (parts.length ? parts.join(' ') : `Оценка потоков в модели укладывается в пункт 7.2.6, около ${vph.toFixed(0)} ед./ч и ${ped.toFixed(0)} пеш./ч, информационная секция отмечена.`),
          source: 'gost52289-amend',
          where: `фаза ${pi + 1}`,
        });
      }
    }
  });

  // --- Пешеходы: граф, сигналы, время на переход ---
  const controlled = new Set<number>();
  for (const g of p.groups) if (g.kind === 'pedestrian') for (const m of g.movements) { const ei = net.pedEdgeById.get(m); if (ei !== undefined) controlled.add(ei); }
  net.pedEdges.forEach((e, ei) => {
    if (e.roadS1 - e.roadS0 < 0.5) return;
    if (!controlled.has(ei)) add({ level: 'warn', code: 'ped-unsignalled', msg: `Переход «${pedEdgeLabel(cfg, net, ei)}» не управляется пешеходным светофором. Пешеходы пойдут, когда сочтут, что машин нет, а машины обязаны им уступать.` });
  });
  for (const g of p.groups.filter((x) => x.kind === 'pedestrian')) {
    const green = longestGreen(p, g.id);
    if (!p.phases.some((ph) => ph.green.includes(g.id))) continue;
    for (const m of g.movements) {
      const ei = net.pedEdgeById.get(m);
      if (ei === undefined) continue;
      const e = net.pedEdges[ei];
      const road = e.roadS1 - e.roadS0;
      if (road < 0.5) continue;
      const base = road / 1.2;
      const draft = base + 5;
      const half = e.kind === 'half' ? ' до островка безопасности' : '';
      if (green < base) {
        add({ level: 'warn', code: 'ped-time', msg: `Переход «${pedEdgeLabel(cfg, net, ei)}»${half}, длина ${road.toFixed(1)} м: разрешающий сигнал ${green.toFixed(2)} с меньше времени перехода при расчётной скорости 1,2 м/с из методического руководства, которое равно ${base.toFixed(2)} с.`, source: 'mintrans-guide' });
      } else if (green < draft) {
        add({ level: 'warn', code: 'ped-time-draft', msg: `Переход «${pedEdgeLabel(cfg, net, ei)}»${half}: разрешающий сигнал ${green.toFixed(2)} с. В проекте стандарта о безопасности пешеходов предусмотрено не меньше B/1,2 + 5 = ${draft.toFixed(2)} с, целая настройка не менее ${Math.ceil(draft)} с.`, source: 'gost-draft' });
      }
    }
  }
  // диагональные переходы — только в отдельной фазе
  net.pedEdges.forEach((e, ei) => {
    if (e.kind !== 'free' || e.roadS1 - e.roadS0 < 0.5) return;
    add({ level: 'info', code: 'diag', msg: `Есть диагональный или проходящий через перекрёсток переход «${pedEdgeLabel(cfg, net, ei)}». В проекте стандарта о безопасности пешеходов предусмотрено открывать его только в отдельной пешеходной фазе.`, source: 'gost-draft' });
  });
  // маршруты пешеходов
  const routes = pedRouteOptions(net);
  for (const s of cfg.peds.sources) {
    for (const [to, w] of Object.entries(s.destinations)) {
      if (!w || to === s.node) continue;
      if (!routes.get(`${s.node}>${to}`)?.length) {
        const a = cfg.peds.nodes.find((n) => n.id === s.node)?.label ?? s.node;
        const b = cfg.peds.nodes.find((n) => n.id === to)?.label ?? to;
        add({ level: 'error', code: 'ped-noroute', msg: `Пешеходы из «${a}» хотят в «${b}», но в графе переходов нет пути.` });
      }
    }
  }
  // единая пешеходная фаза: рекомендуется при 150 пеш/ч и более по трём и более направлениям
  const busy = net.pedEdges.filter((e, ei) => e.roadS1 - e.roadS0 >= 0.5 && flows[ei] >= 150).length;
  const hasEpf = p.phases.some((ph, pi) => phasePedEdges(p, net, pi).size > 0 && phasePermits(p, net, pi).every((x) => x === 'none'));
  if (busy >= 3 && !hasEpf) add({ level: 'warn', code: 'epf', msg: `По ${busy} переходам идёт 150 чел/ч и больше. Для такого случая в проекте стандарта о безопасности пешеходов предусмотрена единая пешеходная фаза.`, source: 'gost-draft' });
  if (hasEpf) {
    const share = Math.max(...p.phases.map((ph, pi) => (phasePermits(p, net, pi).every((x) => x === 'none') && phasePedEdges(p, net, pi).size ? ph.duration : 0)));
    add({ level: 'info', code: 'epf-info', msg: `Есть единая пешеходная фаза длительностью ${share} с. Оценка потоков по переходам: ${net.pedEdges.map((e, ei) => (e.roadS1 - e.roadS0 >= 0.5 ? `${pedEdgeLabel(cfg, net, ei)} около ${flows[ei].toFixed(0)} чел/ч` : '')).filter(Boolean).join(', ')}.` });
  }

  // --- Возможная взаимная блокировка: цикл уступаний внутри фазы ---
  const staticYield = (A: number, B: number, pm: Array<'main' | 'arrow' | 'none'>): boolean | null => {
    if (pm[A] === 'arrow' && pm[B] !== 'arrow') return true;
    if (pm[B] === 'arrow' && pm[A] !== 'arrow') return false;
    const ca = net.conns[A], cb = net.conns[B];
    const ta = ca.kind === 'left' || ca.kind === 'uturn', tb = cb.kind === 'left' || cb.kind === 'uturn';
    const fa = ca.conn.from.arm, fb = cb.conn.from.arm;
    if (ta && !tb && rel.opposite[fa] === fb) return true;
    if (!ta && tb && rel.opposite[fb] === fa) return false;
    if (ta && !tb) return true;
    if (!ta && tb) return false;
    if (rel.onRight[fa] === fb) return true;
    if (rel.onRight[fb] === fa) return false;
    return null;
  };
  p.phases.forEach((ph, pi) => {
    const pm = phasePermits(p, net, pi);
    const adj = new Map<number, Set<number>>();
    for (const cf of net.conflicts) {
      if (cf.kind !== 'cross' || pm[cf.a] === 'none' || pm[cf.b] === 'none') continue;
      if (net.conns[cf.a].variant > 0 || net.conns[cf.b].variant > 0) continue;
      const y = staticYield(cf.a, cf.b, pm);
      if (y === null) continue;
      const [from, to] = y ? [cf.a, cf.b] : [cf.b, cf.a];
      if (!adj.has(from)) adj.set(from, new Set());
      adj.get(from)!.add(to);
    }
    // поиск цикла обходом в глубину
    const color = new Map<number, number>();
    const path: number[] = [];
    let cycle: number[] | null = null;
    const dfs = (u: number) => {
      if (cycle) return;
      color.set(u, 1);
      path.push(u);
      for (const w of adj.get(u) ?? []) {
        if (cycle) break;
        if (color.get(w) === 1) { cycle = path.slice(path.indexOf(w)); break; }
        if (!color.get(w)) dfs(w);
      }
      path.pop();
      color.set(u, 2);
    };
    for (const u of adj.keys()) if (!color.get(u) && !cycle) dfs(u);
    if (cycle) {
      const c: number[] = cycle;
      add({ level: 'warn', code: 'deadlock-static', msg: `Фаза «${ph.name}»: возможна взаимная блокировка, очерёдность замыкается в круг: ${c.map((ci) => `«${lbl(ci)}»`).join(' уступает ')} уступает «${lbl(c[0])}».`, source: 'pdd', where: `фаза ${pi + 1}` });
    }
  });

  // --- Промтакт: успевают ли освободить зону конфликта до въезда следующего потока (оценка) ---
  if (p.phases.length > 1) {
    p.phases.forEach((ph, pi) => {
      const nx = p.phases[(pi + 1) % p.phases.length];
      const nj = (pi + 1) % p.phases.length;
      const ig = intergreen(p, ph, nx);
      const pmA = phasePermits(p, net, pi), pmB = phasePermits(p, net, nj);
      let worst: { need: number; a: number; b: number } | null = null;
      for (const cf of net.conflicts) {
        for (const [A, B, aEnd, bStart] of [[cf.a, cf.b, cf.aEnd, cf.bStart], [cf.b, cf.a, cf.bEnd, cf.aStart]] as Array<[number, number, number, number]>) {
          if (pmA[A] === 'none' || pmB[A] !== 'none' || pmB[B] === 'none' || pmA[B] !== 'none') continue;
          const vA = net.conns[A].kind === 'straight' ? 10 : 7;
          const tClear = (aEnd + 5) / vA;
          const tEnter = Math.sqrt((2 * Math.max(0, bStart)) / 2.0);
          const need = tClear - tEnter;
          if (!worst || need > worst.need) worst = { need, a: A, b: B };
        }
      }
      if (worst && worst.need > ig + 0.5) {
        add({ level: worst.need > ig + 2 ? 'warn' : 'info', code: 'intergreen', msg: `Смена фазы «${ph.name}» на «${nx.name}»: последней машине «${lbl(worst.a)}» нужно около ${worst.need.toFixed(0)} с, чтобы освободить зону конфликта с «${lbl(worst.b)}», а промтакт ${ig} с. Оценка при скорости проезда 10 м/с прямо и 7 м/с на повороте.`, where: `фаза ${pi + 1}` });
      }
    });
  }

  // --- Автобусы и остановки ---
  const tr = cfg.transit;
  if (tr?.enabled) {
    for (const stop of tr.stops) {
      const arm = cfg.arms.find((a) => a.id === stop.arm);
      if (!arm || !busStopPose(net, stop)) { add({ level: 'error', code: 'stop-arm', msg: `Остановка «${stop.name}»: у подхода нет подходящих полос.` }); continue; }
      const limit = stop.side === 'approach' ? arm.approachLength - 15 : arm.exitLength - 15;
      if (stop.dist > limit) add({ level: 'warn', code: 'stop-far', msg: `Остановка «${stop.name}» находится в ${stop.dist} м, а участок модели длиной ${limit + 15} м, поэтому автобусы до неё не доедут.` });
    }
    for (const r of tr.routes) {
      if (!r.enabled) continue;
      if (!net.reachableBus[r.from]?.some((x) => x.includes(r.to))) { add({ level: 'error', code: 'route-unreachable', msg: `Маршрут «${r.name}»: с подхода «${armShort(cfg, r.from)}» нельзя проехать на «${armShort(cfg, r.to)}», автобусы не появятся.` }); continue; }
      for (const id of r.stops) {
        const stop = tr.stops.find((x) => x.id === id);
        if (!stop) continue;
        const onPath = (stop.side === 'approach' && stop.arm === r.from) || (stop.side === 'exit' && stop.arm === r.to);
        if (!onPath) add({ level: 'warn', code: 'route-stop', msg: `Маршрут «${r.name}»: остановка «${stop.name}» не на его пути через перекрёсток, автобус её проедет.` });
        if (stop.side === 'approach' && stop.arm === r.from) {
          const arm = cfg.arms.find((a) => a.id === r.from)!;
          const curb = arm.inLanes - 1;
          if (!net.reachableBus[r.from]?.[curb]?.includes(r.to) && arm.approachLength - stop.dist > arm.approachLength - arm.solidLength) {
            add({ level: 'warn', code: 'route-lane', msg: `Маршрут «${r.name}»: остановка «${stop.name}» в зоне сплошной, а повернуть на «${armShort(cfg, r.to)}» из правой полосы нельзя. Автобус не успеет перестроиться.` });
          }
        }
      }
    }
  }

  // --- Полосы и направления ---
  for (const arm of cfg.arms) {
    const d = arm.id;
    for (let l = 0; l < arm.inLanes; l++) {
      if (!net.connsFromLane[d][l]?.length) add({ level: 'error', code: 'dead-lane', msg: `Подход «${arm.short}», полоса ${l}: из неё никуда нельзя проехать.` });
    }
    const dests = cfg.spawners[d]?.params.destinations ?? {};
    for (const [to, w] of Object.entries(dests)) {
      if (!w) continue;
      if (!net.reachable[d].some((r) => r.includes(to))) {
        add({ level: 'error', code: 'unreachable', msg: `С подхода «${arm.short}» задано ${Math.round(w * 100)}% машин на «${armShort(cfg, to)}», но ни одна полоса туда не ведёт.` });
      }
    }
    const node = cfg.laneChoosers[d];
    if (node && !node.manual) {
      for (const [to, arr] of Object.entries(node.params.weights)) {
        (arr ?? []).forEach((w, l) => {
          if (w > 0 && !(net.reachable[d][l] ?? []).includes(to)) {
            add({ level: 'error', code: 'lane-weight', msg: `Точка перестроения «${arm.short}»: машины на «${armShort(cfg, to)}» отправляются в полосу ${l}, а из неё туда не проехать.` });
          }
        });
      }
    }
    // порядок полос: левые повороты — левее прямых, правые — правее (ПДД 8.5)
    const kinds = Array.from({ length: arm.inLanes }, (_, l) => (net.connsFromLane[d][l] ?? []).map((ci) => net.conns[ci].kind));
    for (let l = 0; l < arm.inLanes; l++) {
      for (let m = l + 1; m < arm.inLanes; m++) {
        if (kinds[m].includes('left') && (kinds[l].includes('straight') || kinds[l].includes('right')) && !kinds[l].includes('left')) {
          add({ level: 'warn', code: '8.5-left', msg: `Подход «${arm.short}»: поворот налево из полосы ${m}, хотя из полосы ${l} левее едут прямо или направо. Траектории пересекутся.`, source: 'pdd' });
        }
        if (kinds[l].includes('right') && (kinds[m].includes('straight') || kinds[m].includes('left')) && !kinds[m].includes('right')) {
          add({ level: 'warn', code: '8.5-right', msg: `Подход «${arm.short}»: поворот направо из полосы ${l}, хотя из полосы ${m} правее едут прямо. Траектории пересекутся.`, source: 'pdd' });
        }
        if (kinds[m].includes('uturn')) {
          add({ level: 'warn', code: '8.5-uturn', msg: `Подход «${arm.short}»: разворот из полосы ${m}, а она не крайняя левая.`, source: 'pdd' });
        }
      }
    }
  }
  // геометрия: подходы не должны накладываться
  const order = net.order;
  for (let k = 0; k < order.length && order.length > 1; k++) {
    const a = cfg.arms.find((x) => x.id === order[k])!, b = cfg.arms.find((x) => x.id === order[(k + 1) % order.length])!;
    let d = ((b.angle - a.angle) % 360 + 360) % 360;
    if (order.length === 2) d = Math.min(d, 360 - d);
    if (d < 25) add({ level: 'warn', code: 'geom-angle', msg: `Подходы «${a.short}» и «${b.short}» расходятся всего на ${d.toFixed(0)}°, траектории и разметка будут накладываться.` });
  }

  // --- Цикл ---
  const cyc = cycleLength(p);
  const { segs } = buildTimeline(p);
  void segs; void intergreen;
  const mains = p.phases.reduce((a, x) => a + x.duration, 0);
  add({ level: 'info', code: 'cycle', msg: `Длительность цикла ${cyc} с: основные такты ${mains} с, промтакты ${cyc - mains} с.` });
  if (cyc > 150) add({ level: 'warn', code: 'cycle-long', msg: `Цикл ${cyc} с. Обычно цикл стараются держать в пределах 120–150 с, иначе растут ожидание и нарушения на красный.` });
  for (const g of p.groups.filter((x) => x.kind === 'vehicle' || x.kind === 'pedestrian')) {
    const red = maxRed(p, g.id);
    if (red > 0) add({ level: 'info', code: 'max-red', msg: `Группа «${g.name}»: самый долгий запрещающий сигнал ${red.toFixed(0)} с.` });
  }
  // без повторов, сначала ошибки, затем предупреждения
  const seen = new Set<string>();
  const rank = { error: 0, warn: 1, info: 2 } as const;
  return out.filter((r) => (seen.has(r.msg) ? false : (seen.add(r.msg), true))).sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Самый долгий непрерывный запрещающий сигнал группы за цикл (с учётом перехода через конец цикла) */
export function maxRed(p: SignalProgram, groupId: string): number {
  const g = p.groups.find((x) => x.id === groupId);
  if (!g) return 0;
  const bands = groupBands(p, g);
  const isRed = (l: string) => l === 'R' || l === 'RY' || l === 'OFF' || l === 'Y';
  const cyc = bands.length ? bands[bands.length - 1].to : 0;
  if (!bands.some((b) => !isRed(b.lamp))) return cyc;
  let best = 0, cur = 0;
  // два прохода по циклу, чтобы учесть красный, переходящий через границу
  for (let k = 0; k < 2; k++) {
    for (const b of bands) {
      if (isRed(b.lamp)) { cur += b.to - b.from; best = Math.max(best, Math.min(cur, cyc)); }
      else cur = 0;
    }
  }
  return best;
}

export { longestGreen };
