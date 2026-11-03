// Экспорт в PDF: схема перекрёстка (вектор), пиктограммы и описание фаз, ленточный график,
// графики метрик за заданное время или число шагов, итоговые показатели и проверки.
// На каждой странице — оговорка, что это результаты ограниченного моделирования.

import { jsPDF } from 'jspdf';
import 'svg2pdf.js';
import regularUrl from '../assets/fonts/DejaVuSans-subset.ttf?inline';
import boldUrl from '../assets/fonts/DejaVuSans-Bold-subset.ttf?inline';
import { app, fileBase, simRef } from './store';
import { hasCustomCode } from '../engine/compile';
import { sandboxWasm } from './sandboxLoader';
import { InteractiveClient } from './interactiveClient';
import { runReport, reportAbort } from './reportRun';
import type { Series } from '../engine/sim';
import { buildTimeline, cycleLength, groupBands, type Lamp } from '../engine/signals';
import { phasePedEdges, phasePermits, type CheckResult } from '../engine/checks';
import { chartsFor } from './charts';
import { PRESETS } from '../engine/presets';
import { LIGHT, sceneSvg } from './scene';
import type { ModelConfig } from '../engine/types';
import type { Network } from '../engine/network';

const LAMP_RGB: Record<Lamp, string> = { G: '#2fbf71', FG: '#9fe3bd', Y: '#f5c518', RY: '#f08c00', R: '#e5484d', OFF: '#c7ccd6' };

export const PDF_DISCLAIMER = 'Результаты ограниченного моделирования с допущениями. Это не готовый вывод, не заключение, не отчёт и не исследование.';

function b64(dataUrl: string) {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

function parseSvg(text: string): SVGSVGElement {
  // svg2pdf читает стили из атрибутов, поэтому схема строится с явными цветами
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const el = doc.documentElement as unknown as SVGSVGElement;
  // svg2pdf нужен элемент в документе, чтобы вычислить размеры текста
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:10px;height:10px;overflow:hidden';
  host.appendChild(document.importNode(el, true));
  document.body.appendChild(host);
  const live = host.firstChild as SVGSVGElement;
  return live;
}

async function drawSvg(doc: jsPDF, svg: SVGSVGElement, options: { x: number; y: number; width: number; height: number }) {
  try { await doc.svg(svg, options); }
  finally { svg.parentElement?.remove(); }
}

function pictoSvg(cfg: ModelConfig, net: Network, phaseIdx: number): SVGSVGElement {
  let R = 34;
  for (const id of net.order) R = Math.max(R, net.arms[id].stopLine + 8);
  const pm = phasePermits(cfg.signals, net, phaseIdx);
  const groups = cfg.signals.groups;
  const colorOf = (id: string) => groups.find((g) => g.kind === 'vehicle' && g.movements.includes(id))?.color ?? groups.find((g) => g.movements.includes(id))?.color ?? '#888888';
  let body = `<rect x="${-R}" y="${-R}" width="${2 * R}" height="${2 * R}" rx="4" fill="#f3f4f7" stroke="#c9ced8" stroke-width="0.6"/>`;
  net.conns.forEach((c, i) => {
    const d = 'M' + c.path.pts.map((q) => `${q.x.toFixed(1)},${(-q.y).toFixed(1)}`).join('L');
    if (pm[i] === 'none') body += `<path d="${d}" fill="none" stroke="#d3d7df" stroke-width="1"/>`;
  });
  for (const ei of phasePedEdges(cfg.signals, net, phaseIdx)) {
    const e = net.pedEdges[ei];
    const d = 'M' + e.path.pts.map((q) => `${q.x.toFixed(1)},${(-q.y).toFixed(1)}`).join('L');
    body += `<path d="${d}" fill="none" stroke="#555555" stroke-width="2" stroke-dasharray="1 1"/>`;
  }
  net.conns.forEach((c, i) => {
    if (pm[i] === 'none') return;
    const pts = c.path.pts;
    const d = 'M' + pts.map((q) => `${q.x.toFixed(1)},${(-q.y).toFixed(1)}`).join('L');
    const col = colorOf(c.conn.id);
    body += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2.4" ${pm[i] === 'arrow' ? 'stroke-dasharray="3 2"' : ''}/>`;
    const a = pts[pts.length - 1], b = pts[pts.length - 2];
    const ang = Math.atan2(-(a.y - b.y), a.x - b.x) * 180 / Math.PI;
    body += `<path transform="translate(${a.x.toFixed(1)},${(-a.y).toFixed(1)}) rotate(${ang.toFixed(1)})" d="M0,0 L-3.4,-1.9 L-3.4,1.9 Z" fill="${col}"/>`;
  });
  return parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-R} ${-R} ${2 * R} ${2 * R}" width="200" height="200">${body}</svg>`);
}

