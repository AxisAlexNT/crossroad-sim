// Подложка из данных OpenStreetMap: разбор выгрузки .osm (XML) или GeoJSON в векторные объекты
// в метрах относительно центра перекрёстка. Данные хранятся в модели и работают офлайн.
import { inflateSync, strFromU8 } from 'fflate';
import type { Basemap, BasemapFeature, BasemapKind } from '../engine/types';
import { KOLPINO_OSM } from '../assets/osm/kolpino';

export const OSM_ATTRIBUTION = '© участники OpenStreetMap, лицензия ODbL';
export const KOLPINO_ORIGIN = { lat: 59.7308223, lon: 30.6119932 };

// ---------- встроенные подложки ----------

interface PackedOsm { v: number; origin: { lat: number; lon: number }; rotation: number; kinds: BasemapKind[]; hw: string[]; names: string[]; f: number[][] }

const builtinCache = new Map<string, BasemapFeature[]>();
const BUILTIN: Record<string, string> = { kolpino: KOLPINO_OSM };

function unpack(b64: string): BasemapFeature[] {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const data = JSON.parse(strFromU8(inflateSync(u8))) as PackedOsm;
  return data.f.map((row) => {
    const g: number[] = [];
    let x = 0, y = 0;
    for (let i = 4; i + 1 < row.length; i += 2) {
      x += row[i]; y += row[i + 1];
      g.push(x / 10, y / 10);
    }
    return { k: data.kinds[row[0]], closed: row[1] === 1, hw: row[2] >= 0 ? data.hw[row[2]] : undefined, name: row[3] >= 0 ? data.names[row[3]] : undefined, g };
  });
}

/** Объекты подложки: из модели или из встроенных данных приложения */
export function basemapFeatures(bm: Basemap): BasemapFeature[] {
  if (!bm.builtin) return bm.features;
  const src = BUILTIN[bm.builtin];
  if (!src) return [];
  let f = builtinCache.get(bm.builtin);
  if (!f) { f = unpack(src); builtinCache.set(bm.builtin, f); }
  return f;
}

export const BUILTIN_NAMES: Record<string, string> = { kolpino: 'встроенная выгрузка OpenStreetMap вокруг перекрёстка в Колпино' };

const R_LAT = 110574;
const R_LON = 111320;

function classify(tags: Record<string, string>): { k: BasemapKind; hw?: string } | null {
  if (tags.building) return { k: 'building' };
  const hw = tags.highway;
  if (hw) {
    if (['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track', 'bridleway', 'corridor'].includes(hw)) return { k: 'path', hw };
    if (['platform', 'bus_stop', 'elevator', 'crossing'].includes(hw)) return null;
    return { k: 'road', hw };
  }
  if (tags.natural === 'water' || tags.waterway === 'riverbank' || tags.landuse === 'reservoir' || tags.landuse === 'basin' || tags.waterway === 'river' || tags.waterway === 'stream' || tags.waterway === 'canal') return { k: 'water' };
  if (['grass', 'forest', 'meadow', 'recreation_ground', 'village_green', 'allotments', 'cemetery'].includes(tags.landuse) || ['park', 'garden', 'pitch', 'playground', 'dog_park'].includes(tags.leisure) || ['wood', 'scrub', 'grassland', 'heath'].includes(tags.natural)) return { k: 'green' };
  if (tags.railway && tags.railway !== 'platform') return { k: 'rail' };
  if (tags.amenity === 'parking') return { k: 'parking' };
  if (['residential', 'commercial', 'retail', 'industrial', 'construction'].includes(tags.landuse)) return { k: 'area' };
  return null;
}

