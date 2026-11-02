<script setup lang="ts">
// Карта перекрёстка: векторная статика (Vue) и динамический слой машин и пешеходов (императивно, 30–60 к/с).
// Работает в двух контекстах: живая модель симулятора и черновик в редакторе.
// Режимы правки: связи полос, пешеходный граф, подходы (поворот, переход), остановки.
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { app, simRef } from './store';
import { editor, useCtx, type Ctx } from './ctx';
import { onRender, requestRender } from './loop';
import { arrowLampPath, buildNodes, buildStatic, headLayout, pedOffsets, P, HEAD, type MapNode } from './mapdraw';
import { conn as mkConn, pedEdgeId } from '../engine/generate';
import type { ArmId } from '../engine/types';
import { armPoint, busStopPose } from '../engine/network';
import { BASEMAP_DARK, BASEMAP_LIGHT, basemapSvg, OSM_ATTRIBUTION } from './basemap';

const props = defineProps<{ ctx?: Ctx }>();
const C = useCtx(() => props.ctx);
const cfg = C.cfg;
const live = computed(() => !C.isEditor.value);
const helpOpen = ref(false);

const svgEl = ref<SVGSVGElement | null>(null);
const dynVeh = ref<SVGGElement | null>(null);
const dynPed = ref<SVGGElement | null>(null);
const dynMarks = ref<SVGGElement | null>(null);
const wrap = ref<HTMLDivElement | null>(null);

const view = reactive({ cx: -5, cy: 0, vw: 130, w: 600, h: 500 });
type DragKind = '' | 'pan' | 'conn' | 'node' | 'ped' | 'arm' | 'cw' | 'stop';
const drag = reactive({ active: false, kind: '' as DragKind, node: null as MapNode | null, ped: '', arm: '', stop: '', x: 0, y: 0, sx: 0, sy: 0, wx0: 0, wy0: 0, moved: false });
const pointers = new Map<number, { x: number; y: number }>();
let pinchStart: { d: number; vw: number } | null = null;

// сеть: в симуляторе — из симуляции, в редакторе — из черновика
const net = C.net;
const stat = computed(() => (net.value ? buildStatic(net.value) : null));
const nodes = computed(() => (net.value ? buildNodes(net.value) : []));
const editLayer = computed(() => (C.isEditor.value ? editor.layer : app.editMode ? app.editLayer : ''));
const pedMode = computed(() => editLayer.value === 'ped');
const vehMode = computed(() => editLayer.value === 'veh');
const armMode = computed(() => editLayer.value === 'arms');
const stopMode = computed(() => editLayer.value === 'stops');
const graphOn = computed(() => C.isEditor.value || app.showGraph || vehMode.value || pedMode.value);

const viewBox = computed(() => {
  const vw = Number.isFinite(view.vw) && view.vw > 0 ? view.vw : 200;
  const vh = vw * (Math.max(1, view.h) / Math.max(1, view.w));
  return `${view.cx - vw / 2} ${-view.cy - vh / 2} ${vw} ${vh}`;
});
const scale = computed(() => view.vw / Math.max(1, view.w));
const nodeR = computed(() => Math.max(0.9, Math.min(2.6, scale.value * 9)));

const groupColor = computed(() => {
  const map = new Map<string, string>();
  for (const g of cfg.value.signals.groups) for (const m of g.movements) if (!map.has(m) || g.kind === 'vehicle') map.set(m, g.color);
  return map;
});

const connPaths = computed(() => {
  const n = net.value;
  if (!n) return [];
  return n.conns.filter((c) => !c.illegal).map((c) => ({ id: c.conn.id, idx: c.idx, d: 'M' + c.path.pts.map(P).join('L'), color: groupColor.value.get(c.conn.id) ?? '#888', kind: c.kind, bus: c.busOnly, alt: c.variant > 0 }));
});

const pedGraph = computed(() => {
  const n = net.value;
  if (!n) return { nodes: [], edges: [] };
  const sources = new Set(cfg.value.peds.sources.filter((s) => s.rate > 0).map((s) => s.node));
  return {
    nodes: n.pedNodes.map((x) => ({ id: x.node.id, kind: x.node.kind, label: x.node.label, x: x.p.x, y: -x.p.y, source: sources.has(x.node.id) })),
    edges: n.pedEdges.map((e) => ({ id: e.id, idx: e.idx, d: 'M' + e.path.pts.map(P).join('L'), kind: e.kind, signalled: groupColor.value.has(e.id) })),
  };
});

const heads = computed(() => {
  const n = net.value;
  if (!n) return [];
  return headLayout(n, cfg.value).map((h) => ({ ...h, x: h.p.x, y: -h.p.y }));
});

const stops = computed(() => {
  const n = net.value;
  if (!n || !cfg.value.transit?.enabled) return [];
  return cfg.value.transit.stops.map((s) => {
    const pose = busStopPose(n, s);
    if (!pose) return null;
    const lw = n.arms[s.arm].cfg.laneWidth;
    const c = { x: pose.p.x + pose.curb.x * lw * (s.bay ? 0.85 : 0.2), y: pose.p.y + pose.curb.y * lw * (s.bay ? 0.85 : 0.2) };
    const sign = { x: pose.p.x + pose.curb.x * (lw * 0.5 + 2.6), y: pose.p.y + pose.curb.y * (lw * 0.5 + 2.6) };
    return { id: s.id, name: s.name, x: c.x, y: -c.y, h: (-pose.h * 180) / Math.PI, sx: sign.x, sy: -sign.y, bay: s.bay };
  }).filter(Boolean) as Array<{ id: string; name: string; x: number; y: number; h: number; sx: number; sy: number; bay: boolean }>;
});

