// Схема перекрёстка в виде самостоятельного SVG с явными цветами (без CSS страницы).
// Используется для экспорта в SVG со слоями Inkscape, для схемы в PDF и для предпросмотра в редакторе схемы.

import type { ModelConfig } from '../engine/types';
import type { Network } from '../engine/network';
import type { SimState } from '../engine/sim';
import type { Lamp } from '../engine/signals';
import { arrowLampPath, buildNodes, buildStatic, headLayout, HEAD, P, pedOffsets } from './mapdraw';
import { armPoint, busStopPose } from '../engine/network';
import { BASEMAP_DARK, BASEMAP_LIGHT, basemapSvg } from './basemap';
import { safeColor } from '../engine/limits';

export interface Palette {
  land: string;
  sidewalk: string;
  road: string;
  median: string;
  marking: string;
  zebra: string;
  label: string;
  housing: string;
  housingStroke: string;
  lampOff: string;
  red: string;
  yellow: string;
  green: string;
  ped: string;
  pedStroke: string;
  vehStroke: string;
  glass: string;
  pedGraph: string;
  node: string;
  nodeText: string;
  bad: string;
  warn: string;
}

export const LIGHT: Palette = {
  land: '#eef0ec', sidewalk: '#fbfbf9', road: '#b4bccb', median: '#d9dde4', marking: '#ffffff', zebra: '#ffffff',
  label: '#4d5564', housing: '#1d2026', housingStroke: '#555b66', lampOff: '#3a3f48', red: '#ff3b3b', yellow: '#ffcc00', green: '#2fe07a',
  ped: '#ffb703', pedStroke: '#1b1e24', vehStroke: '#20242b', glass: '#1a2230', pedGraph: '#7b3fe4', node: '#2f6fe4', nodeText: '#ffffff',
  bad: '#e5484d', warn: '#f2a33a',
};

export const DARK: Palette = {
  land: '#000000', sidewalk: '#17191e', road: '#2a2e36', median: '#3a3f49', marking: '#c9ced8', zebra: '#d9dde5',
  label: '#8a93a2', housing: '#111111', housingStroke: '#555555', lampOff: '#262a31', red: '#ff3b3b', yellow: '#ffcc00', green: '#2fe07a',
  ped: '#ffd166', pedStroke: '#000000', vehStroke: '#000000', glass: '#0a0e16', pedGraph: '#b18cff', node: '#4f8cff', nodeText: '#ffffff',
  bad: '#e5484d', warn: '#f2a33a',
};

export interface SceneOptions {
  palette: Palette;
  /** слои в формате Inkscape (inkscape:groupmode="layer") */
  inkscape?: boolean;
  /** машины, пешеходы и сигналы из состояния симуляции */
  state?: SimState | null;
  /** слои с графом: связи полос и пешеходные рёбра */
  graph?: boolean;
  labels?: boolean;
  /** 'crossing' — только перекрёсток, 'all' — вся модель */
  region?: 'crossing' | 'all';
  /** подложка OpenStreetMap, если она есть в модели */
  basemap?: boolean;
  /** подпись об авторстве подложки выводится отдельно, вне рисунка */
  attributionOutside?: boolean;
  /** ширина в пикселях (для PDF) или миллиметров на метр (для Inkscape) */
  widthPx?: number;
  mmPerMeter?: number;
  font?: string;
}

// Всё, что пришло из модели, попадает в разметку только экранированным, а цвета — только в виде #RRGGBB
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const col = (c: unknown, fallback = '#9aa3b2') => safeColor(c, fallback);
const f = (x: number) => x.toFixed(2);

export function sceneViewBox(net: Network, region: 'crossing' | 'all' = 'crossing'): { x: number; y: number; w: number; h: number } {
  if (region === 'all') {
    const b = net.bounds;
    return { x: b.minX - 5, y: -b.maxY - 5, w: b.maxX - b.minX + 10, h: b.maxY - b.minY + 10 };
  }
  let r = 40;
  for (const id of net.order) r = Math.max(r, net.arms[id].stopLine + 18);
  return { x: -r, y: -r, w: 2 * r, h: 2 * r };
}