function drawChart(doc: jsPDF, x: number, y: number, w: number, h: number, title: string, t: number[], series: Array<{ label: string; color: string; values: number[] }>) {
  doc.setFont('DejaVuSans', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(30);
  const tl = (doc.splitTextToSize(title, w) as string[]).slice(0, 2);
  doc.text(tl, x, y - 2 - (tl.length - 1) * 3.4);
  doc.setDrawColor(200);
  doc.setLineWidth(0.2);
  doc.rect(x, y, w, h);
  if (!t.length) return;
  const tMax = t[t.length - 1] || 1;
  let vMax = 0;
  for (const s of series) for (const v of s.values) if (Number.isFinite(v)) vMax = Math.max(vMax, v);
  vMax = vMax || 1;
  // круглые деления оси: 1, 2 или 5 на степень десяти
  const raw = vMax / 4;
  const p10 = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p10;
  const stepV = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p10;
  vMax = Math.ceil(vMax / stepV - 1e-9) * stepV;
  doc.setFont('DejaVuSans', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(110);
  for (let v = 0; v <= vMax + 1e-9; v += stepV) {
    const yy = y + h - (h * v) / vMax;
    doc.setDrawColor(235);
    doc.line(x, yy, x + w, yy);
    doc.text(String(+v.toFixed(stepV < 1 ? 1 : 0)), x - 1, yy + 1, { align: 'right' });
  }
  for (let k = 0; k <= 4; k++) doc.text(`${Math.round((tMax * k) / 4)} с`, x + (w * k) / 4, y + h + 3.5, { align: 'center' });
  const step = Math.max(1, Math.floor(t.length / 400));
  let lx = x + 2, ly = y + h + 7.4;
  series.forEach((s) => {
    doc.setDrawColor(s.color);
    doc.setLineWidth(0.45);
    let prev: [number, number] | null = null;
    for (let i = 0; i < t.length; i += step) {
      if (!Number.isFinite(s.values[i])) { prev = null; continue; }
      const px = x + (t[i] / tMax) * w;
      const py = y + h - (Math.min(vMax, s.values[i] ?? 0) / vMax) * h;
      if (prev) doc.line(prev[0], prev[1], px, py);
      prev = [px, py];
    }
    const label = s.label;
    const lw = doc.getTextWidth(label) + 7;
    if (lx + lw > x + w) { lx = x + 2; ly += 3.4; }
    doc.setFillColor(s.color);
    doc.rect(lx, ly - 1.4, 3, 1.6, 'F');
    doc.setTextColor(60);
    doc.text(label, lx + 4, ly);
    lx += lw;
  });
}

export interface PdfOptions {
  source: 'current' | 'rerun';
  unit: 'seconds' | 'steps';
  amount: number;
  signal?: AbortSignal;
}

export async function exportPdf(o: PdfOptions): Promise<void> {
  const cfg: ModelConfig = JSON.parse(JSON.stringify(app.cfg));
  const cur = simRef.value;
  if (!cur) throw new Error('модель не готова');
  reportAbort(o.signal);
  let series: Series = structuredClone(cur.series);
  let state = structuredClone(cur.st);
  const net = cur.net;
  const checks = JSON.parse(JSON.stringify(app.checks)) as CheckResult[];
  const presetId = app.presetId, showBasemap = app.showBasemap;
  const outputName = fileBase();
  if (o.source === 'rerun') {
    const wasm = hasCustomCode(cfg) ? (await sandboxWasm()).slice().buffer : undefined;
    reportAbort(o.signal);
    const frame = await runReport(new InteractiveClient(wasm), cfg, o);
    state = frame.state;
    series = frame.details!.series;
  }
  reportAbort(o.signal);

  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  doc.addFileToVFS('DejaVuSans.ttf', b64(regularUrl));
  doc.addFont('DejaVuSans.ttf', 'DejaVuSans', 'normal');
  doc.addFileToVFS('DejaVuSans-Bold.ttf', b64(boldUrl));
  doc.addFont('DejaVuSans-Bold.ttf', 'DejaVuSans', 'bold');
  doc.setFont('DejaVuSans', 'normal');
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 14;
  const TOP = 20, BOTTOM = H - 16;
  let y = TOP;
  const newPage = () => { doc.addPage(); y = TOP; };
  const text = (s: string, size = 10, bold = false, color = 20) => {
    doc.setFont('DejaVuSans', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(color);
    const lines = doc.splitTextToSize(s, W - 2 * M) as string[];
    for (const l of lines) {
      if (y > BOTTOM) newPage();
      doc.text(l, M, y);
      y += size * 0.45;
    }
    y += 1;
  };

  // --- страница 1: схема ---
  const preset = PRESETS.find((p) => p.id === presetId);
  text(cfg.name, 15, true);
  text(`Экспорт результатов модели светофорного регулирования · ${new Date().toLocaleString('ru-RU')}`, 9, false, 90);
  if (preset && cfg.arms.length === 4) text(`Исходная схема: ${preset.name}. Программа могла быть изменена вручную.`, 9, false, 90);
  {
    const svg = parseSvg(sceneSvg(net, cfg, { palette: LIGHT, state, region: 'crossing', widthPx: 800, font: 'DejaVuSans', basemap: showBasemap, attributionOutside: true }));
    const size = Math.min(W - 2 * M, BOTTOM - y - 30);
    reportAbort(o.signal);
    await drawSvg(doc, svg, { x: M + (W - 2 * M - size) / 2, y: y + 2, width: size, height: size });
    y += size + 6;
  }
  if (app.showBasemap && cfg.basemap) text(`Подложка: ${cfg.basemap.attribution}.`, 8, false, 100);
  text('Цвет машины — подход, откуда она едет. Красные — ошибка выбора полосы или столкновение в модели. Жёлтые кружки — пешеходы, группа показана несколькими кружками рядом. Стрелки на полосах соответствуют разрешённым направлениям модели.', 8, false, 100);
  text('Модель создана с использованием технологий ИИ-агентов. Сведения и результаты нужно проверять, их нельзя использовать как единственный аргумент или доказательство.', 8, false, 100);

  // --- страница 2: фазы ---
  newPage();
  text('Светофорная программа', 14, true);
  const t = cfg.signals.timing;
  text(`Цикл ${cycleLength(cfg.signals)} с. Промтакт: жёлтый ${t.yellow} с, красный с жёлтым ${t.redYellow} с, мигание зелёного ${t.flashGreen} с, «все красные» ${t.allRed} с, пешеходный ${t.pedClearance} с. ` +
    (cfg.signals.controller === 'code' ? 'Адаптивное управление кодом, код приведён ниже.' : 'Жёсткая программа, фазы идут по кругу.'), 9);
  const cols = 3;
  const cell = (W - 2 * M) / cols;
  const pictoSize = cell - 10;
  for (let i = 0; i < cfg.signals.phases.length; i++) {
    const ph = cfg.signals.phases[i];
    const col = i % cols;
    if (col === 0 && i > 0) y += pictoSize + 30;
    if (y + pictoSize + 24 > BOTTOM) newPage();
    const x = M + col * cell;
    reportAbort(o.signal);
    await drawSvg(doc, pictoSvg(cfg, net, i), { x: x + 2, y, width: pictoSize, height: pictoSize });
    doc.setFont('DejaVuSans', 'bold'); doc.setFontSize(9); doc.setTextColor(20);
    const head = doc.splitTextToSize(`${ph.name} — ${ph.duration} с`, cell - 4) as string[];
    doc.text(head, x + 2, y + pictoSize + 4);
    doc.setFont('DejaVuSans', 'normal'); doc.setFontSize(7); doc.setTextColor(80);
    const names = ph.green.map((g) => cfg.signals.groups.find((x) => x.id === g)?.name ?? g).join(', ');
    doc.text(doc.splitTextToSize(`Зелёный: ${names || '—'}`, cell - 4) as string[], x + 2, y + pictoSize + 5 + head.length * 4);
  }
  y += pictoSize + 34;
  if (y > BOTTOM - 50) newPage();
  text('Ленточный график цикла', 11, true);
  const tl = buildTimeline(cfg.signals);
  const gx = M + 52, gw = W - 2 * M - 52;
  for (const g of cfg.signals.groups) {
    if (y > BOTTOM) newPage();
    doc.setFontSize(6.5); doc.setTextColor(40); doc.setFont('DejaVuSans', 'normal');
    const lines = (doc.splitTextToSize(g.name, 50) as string[]).slice(0, 2);
    doc.text(lines, M, y + (lines.length > 1 ? 1.6 : 3));
    for (const b of groupBands(cfg.signals, g)) {
      doc.setFillColor(LAMP_RGB[b.lamp]);
      doc.rect(gx + (b.from / tl.cycle) * gw, y, ((b.to - b.from) / tl.cycle) * gw, 4, 'F');
    }
    y += lines.length > 1 ? 7 : 5.5;
  }
  doc.setFontSize(7); doc.setTextColor(100);
  doc.text('0 с', gx, y + 2); doc.text(`${tl.cycle} с`, gx + gw, y + 2, { align: 'right' });
  y += 6;
  text('Сигнальные группы и направления', 11, true);
  for (const g of cfg.signals.groups) {
    const kind = g.kind === 'arrow' ? 'допсекция' : g.kind === 'pedestrian' ? 'пешеходный светофор' : 'основной светофор';
    const mv = g.movements.map((m) => {
      if (g.kind === 'pedestrian') {
        const ei = net.pedEdgeById.get(m);
        if (ei === undefined) return m;
        const e = net.pedEdges[ei];
        return `${net.pedNodes[e.from].node.label} — ${net.pedNodes[e.to].node.label}`;
      }
      const ci = net.connById.get(m);
      return ci === undefined ? m : cur.connLabel(ci);
    }).join(' · ');
    text(`${g.id} — ${g.name}, ${kind}.${mv ? ' ' + mv : ''}`, 8);
  }
  if (cfg.signals.controller === 'code') {
    text('Код контроллера', 11, true);
    text(cfg.signals.code, 7);
  }

  // --- страница 3: графики ---
  newPage();
  text(`Метрики. ${o.source === 'rerun' ? `Новый прогон: ${o.amount} ${o.unit === 'seconds' ? 'с' : 'переключений фаз'}` : `Текущая симуляция, ${state.t.toFixed(0)} с`}`, 13, true);
  y += 4;
  const ch = chartsFor(cfg).filter((c) => c.id !== 'errors');
  const chw = (W - 2 * M - 14) / 2, chh = 40;
  const perPage = 6;
  let base = y;
  ch.forEach((c, i) => {
    if (i > 0 && i % perPage === 0) { newPage(); base = y + 4; }
    const k = i % perPage;
    const cx = M + 10 + (k % 2) * (chw + 10);
    const cy = base + 4 + Math.floor(k / 2) * (chh + 26);
    drawChart(doc, cx, cy, chw - 6, chh, c.title, series.t, c.series(series));
  });
  const lastRows = Math.ceil(((ch.length - 1) % perPage + 1) / 2);
  y = base + 4 + lastRows * (chh + 26) + 4;
  const c = state.counters;
  text(`Итоги. Машины: проехало стоп-линию ${c.crossedStop}, покинуло модель ${c.exited}, опасных моментов ${c.dangers}, пересечений траекторий ${c.crossings}, столкновений в модели ${c.collisions}, ошибок выбора полосы ${c.errors}, максимальная очередь ${state.maxQueue} авт.`, 9);
  text(`Пешеходы: перешли ${c.pedDone} чел., опасных сближений с машинами ${c.pedDangers}, наездов ${c.pedHits}.`, 9);

  // --- страница 4: проверки ---
  newPage();
  text('Проверки конфигурации', 13, true);
  const LV: Record<CheckResult['level'], string> = { error: 'Ошибка', warn: 'Предупреждение', info: 'Сведения' };
  for (const r of checks) text(`${LV[r.level]}: ${r.msg}`, 8, false, r.level === 'error' ? 160 : 40);

  // колонтитулы на всех страницах
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('DejaVuSans', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(120);
    doc.text(doc.splitTextToSize(PDF_DISCLAIMER, W - 2 * M) as string[], M, 9);
    doc.setDrawColor(210);
    doc.setLineWidth(0.2);
    doc.line(M, 12.5, W - M, 12.5);
    doc.line(M, H - 11, W - M, H - 11);
    doc.text(`${cfg.name} · модель, не замер`, M, H - 7);
    doc.text(`${i} / ${pages}`, W - M, H - 7, { align: 'right' });
  }
  reportAbort(o.signal);
  doc.save(`${outputName}.pdf`);
}