const armHandles = computed(() => {
  const n = net.value;
  if (!n || !armMode.value) return [];
  return n.order.map((id) => {
    const g = n.arms[id];
    const end = armPoint(g, g.stopLine + 13, 0);
    const cw = armPoint(g, g.cfg.crosswalkOffset, -(g.outEdge + 2.2));
    return { id, ex: end.x, ey: -end.y, cx: cw.x, cy: -cw.y, angle: g.cfg.angle };
  });
});

const conflictPts = computed(() => (net.value ? net.value.conflicts.map((c) => ({ id: c.id, a: c.a, b: c.b, x: c.p.x, y: -c.p.y, kind: c.kind, illegal: net.value!.conns[c.a].illegal || net.value!.conns[c.b].illegal })).filter((c) => !c.illegal) : []));

const basemapMarkup = computed(() => {
  const bm = cfg.value.basemap;
  if (!bm || !app.showBasemap) return '';
  return basemapSvg(bm, app.theme === 'dark' ? BASEMAP_DARK : BASEMAP_LIGHT, app.basemapOpacity);
});

function toWorld(clientX: number, clientY: number) {
  const svg = svgEl.value!;
  const pt = svg.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const r = pt.matrixTransform(m.inverse());
  return { x: r.x, y: -r.y };
}

function resize() {
  const el = wrap.value;
  if (!el) return;
  view.w = el.clientWidth;
  view.h = el.clientHeight;
  if (pendingFit && view.w >= 10 && view.h >= 10) fit();
  requestRender();
}

let pendingFit = false;
function fit(all = false) {
  // карта скрыта на другой вкладке: подогнать масштаб, когда она снова появится
  if (view.w < 10 || view.h < 10) { pendingFit = true; return; }
  pendingFit = false;
  const aspect = view.h / Math.max(1, view.w);
  if (all && net.value) {
    const b = net.value.bounds;
    view.cx = (b.minX + b.maxX) / 2;
    view.cy = (b.minY + b.maxY) / 2;
    view.vw = Math.max(b.maxX - b.minX, (b.maxY - b.minY) / aspect) * 1.05;
  } else {
    let r = 40;
    if (net.value) for (const id of net.value.order) r = Math.max(r, net.value.arms[id].stopLine + 18);
    view.cx = 0; view.cy = 0;
    view.vw = Math.max(2 * r, (2 * r) / aspect);
  }
  requestRender();
}

function zoom(k: number, around?: { x: number; y: number }) {
  const c = around ?? { x: view.cx, y: view.cy };
  const nv = Math.max(15, Math.min(1500, view.vw * k));
  const f = nv / view.vw;
  view.cx = c.x + (view.cx - c.x) * f;
  view.cy = c.y + (view.cy - c.y) * f;
  view.vw = nv;
  requestRender();
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  zoom(Math.exp(e.deltaY * 0.0015), toWorld(e.clientX, e.clientY));
}

function nodeAt(world: { x: number; y: number }, kind: MapNode['kind'], tol: number) {
  let best: MapNode | null = null, bd = tol;
  for (const n of nodes.value) {
    if (n.kind !== kind) continue;
    const d = Math.hypot(n.p.x - world.x, n.p.y - world.y);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

function pedNodeAt(world: { x: number; y: number }, tol: number, except = '') {
  let best = '', bd = tol;
  for (const n of net.value?.pedNodes ?? []) {
    if (n.node.id === except) continue;
    const d = Math.hypot(n.p.x - world.x, n.p.y - world.y);
    if (d < bd) { bd = d; best = n.node.id; }
  }
  return best;
}

function touched() {
  if (C.isEditor.value) { editor.dirty = true; editor.version++; }
}

function onPointerDown(e: PointerEvent) {
  (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), vw: view.vw };
    drag.active = false;
    return;
  }
  const w = toWorld(e.clientX, e.clientY);
  const target = e.target as Element;
  const attr = (n: string) => target.closest(`[${n}]`)?.getAttribute(n) ?? null;
  const nodeKey = attr('data-node');
  const pedNode = attr('data-pednode');
  const pedEdge = attr('data-pededge');
  const vid = attr('data-vid');
  const pid = attr('data-pid');
  const gid = attr('data-group');
  const cid = attr('data-conn');
  const armH = attr('data-armh');
  const cwH = attr('data-cwh');
  const stopId = attr('data-stop');
  drag.sx = e.clientX; drag.sy = e.clientY; drag.x = w.x; drag.y = w.y; drag.wx0 = w.x; drag.wy0 = w.y; drag.moved = false;
  const start = (kind: DragKind) => { drag.kind = kind; drag.active = true; };
  if (armH && armMode.value) { drag.arm = armH; start('arm'); return; }
  if (cwH && armMode.value) { drag.arm = cwH; start('cw'); return; }
  if (stopId) { drag.stop = stopId; start('stop'); return; }
  if (pedNode && pedMode.value) { drag.ped = pedNode; start('ped'); return; }
  if (nodeKey) {
    const n = nodes.value.find((x) => x.key === nodeKey) ?? null;
    drag.node = n;
    start(n && n.kind === 'in' && vehMode.value ? 'conn' : 'node');
    return;
  }
  if (vid && live.value) { C.select({ kind: 'vehicle', id: Number(vid) }); app.highlightVid = Number(vid); requestRender(); return; }
  if (pid && live.value) { C.select({ kind: 'ped', id: Number(pid) }); return; }
  if (gid) { C.select({ kind: 'group', id: gid }); return; }
  if (pedEdge && pedMode.value) { C.select({ kind: 'pededge', id: pedEdge }); return; }
  if (cid && vehMode.value) { C.select({ kind: 'conn', id: cid }); return; }
  start('pan');
}