function project(lat: number, lon: number, o: { lat: number; lon: number }): [number, number] {
  const x = (lon - o.lon) * Math.cos((o.lat * Math.PI) / 180) * R_LON;
  const y = (lat - o.lat) * R_LAT;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

function within(g: number[], r: number): boolean {
  for (let i = 0; i < g.length; i += 2) if (Math.abs(g[i]) < r && Math.abs(g[i + 1]) < r) return true;
  return false;
}

/** Разбор выгрузки OpenStreetMap в формате XML (.osm) */
export function parseOsmXml(xml: string, origin?: { lat: number; lon: number }, radius = 500): Basemap {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('файл не похож на выгрузку OpenStreetMap');
  const nodes = new Map<string, [number, number]>();
  doc.querySelectorAll('node').forEach((n) => nodes.set(n.getAttribute('id')!, [Number(n.getAttribute('lat')), Number(n.getAttribute('lon'))]));
  if (!nodes.size) throw new Error('в файле нет точек');
  let o = origin;
  if (!o) {
    const b = doc.querySelector('bounds');
    if (b) o = { lat: (Number(b.getAttribute('minlat')) + Number(b.getAttribute('maxlat'))) / 2, lon: (Number(b.getAttribute('minlon')) + Number(b.getAttribute('maxlon'))) / 2 };
    else { const v = [...nodes.values()]; o = { lat: v.reduce((a, x) => a + x[0], 0) / v.length, lon: v.reduce((a, x) => a + x[1], 0) / v.length }; }
  }
  const tagsOf = (el: Element) => {
    const t: Record<string, string> = {};
    el.querySelectorAll(':scope > tag').forEach((x) => { t[x.getAttribute('k')!] = x.getAttribute('v')!; });
    return t;
  };
  const wayGeom = new Map<string, { g: number[]; closed: boolean; refs: string[] }>();
  const features: BasemapFeature[] = [];
  doc.querySelectorAll('way').forEach((w) => {
    const refs = [...w.querySelectorAll(':scope > nd')].map((x) => x.getAttribute('ref')!);
    const g: number[] = [];
    for (const r of refs) { const n = nodes.get(r); if (n) g.push(...project(n[0], n[1], o!)); }
    if (g.length < 4) return;
    const closed = refs.length > 3 && refs[0] === refs[refs.length - 1];
    wayGeom.set(w.getAttribute('id')!, { g, closed, refs });
    const cls = classify(tagsOf(w));
    if (!cls || !within(g, radius)) return;
    const tags = tagsOf(w);
    features.push({ k: cls.k, g, closed: closed && cls.k !== 'road' && cls.k !== 'path' && cls.k !== 'rail', name: tags.name, hw: cls.hw });
  });
  doc.querySelectorAll('relation').forEach((rel) => {
    const tags = tagsOf(rel);
    if (tags.type !== 'multipolygon') return;
    const cls = classify(tags);
    if (!cls) return;
    rel.querySelectorAll(':scope > member[type="way"]').forEach((m) => {
      if (m.getAttribute('role') === 'inner') return;
      const w = wayGeom.get(m.getAttribute('ref')!);
      if (w && w.closed && within(w.g, radius)) features.push({ k: cls.k, g: w.g, closed: true, name: tags.name });
    });
  });
  const order: BasemapKind[] = ['area', 'green', 'water', 'parking', 'rail', 'path', 'road', 'building'];
  features.sort((a, b) => order.indexOf(a.k) - order.indexOf(b.k));
  return { origin: o!, rotation: 0, dx: 0, dy: 0, features, attribution: OSM_ATTRIBUTION };
}

/** Разбор GeoJSON (например, выгрузки из OpenStreetMap через другие инструменты) */
export function parseGeoJson(text: string, origin?: { lat: number; lon: number }, radius = 500): Basemap {
  const data = JSON.parse(text) as { features?: Array<{ geometry?: { type: string; coordinates: unknown }; properties?: Record<string, string> }> };
  if (!Array.isArray(data.features)) throw new Error('в GeoJSON нет списка объектов');
  const pts: Array<[number, number]> = [];
  const lines: Array<{ c: Array<[number, number]>; closed: boolean; tags: Record<string, string> }> = [];
  for (const f of data.features) {
    const g = f.geometry;
    if (!g) continue;
    const tags = f.properties ?? {};
    const push = (c: Array<[number, number]>, closed: boolean) => { lines.push({ c, closed, tags }); pts.push(...c); };
    if (g.type === 'LineString') push(g.coordinates as Array<[number, number]>, false);
    else if (g.type === 'MultiLineString') for (const c of g.coordinates as Array<Array<[number, number]>>) push(c, false);
    else if (g.type === 'Polygon') push((g.coordinates as Array<Array<[number, number]>>)[0], true);
    else if (g.type === 'MultiPolygon') for (const p of g.coordinates as Array<Array<Array<[number, number]>>>) push(p[0], true);
  }
  if (!pts.length) throw new Error('в GeoJSON нет линий и многоугольников');
  const o = origin ?? { lat: pts.reduce((a, p) => a + p[1], 0) / pts.length, lon: pts.reduce((a, p) => a + p[0], 0) / pts.length };
  const features: BasemapFeature[] = [];
  for (const l of lines) {
    const cls = classify(l.tags);
    if (!cls) continue;
    const g: number[] = [];
    for (const [lon, lat] of l.c) g.push(...project(lat, lon, o));
    if (g.length >= 4 && within(g, radius)) features.push({ k: cls.k, g, closed: l.closed, name: l.tags.name, hw: cls.hw });
  }
  return { origin: o, rotation: 0, dx: 0, dy: 0, features, attribution: OSM_ATTRIBUTION };
}

export interface BasemapStyle {
  building: string; buildingStroke: string; road: string; roadCasing: string; path: string; water: string; green: string; rail: string; parking: string; area: string; label: string;
}

export const BASEMAP_DARK: BasemapStyle = {
  building: '#1b1e25', buildingStroke: '#2a2f39', road: '#1f232a', roadCasing: '#2c313b', path: '#3b414d', water: '#0c2131', green: '#0e1b13', rail: '#4a4f5a', parking: '#16191f', area: '#0b0d10', label: '#6b7484',
};
export const BASEMAP_LIGHT: BasemapStyle = {
  building: '#e4dfd6', buildingStroke: '#cfc8bb', road: '#ffffff', roadCasing: '#d3d7de', path: '#b9b2a6', water: '#bcd7ea', green: '#d9e9d0', rail: '#9aa0aa', parking: '#eeeeea', area: '#f1f0ec', label: '#7b8290',
};

const ROAD_W: Record<string, number> = {
  motorway: 18, trunk: 16, primary: 14, secondary: 12, tertiary: 10, unclassified: 7, residential: 7, living_street: 6, service: 4.5, road: 6,
};

/** SVG-разметка подложки (координаты экрана: y вниз). Поворот и сдвиг — через transform группы */
export function basemapSvg(bm: Basemap, st: BasemapStyle, opacity = 1): string {
  const P = (g: number[], close: boolean) => {
    let d = '';
    for (let i = 0; i < g.length; i += 2) d += (i ? 'L' : 'M') + g[i].toFixed(1) + ',' + (-g[i + 1]).toFixed(1);
    return d + (close ? 'Z' : '');
  };
  let out = '';
  // незамкнутые линии площадных видов, например ряды деревьев, рисуются линией, а не заливкой
  const fillOrLine = (d: string, closed: boolean, color: string, w: number) => (closed ? `<path d="${d}" fill="${color}"/>` : `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`);
  for (const f of basemapFeatures(bm)) {
    // координаты только числами: всё остальное отбрасывается ещё при загрузке модели, здесь — вторая проверка
    if (!Array.isArray(f.g) || !f.g.every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    const d = P(f.g, f.closed);
    switch (f.k) {
      case 'building': out += f.closed ? `<path d="${d}" fill="${st.building}" stroke="${st.buildingStroke}" stroke-width="0.3"/>` : `<path d="${d}" fill="none" stroke="${st.buildingStroke}" stroke-width="0.6"/>`; break;
      case 'water': out += fillOrLine(d, f.closed, st.water, 6); break;
      case 'green': out += fillOrLine(d, f.closed, st.green, 3); break;
      case 'parking': out += fillOrLine(d, f.closed, st.parking, 2); break;
      case 'area': out += fillOrLine(d, f.closed, st.area, 1); break;
      case 'rail': out += `<path d="${d}" fill="none" stroke="${st.rail}" stroke-width="1.2" stroke-dasharray="4 3"/>`; break;
      case 'path': out += `<path d="${d}" fill="none" stroke="${st.path}" stroke-width="1" stroke-dasharray="2 1.5" stroke-linecap="round"/>`; break;
      case 'road': {
        const w = ROAD_W[f.hw ?? ''] ?? 6;
        out += `<path d="${d}" fill="none" stroke="${st.roadCasing}" stroke-width="${w + 1.2}" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="${st.road}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
        break;
      }
    }
  }
  const n = (v: number) => (Number.isFinite(v) ? v : 0).toFixed(2);
  return `<g opacity="${n(opacity)}" transform="translate(${n(bm.dx)},${n(-bm.dy)}) rotate(${n(-bm.rotation)})">${out}</g>`;
}
