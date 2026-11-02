// Подготовка встроенной подложки из выгрузки OpenStreetMap (.osm):
//   npx tsx scripts/prepare-osm.ts путь/к/map.osm
// Скрипт находит перекрёсток Оборонной и Тверской улиц, переводит координаты в метры от него,
// упрощает линии, оставляет только геометрию и нужные теги, сжимает результат и пишет
// src/assets/osm/kolpino.ts. Служебные поля выгрузки (авторы правок, версии, даты) не сохраняются.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, strToU8 } from 'fflate';

const file = process.argv[2];
if (!file) throw new Error('укажите путь к выгрузке .osm');
const xml = readFileSync(file, 'utf8');

const R_LAT = 110574, R_LON = 111320;
/** Область вокруг перекрёстка, м: по осям схемы после поворота */
const HALF_X = 420, HALF_Y = 300;
/** Допуск упрощения линий, м */
const SIMPLIFY = 0.35;

type Tags = Record<string, string>;
const attr = (s: string, name: string) => s.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tagsIn = (body: string): Tags => {
  const t: Tags = {};
  for (const m of body.matchAll(/<tag k="([^"]*)" v="([^"]*)"\s*\/>/g)) t[unesc(m[1])] = unesc(m[2]);
  return t;
};

const nodes = new Map<string, [number, number]>();
for (const m of xml.matchAll(/<node\b([^>]*?)(\/>|>([\s\S]*?)<\/node>)/g)) {
  nodes.set(attr(m[1], 'id'), [Number(attr(m[1], 'lat')), Number(attr(m[1], 'lon'))]);
}
interface Way { id: string; refs: string[]; tags: Tags }
const ways: Way[] = [];
for (const m of xml.matchAll(/<way\b([^>]*)>([\s\S]*?)<\/way>/g)) {
  ways.push({ id: attr(m[1], 'id'), refs: [...m[2].matchAll(/<nd ref="(\d+)"/g)].map((x) => x[1]), tags: tagsIn(m[2]) });
}
interface Rel { tags: Tags; members: Array<{ type: string; ref: string; role: string }> }
const rels: Rel[] = [];
for (const m of xml.matchAll(/<relation\b([^>]*)>([\s\S]*?)<\/relation>/g)) {
  rels.push({ tags: tagsIn(m[2]), members: [...m[2].matchAll(/<member type="(\w+)" ref="(\d+)" role="([^"]*)"/g)].map((x) => ({ type: x[1], ref: x[2], role: x[3] })) });
}

// --- центр перекрёстка: общая точка Оборонной и Тверской улиц ---
const isRoad = (w: Way) => !!w.tags.highway && !['footway', 'path', 'cycleway', 'steps', 'service'].includes(w.tags.highway);
const obor = ways.filter((w) => isRoad(w) && /Оборонная/.test(w.tags.name ?? ''));
const tver = ways.filter((w) => isRoad(w) && /Тверская/.test(w.tags.name ?? ''));
const tverNodes = new Set(tver.flatMap((w) => w.refs));
const shared = [...new Set(obor.flatMap((w) => w.refs).filter((r) => tverNodes.has(r)))];
if (!shared.length) throw new Error('не найдена общая точка Оборонной и Тверской улиц');
const pts = shared.map((r) => nodes.get(r)!);
const origin = { lat: pts.reduce((a, p) => a + p[0], 0) / pts.length, lon: pts.reduce((a, p) => a + p[1], 0) / pts.length };
const cosLat = Math.cos((origin.lat * Math.PI) / 180);
const proj = (lat: number, lon: number): [number, number] => [(lon - origin.lon) * cosLat * R_LON, (lat - origin.lat) * R_LAT];

// --- направления улиц у перекрёстка: точка на оси в 40 м от центра ---
function bearingAway(ws: Way[]): number[] {
  const out: number[] = [];
  for (const w of ws) {
    const idx = w.refs.findIndex((r) => shared.includes(r));
    if (idx < 0) continue;
    for (const dir of [1, -1]) {
      let acc = 0, prev = proj(...nodes.get(w.refs[idx])!);
      for (let i = idx + dir; i >= 0 && i < w.refs.length; i += dir) {
        const p = proj(...nodes.get(w.refs[i])!);
        acc += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        prev = p;
        if (acc >= 40 || i === 0 || i === w.refs.length - 1) {
          if (acc > 10) out.push((Math.atan2(p[1], p[0]) * 180) / Math.PI);
          break;
        }
      }
    }
  }
  return out;
}
const bo = bearingAway(obor), bt = bearingAway(tver);
console.log('Оборонная, направления от центра, °:', bo.map((x) => x.toFixed(1)).join(' '));
console.log('Тверская, направления от центра, °:', bt.map((x) => x.toFixed(1)).join(' '));
// поворот: среднее отклонение всех направлений от ближайшей оси 0/90/180/270
const dev = [...bo, ...bt].map((b) => { let d = ((b % 90) + 90) % 90; if (d > 45) d -= 90; return d; });
const rotation = -dev.reduce((a, b) => a + b, 0) / dev.length;
console.log('поворот подложки, °:', rotation.toFixed(2));
const rad = (rotation * Math.PI) / 180, cr = Math.cos(rad), sr = Math.sin(rad);
const inView = (p: [number, number]) => {
  const x = p[0] * cr - p[1] * sr, y = p[0] * sr + p[1] * cr;
  return Math.abs(x) <= HALF_X && Math.abs(y) <= HALF_Y;
};

// --- классификация, как в src/ui/basemap.ts ---
type Kind = 'building' | 'road' | 'path' | 'water' | 'green' | 'rail' | 'parking' | 'area';
function classify(t: Tags): { k: Kind; hw?: string } | null {
  if (t.building) return { k: 'building' };
  const hw = t.highway;
  if (hw) {
    if (['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track', 'bridleway', 'corridor'].includes(hw)) return { k: 'path', hw };
    if (['platform', 'bus_stop', 'elevator', 'crossing'].includes(hw)) return null;
    return { k: 'road', hw };
  }
  if (t.natural === 'water' || ['riverbank', 'river', 'stream', 'canal'].includes(t.waterway) || ['reservoir', 'basin'].includes(t.landuse)) return { k: 'water' };
  if (['grass', 'forest', 'meadow', 'recreation_ground', 'village_green', 'allotments', 'cemetery', 'flowerbed'].includes(t.landuse) || ['park', 'garden', 'pitch', 'playground', 'dog_park'].includes(t.leisure) || ['wood', 'scrub', 'grassland', 'heath', 'tree_row'].includes(t.natural)) return { k: 'green' };
  if (t.railway && !['platform', 'abandoned', 'razed'].includes(t.railway)) return { k: 'rail' };
  if (t.amenity === 'parking') return { k: 'parking' };
  if (['residential', 'commercial', 'retail', 'industrial', 'construction', 'garages'].includes(t.landuse)) return { k: 'area' };
  return null;
}

// --- упрощение Дугласа — Пекера ---
function simplify(p: Array<[number, number]>, eps: number): Array<[number, number]> {
  if (p.length < 3) return p;
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = p[a], [bx, by] = p[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      // у замкнутого контура концы совпадают: тогда меряем расстояние до точки
      const d = L < 1e-6 ? Math.hypot(p[i][0] - ax, p[i][1] - ay) : Math.abs((p[i][0] - ax) * dy - (p[i][1] - ay) * dx) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return p.filter((_, i) => keep[i]);
}

const KINDS: Kind[] = ['area', 'green', 'water', 'parking', 'rail', 'path', 'road', 'building'];
const hwList: string[] = [];
const nameList: string[] = [];
const idx = (list: string[], v?: string) => { if (!v) return -1; let i = list.indexOf(v); if (i < 0) { i = list.length; list.push(v); } return i; };
const feats: Array<{ k: Kind; pts: Array<[number, number]>; closed: boolean; hw?: string; name?: string }> = [];
const wayById = new Map(ways.map((w) => [w.id, w]));
function add(refs: string[], cls: { k: Kind; hw?: string }, name?: string) {
  const raw = refs.map((r) => nodes.get(r)).filter((x): x is [number, number] => !!x).map((n) => proj(n[0], n[1]));
  if (raw.length < 2 || !raw.some(inView)) return;
  const closedRing = refs.length > 3 && refs[0] === refs[refs.length - 1];
  const closed = closedRing && !['road', 'path', 'rail'].includes(cls.k);
  let pts = simplify(raw, SIMPLIFY);
  if (closed && pts.length > 1) pts = pts.slice(0, -1);
  if (pts.length < 2) return;
  feats.push({ k: cls.k, pts, closed, hw: cls.hw, name: cls.k === 'road' ? name : undefined });
}
for (const w of ways) {
  const cls = classify(w.tags);
  if (cls) add(w.refs, cls, w.tags.name);
}
for (const r of rels) {
  if (r.tags.type !== 'multipolygon') continue;
  const cls = classify(r.tags);
  if (!cls) continue;
  for (const m of r.members) {
    if (m.type !== 'way' || m.role === 'inner') continue;
    const w = wayById.get(m.ref);
    if (w) add(w.refs, cls);
  }
}
feats.sort((a, b) => KINDS.indexOf(a.k) - KINDS.indexOf(b.k));

// компактная запись: [вид, замкнут, класс дороги, название, x0, y0, dx1, dy1, …] в дециметрах
const rows = feats.map((f) => {
  const out: number[] = [KINDS.indexOf(f.k), f.closed ? 1 : 0, idx(hwList, f.hw), idx(nameList, f.name)];
  let px = 0, py = 0;
  for (const [x, y] of f.pts) {
    const qx = Math.round(x * 10), qy = Math.round(y * 10);
    out.push(qx - px, qy - py);
    px = qx; py = qy;
  }
  return out;
});
const payload = JSON.stringify({ v: 1, origin, rotation: +rotation.toFixed(2), kinds: KINDS, hw: hwList, names: nameList, f: rows });
const packed = deflateSync(strToU8(payload), { level: 9 });
const b64 = Buffer.from(packed).toString('base64');
mkdirSync(new URL('../src/assets/osm/', import.meta.url), { recursive: true });
const header = `// Сгенерировано scripts/prepare-osm.ts из выгрузки OpenStreetMap. Не править вручную.
// Данные © участники OpenStreetMap, лицензия ODbL 1.0: https://www.openstreetmap.org/copyright
// Формат: JSON, сжатый deflate и записанный в base64. Объектов: ${rows.length}.
`;
writeFileSync(new URL('../src/assets/osm/kolpino.ts', import.meta.url), `${header}export const KOLPINO_OSM = '${b64}';\n`);
const by: Record<string, number> = {};
for (const f of feats) by[f.k] = (by[f.k] ?? 0) + 1;
console.log('объектов:', rows.length, JSON.stringify(by));
console.log('точек:', feats.reduce((a, f) => a + f.pts.length, 0), 'JSON:', payload.length, 'байт, сжато:', packed.length, 'байт, base64:', b64.length, 'байт');
console.log('центр:', origin.lat.toFixed(7), origin.lon.toFixed(7));