function onPointerMove(e: PointerEvent) {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    view.vw = Math.max(15, Math.min(1500, pinchStart.vw * (pinchStart.d / Math.max(10, d))));
    requestRender();
    return;
  }
  if (!drag.active) return;
  if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
  if (drag.kind === 'pan') {
    const k = scale.value;
    view.cx -= (e.clientX - drag.sx) * k;
    view.cy += (e.clientY - drag.sy) * k;
    drag.sx = e.clientX; drag.sy = e.clientY;
    requestRender();
  } else {
    const w = toWorld(e.clientX, e.clientY);
    drag.x = w.x; drag.y = w.y;
  }
}

function projectOnArm(arm: ArmId, w: { x: number; y: number }) {
  const g = net.value!.arms[arm];
  return (w.x - g.axis.x) * g.u.x + (w.y - g.axis.y) * g.u.y;
}

function armCfg(id: ArmId) {
  return cfg.value.arms.find((a) => a.id === id)!;
}

function onPointerUp(e: PointerEvent) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
  if (!drag.active) return;
  drag.active = false;
  const n = drag.node;
  const c = cfg.value;
  if (drag.kind === 'arm') {
    if (drag.moved) {
      const a = armCfg(drag.arm);
      a.angle = ((Math.round((Math.atan2(drag.y, drag.x) * 180) / Math.PI) % 360) + 360) % 360;
      touched();
    } else C.select({ kind: 'arm', arm: drag.arm });
  } else if (drag.kind === 'cw') {
    if (drag.moved) {
      const a = armCfg(drag.arm);
      a.crosswalkOffset = Math.max(5, Math.min(80, Math.round(projectOnArm(drag.arm, { x: drag.x, y: drag.y }) * 2) / 2));
      touched();
    } else C.select({ kind: 'arm', arm: drag.arm });
  } else if (drag.kind === 'stop') {
    const st = c.transit.stops.find((x) => x.id === drag.stop);
    if (st && drag.moved && (stopMode.value || C.isEditor.value)) {
      const g = net.value!.arms[st.arm];
      const s = projectOnArm(st.arm, { x: drag.x, y: drag.y });
      st.dist = Math.max(5, Math.round(st.side === 'approach' ? s - g.stopLine : s - g.exitStart));
      touched();
    }
    C.select({ kind: 'stop', id: drag.stop });
  } else if (drag.kind === 'ped') {
    const from = drag.ped;
    if (!drag.moved) C.select({ kind: 'pednode', id: from });
    else {
      const to = pedNodeAt({ x: drag.x, y: drag.y }, Math.max(2.5, nodeR.value * 2.2), from);
      if (to) {
        const exists = c.peds.edges.find((x) => (x.from === from && x.to === to) || (x.from === to && x.to === from));
        if (exists) C.select({ kind: 'pededge', id: exists.id });
        else {
          const id = pedEdgeId(from, to);
          c.peds.edges.push({ id, from, to, width: 4 });
          C.select({ kind: 'pededge', id });
        }
      } else {
        const node = c.peds.nodes.find((x) => x.id === from);
        if (node) {
          const dx = drag.x - drag.wx0, dy = drag.y - drag.wy0;
          if (node.kind === 'point') { node.x = +((node.x ?? 0) + dx).toFixed(1); node.y = +((node.y ?? 0) + dy).toFixed(1); }
          else { node.dx = +((node.dx || 0) + dx).toFixed(1); node.dy = +((node.dy || 0) + dy).toFixed(1); }
          C.select({ kind: 'pednode', id: from });
        }
      }
      touched();
    }
  } else if (drag.kind === 'conn' && n) {
    if (drag.moved) {
      const out = nodeAt({ x: drag.x, y: drag.y }, 'out', Math.max(3, nodeR.value * 2.2));
      if (out) {
        const cn = mkConn(n.arm, n.lane, out.arm, out.lane);
        if (!c.connections.some((x) => x.id === cn.id)) {
          c.connections.push(cn);
          const g = c.signals.groups.find((x) => x.kind === 'vehicle' && x.arm === n.arm);
          if (g && !g.movements.includes(cn.id)) g.movements.push(cn.id);
          touched();
        }
        C.select({ kind: 'conn', id: cn.id });
      }
    } else C.select({ kind: 'lanes', arm: n.arm });
  } else if (drag.kind === 'node' && n) {
    if (drag.moved && (vehMode.value || armMode.value) && n.kind !== 'in' && n.kind !== 'out') {
      const g = net.value!.arms[n.arm];
      const s = projectOnArm(n.arm, { x: drag.x, y: drag.y });
      const arm = armCfg(n.arm);
      if (n.kind === 'spawn') arm.approachLength = Math.round(Math.max(arm.solidLength + 10, Math.min(600, s - g.stopLine)));
      if (n.kind === 'lanes') arm.solidLength = Math.round(Math.max(5, Math.min(arm.approachLength - 10, s - g.stopLine)));
      if (n.kind === 'exit') arm.exitLength = Math.round(Math.max(20, Math.min(600, s - g.exitStart)));
      touched();
    } else {
      if (n.kind === 'spawn') C.select({ kind: 'spawner', arm: n.arm });
      if (n.kind === 'lanes') C.select({ kind: 'lanes', arm: n.arm });
      if (n.kind === 'exit' || n.kind === 'out') C.select({ kind: 'exit', arm: n.arm });
      if (n.kind === 'in') C.select({ kind: 'lanes', arm: n.arm });
    }
  }
  drag.node = null;
  drag.ped = '';
  drag.kind = '';
}