export function sceneSvg(net: Network, cfg: ModelConfig, o: SceneOptions): string {
  const pal = o.palette;
  const st = o.state ?? null;
  const vb = sceneViewBox(net, o.region);
  const font = o.font ?? 'Inter, DejaVu Sans, Arial, sans-serif';
  const stat = buildStatic(net);
  const layers: string[] = [];
  let layerN = 0;
  const layer = (label: string, body: string) => {
    if (!body) return;
    layerN++;
    const attrs = o.inkscape ? ` inkscape:groupmode="layer" inkscape:label="${esc(label)}"` : '';
    layers.push(`<g id="layer${layerN}"${attrs}>${body}</g>`);
  };

  layer('Фон', `<rect x="${f(vb.x - 50)}" y="${f(vb.y - 50)}" width="${f(vb.w + 100)}" height="${f(vb.h + 100)}" fill="${pal.land}"/>`);
  if (o.basemap && cfg.basemap) {
    layer('Подложка OpenStreetMap', basemapSvg(cfg.basemap, pal === LIGHT ? BASEMAP_LIGHT : BASEMAP_DARK, 1) + (o.attributionOutside ? '' :
      `<text x="${f(vb.x + vb.w - 2)}" y="${f(vb.y + vb.h - 2)}" font-family="${esc(font)}" font-size="2" fill="${pal.label}" text-anchor="end">${esc(cfg.basemap.attribution)}</text>`));
  }
  layer('Тротуары и края проезжей части',
    `<path d="${stat.road}" fill="none" stroke="${pal.sidewalk}" stroke-width="7" stroke-linejoin="round"/>` +
    `<path d="${stat.road}" fill="${pal.road}"/>`);
  layer('Разделители и островки', stat.medians.map((d) => `<path d="${d}" fill="${pal.median}"/>`).join(''));
  layer('Разметка',
    stat.lines.map((l) => `<path d="${l.d}" fill="none" stroke="${pal.marking}" stroke-width="${l.width}"${l.dashed ? ' stroke-dasharray="3 6"' : ''}/>`).join('') +
    stat.stopLines.map((d) => `<path d="${d}" fill="${pal.marking}"/>`).join('') +
    stat.arrows.map((a) => `<path d="${a.d}" fill="none" stroke="${pal.marking}" stroke-width="0.32" stroke-linecap="round"/><path d="${a.heads}" fill="${pal.marking}"/>`).join(''));
  layer('Пешеходные переходы', stat.zebras.map((z) => `<path d="${z.stripes}" fill="${pal.zebra}" fill-opacity="0.92"/>`).join(''));
  if (cfg.transit?.enabled) {
    let stops = '';
    for (const sp of cfg.transit.stops) {
      const pose = busStopPose(net, sp);
      if (!pose) continue;
      const lw = net.arms[sp.arm].cfg.laneWidth;
      const c = { x: pose.p.x + pose.curb.x * lw * (sp.bay ? 0.85 : 0.2), y: pose.p.y + pose.curb.y * lw * (sp.bay ? 0.85 : 0.2) };
      const sign = { x: pose.p.x + pose.curb.x * (lw * 0.5 + 2.6), y: pose.p.y + pose.curb.y * (lw * 0.5 + 2.6) };
      stops += `<g><title>${esc(sp.name)}</title><rect transform="translate(${f(c.x)},${f(-c.y)}) rotate(${((-pose.h * 180) / Math.PI).toFixed(1)})" x="-6" y="-1.4" width="12" height="2.8" rx="0.6" fill="none" stroke="${pal.marking}" stroke-width="0.25" stroke-dasharray="1 0.6"/>` +
        `<circle cx="${f(sign.x)}" cy="${f(-sign.y)}" r="1.25" fill="#2f6fe4"/><text x="${f(sign.x)}" y="${f(-sign.y + 0.5)}" font-family="${esc(font)}" font-size="1.5" fill="#ffffff" text-anchor="middle">А</text></g>`;
    }
    layer('Остановки', stops);
  }

  if (o.labels !== false) {
    const lbl = net.order.map((d) => {
      const g = net.arms[d];
      const vertical = Math.abs(g.u.y) > 0.7;
      const p = armPoint(g, g.stopLine + (vertical ? 16 : 52), -g.outEdge - (vertical ? 2.5 : 3));
      const anchor = vertical ? (g.rOut.x > 0 ? 'start' : 'end') : 'middle';
      const name = cfg.arms.find((a) => a.id === d)?.name ?? d;
      return `<text x="${f(p.x)}" y="${f(-p.y)}" font-family="${esc(font)}" font-size="2.6" fill="${pal.label}" text-anchor="${esc(anchor)}">${esc(name)}</text>`;
    }).join('');
    layer('Подписи дорог', lbl);
  }

  if (o.graph) {
    const colorOf = new Map<string, string>();
    for (const g of cfg.signals.groups) for (const m of g.movements) if (!colorOf.has(m) || g.kind === 'vehicle') colorOf.set(m, g.color);
    layer('Граф: связи полос', net.conns.filter((c) => !c.illegal).map((c) => `<path d="M${c.path.pts.map(P).join('L')}" fill="none" stroke="${col(colorOf.get(c.conn.id), '#888888')}" stroke-width="0.45" stroke-opacity="0.85"><title>${esc(c.conn.id)}</title></path>`).join('') +
      buildNodes(net).filter((n) => n.kind === 'in' || n.kind === 'out').map((n) => `<circle cx="${f(n.p.x)}" cy="${f(-n.p.y)}" r="0.9" fill="${n.kind === 'in' ? pal.node : pal.land}" stroke="${pal.node}" stroke-width="0.3"/>`).join(''));
    layer('Граф: пешеходные рёбра и узлы', net.pedEdges.map((e) => `<path d="M${e.path.pts.map(P).join('L')}" fill="none" stroke="${pal.pedGraph}" stroke-width="0.4" stroke-dasharray="1 0.6"><title>${esc(e.id)}</title></path>`).join('') +
      net.pedNodes.map((n) => `<circle cx="${f(n.p.x)}" cy="${f(-n.p.y)}" r="1" fill="${pal.pedGraph}"><title>${esc(n.node.label)}</title></circle>`).join(''));
  }

  // светофоры
  const lamps = st?.lamps ?? {};
  const flashOn = st ? Math.floor(st.t * 2) % 2 === 0 : true;
  const lampOf = (gid: string): Lamp => {
    const l = (lamps[gid] as Lamp | undefined) ?? 'R';
    return l === 'FG' ? (flashOn ? 'G' : 'OFF') : l;
  };
  let heads = '';
  for (const h of headLayout(net, cfg)) {
    const l = lampOf(h.group);
    const tr = `translate(${f(h.p.x)},${f(-h.p.y)})`;
    if (h.kind === 'pedestrian') {
      heads += `<g transform="${tr}"><title>${esc(h.name)}</title><rect x="${-HEAD.pw / 2}" y="${-HEAD.ph / 2}" width="${HEAD.pw}" height="${HEAD.ph}" rx="0.35" fill="${pal.housing}" stroke="${pal.housingStroke}" stroke-width="0.15"/>` +
        `<circle cy="-0.72" r="0.55" fill="${l === 'R' || l === 'OFF' || l === 'Y' || l === 'RY' ? pal.red : pal.lampOff}"/><circle cy="0.72" r="0.55" fill="${l === 'G' ? pal.green : pal.lampOff}"/></g>`;
    } else if (h.kind === 'arrow') {
      const on = l === 'G';
      heads += `<g transform="${tr}"><title>${esc(h.name)}</title><rect x="${-HEAD.aw / 2}" y="${-HEAD.aw / 2}" width="${HEAD.aw}" height="${HEAD.aw}" rx="0.45" fill="${pal.housing}" stroke="${pal.housingStroke}" stroke-width="0.15"/>` +
        `<circle r="0.68" fill="${on ? pal.green : pal.lampOff}"/><path d="${arrowLampPath(h.arrow ?? 'straight')}" fill="none" stroke="${on ? '#0b1a10' : '#6b7280'}" stroke-width="0.16" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<rect x="${-HEAD.aw / 2}" y="${HEAD.aw / 2 + 0.15}" width="${HEAD.aw}" height="0.3" fill="${col(h.color)}"/></g>`;
    } else {
      heads += `<g transform="${tr}"><title>${esc(h.name)}</title><rect x="${-HEAD.w / 2}" y="${-HEAD.h / 2}" width="${HEAD.w}" height="${HEAD.h}" rx="0.6" fill="${pal.housing}" stroke="${pal.housingStroke}" stroke-width="0.15"/>` +
        `<circle cy="-1.8" r="0.65" fill="${l === 'R' || l === 'RY' ? pal.red : pal.lampOff}"/>` +
        `<circle cy="0" r="0.65" fill="${l === 'Y' || l === 'RY' ? pal.yellow : pal.lampOff}"/>` +
        `<circle cy="1.8" r="0.65" fill="${l === 'G' ? pal.green : pal.lampOff}"/>` +
        `<rect x="${-HEAD.w / 2}" y="${HEAD.h / 2 + 0.2}" width="${HEAD.w}" height="0.35" fill="${col(h.color)}"/></g>`;
    }
  }
  layer('Светофоры', heads);

  if (st) {
    const colors = Object.fromEntries(cfg.arms.map((a) => [a.id, a.color])) as Record<string, string>;
    let veh = '';
    const rname = Object.fromEntries((cfg.transit?.routes ?? []).map((r) => [r.id, (r.name.match(/^\S+/)?.[0] ?? r.id).slice(0, 4)])) as Record<string, string>;
    for (const v of st.vehicles) {
      const big = v.kind === 'truck' || v.kind === 'bus';
      const fill = v.error || v.crashed ? pal.bad : v.route ? '#f4f1e6' : col(colors[v.origin]);
      const stroke = v.crashed ? '#ffffff' : st.t - v.danger < 2 ? '#ffb020' : pal.vehStroke;
      veh += `<g transform="translate(${f(v.x)},${f(-v.y)}) rotate(${(-v.h * 180 / Math.PI).toFixed(1)})"><title>Машина ${v.id}</title>` +
        `<rect x="${f(-v.len / 2)}" y="${f(-v.wid / 2)}" width="${f(v.len)}" height="${f(v.wid)}" rx="0.45" fill="${fill}" stroke="${stroke}" stroke-width="${stroke === pal.vehStroke ? 0.12 : 0.4}"/>` +
        `<rect x="${f(v.len / 2 - (big ? 1.6 : 1.9))}" y="${f(-v.wid / 2 + 0.25)}" width="${big ? 0.9 : 1.1}" height="${f(v.wid - 0.5)}" fill="${pal.glass}" fill-opacity="0.55"/>` +
        (v.route ? `<text y="0.55"${Math.cos(v.h) < -0.05 ? ' transform="rotate(180)"' : ''} font-family="${esc(font)}" font-size="1.6" font-weight="bold" fill="#1b1e24" text-anchor="middle">${esc(rname[v.route] ?? '')}</text>` : '') + '</g>';
    }
    layer('Машины', veh);
    let peds = '';
    for (const p of st.peds) {
      const nx = -Math.sin(p.h), ny = Math.cos(p.h);
      const fill = p.hit ? pal.bad : st.t - p.danger < 2 ? pal.warn : pal.ped;
      peds += `<g><title>Пешеходы ${p.id}, человек в группе ${p.size}</title>` + pedOffsets(p.id, p.size).map((q) =>
        `<circle cx="${f(p.x + nx * q.lat)}" cy="${f(-(p.y + ny * q.lat))}" r="${q.r}" fill="${fill}" stroke="${pal.pedStroke}" stroke-width="0.1"/>`).join('') + '</g>';
    }
    layer('Пешеходы', peds);
  }

  const ns = o.inkscape
    ? ' xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"'
    : '';
  const size = o.mmPerMeter
    ? ` width="${(vb.w * o.mmPerMeter).toFixed(1)}mm" height="${(vb.h * o.mmPerMeter).toFixed(1)}mm"`
    : o.widthPx ? ` width="${o.widthPx}" height="${Math.round((o.widthPx * vb.h) / vb.w)}"` : '';
  const title = `<title>${esc(cfg.name)}</title>`;
  const named = o.inkscape ? `<sodipodi:namedview pagecolor="${pal.land}" inkscape:document-units="mm"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg"${ns} viewBox="${f(vb.x)} ${f(vb.y)} ${f(vb.w)} ${f(vb.h)}"${size}>${title}${named}${layers.join('')}</svg>`;
}
