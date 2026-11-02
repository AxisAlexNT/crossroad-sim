<script setup lang="ts">
// Пиктограмма фазы: какие направления разрешены (цвет группы), стрелки — пунктиром.
import { computed } from 'vue';
import { useCtx, type Ctx } from './ctx';
import { phasePedEdges, phasePermits } from '../engine/checks';

const props = defineProps<{ phaseIdx: number; size?: number; ctx?: Ctx }>();
const C = useCtx(() => props.ctx);


const data = computed(() => {
  const net = C.net.value;
  const p = C.cfg.value.signals;
  if (!net || !p.phases[props.phaseIdx]) return null;
  const pm = phasePermits(p, net, props.phaseIdx);
  const colorOf = (id: string) => p.groups.find((g) => g.kind === 'vehicle' && g.movements.includes(id))?.color ?? p.groups.find((g) => g.movements.includes(id))?.color ?? '#888';
  const arrowColor = (id: string) => p.groups.find((g) => g.kind === 'arrow' && g.movements.includes(id) && p.phases[props.phaseIdx].green.includes(g.id))?.color;
  const paths = net.conns.filter((c) => !c.illegal).map((c) => {
    const i = c.idx;
    const pts = c.path.pts;
    const d = 'M' + pts.map((q) => `${q.x.toFixed(1)},${(-q.y).toFixed(1)}`).join('L');
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    const ang = Math.atan2(-(last.y - prev.y), last.x - prev.x) * 180 / Math.PI;
    return { d, on: pm[i] !== 'none', arrow: pm[i] === 'arrow', color: pm[i] === 'arrow' ? arrowColor(c.conn.id) ?? colorOf(c.conn.id) : colorOf(c.conn.id), tip: { x: last.x, y: -last.y, ang } };
  });
  const peds = [...phasePedEdges(p, net, props.phaseIdx)].map((ei) => 'M' + net.pedEdges[ei].path.pts.map((q) => `${q.x.toFixed(1)},${(-q.y).toFixed(1)}`).join('L'));
  let R = 34;
  for (const id of net.order) R = Math.max(R, net.arms[id].stopLine + 8);
  return { paths, peds, R };
});
</script>

<template>
  <svg v-if="data" :viewBox="`${-data.R} ${-data.R} ${data.R * 2} ${data.R * 2}`" :width="size ?? 96" :height="size ?? 96" class="picto">
    <rect :x="-data.R" :y="-data.R" :width="data.R * 2" :height="data.R * 2" class="picto-bg" rx="4" />
    <template v-if="data">
      <path v-for="(p, i) in data.paths.filter((x) => !x.on)" :key="'off' + i" :d="p.d" class="picto-off" />
      <g v-for="(p, i) in data.paths.filter((x) => x.on)" :key="'on' + i">
        <path :d="p.d" :stroke="p.color" class="picto-on" :class="{ arrow: p.arrow }" />
        <path :transform="`translate(${p.tip.x},${p.tip.y}) rotate(${p.tip.ang})`" d="M0,0 L-3.4,-1.9 L-3.4,1.9 Z" :fill="p.color" />
      </g>
      <path v-for="(d, i) in data.peds" :key="'p' + i" :d="d" class="picto-ped" />
    </template>
  </svg>
</template>