function onDblClick(e: MouseEvent) {
  if (!pedMode.value) return;
  const target = e.target as Element;
  if (target.closest('[data-pednode],[data-pededge],[data-group]')) return;
  const w = toWorld(e.clientX, e.clientY);
  const c = cfg.value;
  let k = 1;
  while (c.peds.nodes.some((n) => n.id === `P${k}`)) k++;
  const id = `P${k}`;
  c.peds.nodes.push({ id, kind: 'point', arms: [], label: `точка ${k}`, x: +w.x.toFixed(1), y: +w.y.toFixed(1), dx: 0, dy: 0 });
  C.select({ kind: 'pednode', id });
  touched();
}

const dragPreview = computed(() => {
  if (!drag.active || !drag.moved) return null;
  if (drag.kind === 'ped') {
    const p = net.value?.pedNodes.find((x) => x.node.id === drag.ped)?.p;
    if (!p) return null;
    const to = pedNodeAt({ x: drag.x, y: drag.y }, Math.max(2.5, nodeR.value * 2.2), drag.ped);
    return { x1: p.x, y1: -p.y, x2: drag.x, y2: -drag.y, label: to ? 'переход' : 'перенести' };
  }
  if (drag.kind === 'arm') {
    const ang = ((Math.round((Math.atan2(drag.y, drag.x) * 180) / Math.PI) % 360) + 360) % 360;
    return { x1: 0, y1: 0, x2: drag.x, y2: -drag.y, label: `${ang}°` };
  }
  if (drag.kind === 'cw' || drag.kind === 'stop') {
    const arm = drag.kind === 'cw' ? drag.arm : cfg.value.transit.stops.find((x) => x.id === drag.stop)?.arm;
    if (!arm || !net.value?.arms[arm]) return null;
    const s = projectOnArm(arm, { x: drag.x, y: drag.y });
    const g = net.value.arms[arm];
    const p = armPoint(g, s, 0);
    const st = cfg.value.transit.stops.find((x) => x.id === drag.stop);
    const label = drag.kind === 'cw' ? `${s.toFixed(1)} м от центра` : `${Math.round(st?.side === 'approach' ? s - g.stopLine : s - g.exitStart)} м`;
    return { x1: drag.wx0, y1: -drag.wy0, x2: p.x, y2: -p.y, label };
  }
  if (!drag.node) return null;
  if (drag.kind === 'conn') return { x1: drag.node.p.x, y1: -drag.node.p.y, x2: drag.x, y2: -drag.y };
  if (drag.kind === 'node' && (vehMode.value || armMode.value) && drag.node.kind !== 'in' && drag.node.kind !== 'out') {
    const g = net.value!.arms[drag.node.arm];
    const s = projectOnArm(drag.node.arm, { x: drag.x, y: drag.y });
    const p = armPoint(g, s, drag.node.kind === 'exit' ? -g.outEdge / 2 : g.inEdge / 2);
    return { x1: drag.node.p.x, y1: -drag.node.p.y, x2: p.x, y2: -p.y, label: `${Math.round(s - (drag.node.kind === 'exit' ? g.exitStart : g.stopLine))} м` };
  }
  return null;
});

// ---------- динамический слой ----------
const NS = 'http://www.w3.org/2000/svg';
const vehPool: SVGGElement[] = [];
const pedPool: SVGGElement[] = [];
const markPool: SVGGElement[] = [];
let lastLampKey = '';

const armColors = computed(() => Object.fromEntries(cfg.value.arms.map((a) => [a.id, a.color])) as Record<string, string>);
const routeNames = computed(() => Object.fromEntries((cfg.value.transit?.routes ?? []).map((r) => [r.id, (r.name.match(/^\S+/)?.[0] ?? r.id).slice(0, 4)])) as Record<string, string>);

function ensureVeh(i: number): SVGGElement {
  let g = vehPool[i];
  if (!g) {
    g = document.createElementNS(NS, 'g');
    const body = document.createElementNS(NS, 'rect');
    body.setAttribute('rx', '0.45');
    const glass = document.createElementNS(NS, 'rect');
    glass.setAttribute('class', 'veh-glass');
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('class', 'veh-label');
    label.setAttribute('text-anchor', 'middle');
    g.appendChild(body);
    g.appendChild(glass);
    g.appendChild(label);
    dynVeh.value!.appendChild(g);
    vehPool[i] = g;
  }
  return g;
}

function ensurePed(i: number): SVGGElement {
  let g = pedPool[i];
  if (!g) {
    g = document.createElementNS(NS, 'g');
    for (let k = 0; k < 4; k++) g.appendChild(document.createElementNS(NS, 'circle'));
    dynPed.value!.appendChild(g);
    pedPool[i] = g;
  }
  return g;
}

function ensureMark(i: number): SVGGElement {
  let g = markPool[i];
  if (!g) {
    g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'err-mark');
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('r', '1.6');
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('y', '0.75');
    t.textContent = '!';
    g.appendChild(c);
    g.appendChild(t);
    dynMarks.value!.appendChild(g);
    markPool[i] = g;
  }
  return g;
}

function render(alpha: number) {
  if (!live.value) return;
  const sim = simRef.value;
  if (!sim || !dynVeh.value) return;
  const st = sim.st;
  let i = 0, m = 0;
  const flashOn = Math.floor(st.t * 2) % 2 === 0;
  const colors = armColors.value;
  const deadlocked = new Set(st.status.deadlock?.vids ?? []);
  for (const v of st.vehicles) {
    const g = ensureVeh(i++);
    const x = v.px + (v.x - v.px) * alpha;
    const y = v.py + (v.y - v.py) * alpha;
    let dh = v.h - v.ph;
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    const h = v.ph + dh * alpha;
    g.setAttribute('transform', `translate(${x.toFixed(2)},${(-y).toFixed(2)}) rotate(${(-h * 180 / Math.PI).toFixed(1)})`);
    g.setAttribute('data-vid', String(v.id));
    const body = g.childNodes[0] as SVGRectElement;
    const glass = g.childNodes[1] as SVGRectElement;
    const label = g.childNodes[2] as SVGTextElement;
    body.setAttribute('x', (-v.len / 2).toFixed(2));
    body.setAttribute('y', (-v.wid / 2).toFixed(2));
    body.setAttribute('width', v.len.toFixed(2));
    body.setAttribute('height', v.wid.toFixed(2));
    const big = v.kind === 'truck' || v.kind === 'bus';
    glass.setAttribute('x', (v.len / 2 - (big ? 1.6 : 1.9)).toFixed(2));
    glass.setAttribute('y', (-v.wid / 2 + 0.25).toFixed(2));
    glass.setAttribute('width', big ? '0.9' : '1.1');
    glass.setAttribute('height', (v.wid - 0.5).toFixed(2));
    label.textContent = v.route ? routeNames.value[v.route] ?? '' : '';
    if (v.route) label.setAttribute('transform', Math.cos(h) < -0.05 ? 'rotate(180)' : '');
    let cls = 'veh';
    if (v.crashed) cls += ' crashed';
    else if (v.error) cls += ' wrong';
    else if (deadlocked.has(v.id)) cls += ' locked';
    else if (st.t - v.danger < 2) cls += ' danger';
    if (v.id === app.highlightVid) cls += ' hl';
    if (big) cls += ' big';
    if (v.route) cls += ' route';
    if (v.risky && (v.illegal || v.overStop || v.solidCross)) cls += ' violator';
    g.setAttribute('class', cls);
    body.setAttribute('fill', v.error || v.crashed ? '#e5484d' : v.route ? '#f4f1e6' : colors[v.origin] ?? '#9aa3b2');
    g.style.display = '';
    if (v.error || v.crashed) {
      const mk = ensureMark(m++);
      mk.setAttribute('transform', `translate(${x.toFixed(2)},${(-y - 3.2).toFixed(2)})`);
      mk.setAttribute('data-vid', String(v.id));
      mk.style.display = '';
      (mk.lastChild as SVGTextElement).textContent = v.crashed ? '✕' : '!';
    }
  }
  let pi = 0;
  for (const p of st.peds) {
    const g = ensurePed(pi++);
    const x = p.px + (p.x - p.px) * alpha, y = p.py + (p.y - p.py) * alpha;
    const nx = -Math.sin(p.h), ny = Math.cos(p.h);
    const offs = pedOffsets(p.id, p.size);
    let cls = 'ped';
    if (p.hit) cls += ' hit';
    else if (st.t - p.danger < 2) cls += ' danger';
    else if (p.waiting) cls += ' waiting';
    g.setAttribute('class', cls);
    g.setAttribute('data-pid', String(p.id));
    g.style.display = '';
    for (let k = 0; k < 4; k++) {
      const c = g.childNodes[k] as SVGCircleElement;
      if (k >= offs.length) { c.style.display = 'none'; continue; }
      c.style.display = '';
      c.setAttribute('cx', (x + nx * offs[k].lat).toFixed(2));
      c.setAttribute('cy', (-(y + ny * offs[k].lat)).toFixed(2));
      c.setAttribute('r', String(offs[k].r));
    }
    if (p.hit) {
      const mk = ensureMark(m++);
      mk.setAttribute('transform', `translate(${x.toFixed(2)},${(-y - 2.6).toFixed(2)})`);
      mk.removeAttribute('data-vid');
      mk.style.display = '';
      (mk.lastChild as SVGTextElement).textContent = '✕';
    }
  }
  for (let k = i; k < vehPool.length; k++) vehPool[k].style.display = 'none';
  for (let k = pi; k < pedPool.length; k++) pedPool[k].style.display = 'none';
  for (let k = m; k < markPool.length; k++) markPool[k].style.display = 'none';
  // светофоры, яркость рёбер и текущие точки конфликтов
  const key = st.lampSig + (flashOn ? '1' : '0') + app.conflictMode + app.version;
  if (key !== lastLampKey && svgEl.value) {
    lastLampKey = key;
    const root = svgEl.value;
    for (const g of sim.cfg.signals.groups) {
      const l = st.lamps[g.id] ?? 'R';
      const shown = l === 'FG' ? (flashOn ? 'G' : 'OFF') : l;
      root.querySelectorAll(`[data-group="${CSS.escape(g.id)}"]`).forEach((el) => el.setAttribute('data-lamp', shown));
    }
    root.querySelectorAll('[data-conn]').forEach((el) => {
      const ci = sim.net.connById.get(el.getAttribute('data-conn')!);
      el.classList.toggle('on', ci !== undefined && sim.permit[ci] !== 'none');
    });
    root.querySelectorAll('[data-pededge]').forEach((el) => {
      const ei = sim.net.pedEdgeById.get(el.getAttribute('data-pededge')!);
      const s = ei === undefined ? 'stop' : sim.pedSignal(ei);
      el.classList.toggle('on', s === 'start' || s === 'go' || s === 'free');
    });
    if (app.conflictMode === 'current') {
      root.querySelectorAll('[data-conflict]').forEach((el) => {
        const a = Number(el.getAttribute('data-ca')), b = Number(el.getAttribute('data-cb'));
        (el as SVGElement).style.display = sim.permit[a] !== 'none' && sim.permit[b] !== 'none' ? '' : 'none';
      });
    }
  }
}

let off: (() => void) | undefined;
let ro: ResizeObserver | undefined;
onMounted(() => {
  resize();
  fit();
  ro = new ResizeObserver(resize);
  if (wrap.value) ro.observe(wrap.value);
  off = onRender(render);
  requestRender();
});
onBeforeUnmount(() => { off?.(); ro?.disconnect(); });
watch(() => app.version, () => { lastLampKey = ''; requestRender(); });
watch(() => [app.highlightVid, app.conflictMode, app.showGraph], () => { lastLampKey = ''; requestRender(); });
watch(() => cfg.value.arms.map((a) => a.id + a.angle).join(), () => setTimeout(() => fit(), 350));

const selected = C.selected;
const selConn = computed(() => (selected.value?.kind === 'conn' ? selected.value.id : ''));
const selArm = computed(() => (selected.value && 'arm' in selected.value ? selected.value.arm : null));
const selPedNode = computed(() => (selected.value?.kind === 'pednode' ? selected.value.id : ''));
const selPedEdge = computed(() => (selected.value?.kind === 'pededge' ? selected.value.id : ''));
const selStop = computed(() => (selected.value?.kind === 'stop' ? selected.value.id : ''));
const armName = (d: ArmId) => cfg.value.arms.find((a) => a.id === d)?.short ?? d;
const armLabels = computed(() => {
  const n = net.value;
  if (!n) return [];
  return n.order.map((d) => {
    const g = n.arms[d];
    const vertical = Math.abs(g.u.y) > 0.7;
    const p = armPoint(g, g.stopLine + (vertical ? 16 : 52), -g.outEdge - (vertical ? 2.5 : 3));
    const anchor = vertical ? (g.rOut.x > 0 ? 'start' : 'end') : 'middle';
    return { d, x: p.x, y: -p.y, text: armCfg(d)?.name ?? d, anchor };
  });
});
const HW = HEAD.w / 2, HH = HEAD.h / 2;
function toggleLayer(l: 'veh' | 'ped') {
  if (app.editMode && app.editLayer === l) app.editMode = false;
  else { app.editLayer = l; app.editMode = true; }
}
function cycleConflicts() {
  app.conflictMode = app.conflictMode === 'off' ? 'all' : app.conflictMode === 'all' ? 'current' : 'off';
}
const conflictTitle = computed(() => ({ off: 'Точки конфликтов: показать все', all: 'Точки конфликтов: все. Нажмите, чтобы оставить возможные при текущих сигналах', current: 'Точки конфликтов: возможные при текущих сигналах. Нажмите, чтобы скрыть' }[app.conflictMode]));
defineExpose({ svgEl, fit });
</script>

<template>
  <div ref="wrap" class="map-wrap">
    <svg
      ref="svgEl"
      class="map"
      :viewBox="viewBox"
      preserveAspectRatio="xMidYMid meet"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="onDblClick"
      @wheel="onWheel"
    >
      <rect class="land" :x="view.cx - 3000" :y="-view.cy - 3000" width="6000" height="6000" />
      <g v-if="basemapMarkup" class="basemap" v-html="basemapMarkup" />
      <template v-if="stat">
        <path class="sidewalk" :d="stat.road" />
        <path class="road" :d="stat.road" />
        <path v-for="(d, i) in stat.medians" :key="'m' + i" class="median" :d="d" />
        <path v-for="(l, i) in stat.lines" :key="'l' + i" class="mark" :class="{ dashed: l.dashed }" :d="l.d" :stroke-width="l.width" />
        <path v-for="(d, i) in stat.stopLines" :key="'s' + i" class="stopline" :d="d" />
        <path v-for="z in stat.zebras" :key="'z' + z.edge" class="zebra" :class="{ diagonal: z.diagonal }" :d="z.stripes" />
        <g v-for="(a, i) in stat.arrows" :key="'a' + i" class="lane-arrow">
          <path :d="a.d" />
          <path :d="a.heads" class="head" />
        </g>
      </template>
      <g class="bus-stops">
        <g v-for="s in stops" :key="s.id" :data-stop="s.id" class="bus-stop" :class="{ sel: s.id === selStop }">
          <rect :transform="`translate(${s.x},${s.y}) rotate(${s.h})`" x="-6" y="-1.4" width="12" height="2.8" rx="0.6" class="stop-pad" :class="{ bay: s.bay }" />
          <g :transform="`translate(${s.sx},${s.sy})`">
            <circle r="1.25" class="stop-sign" />
            <text y="0.5" text-anchor="middle" class="stop-letter">А</text>
          </g>
          <title>{{ s.name }}</title>
        </g>
      </g>
      <text v-for="l in armLabels" :key="'lbl' + l.d" class="arm-label" :x="l.x" :y="l.y" :text-anchor="l.anchor" :font-size="Math.max(1.6, scale * 11)">{{ l.text }}</text>

      <g class="conns" :class="{ edit: vehMode, shown: graphOn, live }">
        <g v-for="c in connPaths" :key="c.idx" :data-conn="c.id" :class="{ sel: c.id === selConn, bus: c.bus, alt: c.alt }">
          <path :d="c.d" class="conn-hit" />
          <path :d="c.d" class="conn-line" :stroke="c.color" />
        </g>
      </g>
      <g class="ped-graph" :class="{ edit: pedMode, shown: graphOn, live }">
        <g v-for="e in pedGraph.edges" :key="e.id" :data-pededge="e.id" :class="[e.kind, { sel: e.id === selPedEdge, unsignalled: !e.signalled }]">
          <path :d="e.d" class="ped-hit" />
          <path :d="e.d" class="ped-line" />
        </g>
      </g>
      <g v-if="app.conflictMode !== 'off' || C.isEditor.value" class="conflicts" :class="app.conflictMode">
        <circle v-for="c in conflictPts" :key="'c' + c.id" :data-conflict="c.id" :data-ca="c.a" :data-cb="c.b" :cx="c.x" :cy="c.y" r="0.8" :class="c.kind" />
      </g>

      <g v-if="live" ref="dynPed" class="dyn-ped" />
      <g v-if="live" ref="dynVeh" class="dyn-veh" />
      <g v-if="live" ref="dynMarks" class="dyn-marks" />

      <g class="heads">
        <g v-for="h in heads" :key="h.key" :data-group="h.group" :transform="`translate(${h.x},${h.y})`" class="head" :class="[h.kind, { sel: selected?.kind === 'group' && selected.id === h.group }]" data-lamp="R">
          <title>{{ h.name }}</title>
          <template v-if="h.kind === 'pedestrian'">
            <rect :x="-HEAD.pw / 2" :y="-HEAD.ph / 2" :width="HEAD.pw" :height="HEAD.ph" rx="0.35" class="housing" />
            <circle cy="-0.72" r="0.55" class="lamp lamp-pr" />
            <circle cy="0.72" r="0.55" class="lamp lamp-pg" />
          </template>
          <template v-else-if="h.kind === 'arrow'">
            <rect :x="-HEAD.aw / 2" :y="-HEAD.aw / 2" :width="HEAD.aw" :height="HEAD.aw" rx="0.45" class="housing" />
            <circle r="0.68" class="lamp lamp-arrow" />
            <path :d="arrowLampPath(h.arrow ?? 'straight')" class="arrow-glyph" />
            <rect :x="-HEAD.aw / 2" :y="HEAD.aw / 2 + 0.15" :width="HEAD.aw" height="0.3" :fill="h.color" />
          </template>
          <template v-else>
            <rect :x="-HW" :y="-HH" :width="HEAD.w" :height="HEAD.h" rx="0.6" class="housing" />
            <circle cy="-1.8" r="0.65" class="lamp lamp-r" />
            <circle cy="0" r="0.65" class="lamp lamp-y" />
            <circle cy="1.8" r="0.65" class="lamp lamp-g" />
            <rect :x="-HW" :y="HH + 0.2" :width="HEAD.w" height="0.35" :fill="h.color" />
          </template>
        </g>
      </g>

      <g v-show="!pedMode" class="nodes" :class="{ edit: vehMode || armMode }">
        <g v-for="n in nodes" :key="n.key" :data-node="n.key" :class="['node', n.kind, { sel: selArm === n.arm && (n.kind === 'spawn' && selected?.kind === 'spawner' || n.kind === 'lanes' && selected?.kind === 'lanes' || n.kind === 'exit' && selected?.kind === 'exit') }]" :transform="`translate(${n.p.x},${-n.p.y})`">
          <template v-if="n.kind === 'in' || n.kind === 'out'">
            <circle :r="nodeR" />
            <text :font-size="nodeR * 1.15" text-anchor="middle" :y="nodeR * 0.4">{{ n.lane }}</text>
          </template>
          <template v-else>
            <rect :x="-nodeR * 1.5" :y="-nodeR * 1.5" :width="nodeR * 3" :height="nodeR * 3" :rx="nodeR * 0.7" />
            <text :font-size="nodeR * 1.5" text-anchor="middle" :y="nodeR * 0.55">{{ n.kind === 'spawn' ? '+' : n.kind === 'lanes' ? '⇄' : '→' }}</text>
            <title>{{ n.kind === 'spawn' ? 'Появление машин' : n.kind === 'lanes' ? 'Точка перестроения' : 'Выезд' }} — {{ armName(n.arm) }}</title>
          </template>
        </g>
      </g>
      <g v-if="pedMode" class="ped-nodes">
        <g v-for="n in pedGraph.nodes" :key="n.id" :data-pednode="n.id" :class="['ped-node', n.kind, { sel: n.id === selPedNode, source: n.source }]" :transform="`translate(${n.x},${n.y})`">
          <circle :r="nodeR * 1.15" />
          <text :font-size="nodeR * 1.05" text-anchor="middle" :y="nodeR * 0.38">{{ n.kind === 'island' ? '◇' : n.kind === 'point' ? '•' : '🚶' }}</text>
          <text class="ped-node-label" :font-size="nodeR * 0.95" :y="-nodeR * 1.6" text-anchor="middle">{{ n.label }}</text>
          <title>{{ n.label }}, {{ n.id }}</title>
        </g>
      </g>
      <g v-if="armMode" class="arm-handles">
        <g v-for="h in armHandles" :key="h.id">
          <line x1="0" y1="0" :x2="h.ex" :y2="h.ey" class="arm-axis" />
          <g :data-armh="h.id" :transform="`translate(${h.ex},${h.ey})`" class="arm-handle"><circle :r="nodeR * 1.4" /><text :font-size="nodeR * 1.1" text-anchor="middle" :y="nodeR * 0.4">⟳</text><title>Потяните, чтобы повернуть подход {{ armName(h.id) }}: сейчас {{ h.angle }}°</title></g>
          <g :data-cwh="h.id" :transform="`translate(${h.cx},${h.cy})`" class="cw-handle"><rect :x="-nodeR" :y="-nodeR" :width="nodeR * 2" :height="nodeR * 2" :rx="nodeR * 0.3" /><text :font-size="nodeR" text-anchor="middle" :y="nodeR * 0.35">≡</text><title>Потяните вдоль дороги, чтобы сдвинуть переход</title></g>
        </g>
      </g>
      <g v-if="dragPreview" class="drag-preview">
        <line :x1="dragPreview.x1" :y1="dragPreview.y1" :x2="dragPreview.x2" :y2="dragPreview.y2" />
        <text v-if="'label' in dragPreview" :x="dragPreview.x2" :y="dragPreview.y2 - 2" :font-size="scale * 13" text-anchor="middle">{{ dragPreview.label }}</text>
      </g>
    </svg>
    <div class="map-legend">
      <template v-if="pedMode">Потяните от узла к узлу, чтобы добавить переход. От узла в пустое место — перенести узел. Двойной щелчок добавляет точку.</template>
      <template v-else-if="vehMode">Потяните от залитой вершины въезда к вершине-контуру выезда, чтобы разрешить направление.</template>
      <template v-else-if="armMode">⟳ поворачивает подход, ≡ сдвигает переход, узлы ＋ ⇄ → двигаются вдоль дороги.</template>
      <template v-else-if="stopMode">Перетащите остановку вдоль дороги, нажмите на неё, чтобы изменить свойства.</template>
    </div>
    <div v-if="basemapMarkup" class="map-attribution">{{ OSM_ATTRIBUTION }}</div>
    <div class="map-tools">
      <button title="Приблизить" @click="zoom(0.8)">＋</button>
      <button title="Отдалить" @click="zoom(1.25)">－</button>
      <button title="К перекрёстку" @click="fit()">⌖</button>
      <button title="Вся модель" @click="fit(true)">⤢</button>
      <template v-if="live">
        <button :class="{ on: vehMode }" title="Правка связей полос" @click="toggleLayer('veh')">✎</button>
        <button :class="{ on: pedMode }" title="Правка пешеходного графа" @click="toggleLayer('ped')">🚶</button>
        <button :class="{ on: app.showGraph }" title="Показывать граф: ярко — разрешено сейчас, тускло — запрещено" @click="app.showGraph = !app.showGraph">⋔</button>
      </template>
      <button :class="{ on: app.conflictMode !== 'off', half: app.conflictMode === 'current' }" :title="conflictTitle" @click="cycleConflicts">{{ app.conflictMode === 'current' ? '◎' : '✕' }}</button>
      <button v-if="cfg.basemap" :class="{ on: app.showBasemap }" title="Подложка OpenStreetMap" @click="app.showBasemap = !app.showBasemap">🗺</button>
      <button :class="{ on: helpOpen }" title="Что означают значки" aria-label="Что означают значки" @click="helpOpen = !helpOpen">?</button>
    </div>
    <div v-if="helpOpen" class="map-help" role="dialog" aria-label="Значки карты" @click="helpOpen = false">
      <table>
        <tr><td>＋ －</td><td>приблизить и отдалить, также колесом мыши или двумя пальцами</td></tr>
        <tr><td>⌖</td><td>показать перекрёсток</td></tr>
        <tr><td>⤢</td><td>показать всю модель</td></tr>
        <tr v-if="live"><td>✎</td><td>правка связей полос: потяните от вершины въезда к вершине выезда</td></tr>
        <tr v-if="live"><td>🚶</td><td>правка пешеходного графа</td></tr>
        <tr v-if="live"><td>⋔</td><td>показать граф: ярко — разрешено сейчас, тускло — запрещено</td></tr>
        <tr><td>✕ ◎</td><td>точки конфликтов: все или только возможные при текущих сигналах</td></tr>
        <tr v-if="cfg.basemap"><td>🗺</td><td>подложка OpenStreetMap</td></tr>
        <tr><td></td><td>Нажмите на машину, светофор или узел, чтобы увидеть его свойства.</td></tr>
      </table>
    </div>
  </div>
</template>
