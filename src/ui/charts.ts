// Наборы графиков по ряду Series симуляции. Очереди строятся по подходам текущей модели.
import type { Series } from '../engine/sim';
import type { ModelConfig } from '../engine/types';

export interface ChartSeries {
  label: string;
  color: string;
  values: number[];
  dash?: boolean;
}

export interface ChartDef {
  id: string;
  title: string;
  yLabel: string;
  series: (s: Series) => ChartSeries[];
}

export function chartsFor(cfg: Pick<ModelConfig, 'arms'>): ChartDef[] {
  const arms = cfg.arms.map((a) => ({ id: a.id, short: a.short, color: a.color }));
  return [
    {
      id: 'wait', title: 'Среднее ожидание за последние 5 минут', yLabel: 'с',
      series: (s) => [{ label: 'машины, с', color: '#f2a33a', values: s.avgWait }, { label: 'пешеходы, с', color: '#b18cff', values: s.pedWait, dash: true }],
    },
    {
      id: 'thr', title: 'Проезды стоп-линий за последние 5 минут в пересчёте на час', yLabel: 'авт/ч',
      series: (s) => [{ label: 'авт/ч', color: '#4f8cff', values: s.throughput }],
    },
    {
      id: 'passed', title: 'Проехало машин с начала прогона', yLabel: 'авт',
      series: (s) => [{ label: 'проехало стоп-линию', color: '#22a387', values: s.passed }, { label: 'в модели сейчас', color: '#9aa3b2', values: s.inSystem, dash: true }],
    },
    {
      id: 'queue', title: 'Очередь: наибольшая по полосам подхода вместе с ожидающими въезда в модель', yLabel: 'авт',
      series: (s) => [
        { label: 'максимум', color: '#e5484d', values: s.maxQueue },
        ...arms.map((a) => ({ label: a.short, color: a.color, values: s.queues[a.id] ?? [], dash: true })),
      ],
    },
    {
      id: 'safety', title: 'Опасные ситуации между машинами с начала прогона', yLabel: 'шт',
      series: (s) => [
        { label: 'опасные моменты', color: '#f2a33a', values: s.dangers },
        { label: 'пересечения траекторий с PET меньше окна', color: '#9aa3b2', values: s.crossings },
        { label: 'столкновения в модели', color: '#e5484d', values: s.collisions },
      ],
    },
    {
      id: 'peds', title: 'Пешеходы', yLabel: 'чел',
      series: (s) => [
        { label: 'на переходах и у переходов', color: '#ffd166', values: s.pedActive },
        { label: 'перешли, накопительно', color: '#22a387', values: s.pedDone, dash: true },
      ],
    },
    {
      id: 'ped-safety', title: 'Опасные ситуации с пешеходами с начала прогона', yLabel: 'шт',
      series: (s) => [
        { label: 'опасные сближения с машинами', color: '#f2a33a', values: s.pedDangers },
        { label: 'наезды в модели', color: '#e5484d', values: s.pedHits },
      ],
    },
    {
      id: 'speed', title: 'Средняя скорость машин в модели', yLabel: 'км/ч',
      series: (s) => [{ label: 'км/ч', color: '#3fc1d9', values: s.meanSpeed }],
    },
    {
      id: 'viol', title: 'Нарушения ПДД и отказ от поворота с начала прогона', yLabel: 'шт',
      series: (s) => [
        { label: 'нарушения ПДД', color: '#e86fb0', values: s.violations },
        { label: 'не успели перестроиться и поехали по разрешённому направлению', color: '#9aa3b2', values: s.missed, dash: true },
      ],
    },
    {
      id: 'errors', title: 'Ошибки выбора полосы с начала прогона', yLabel: 'шт',
      series: (s) => [{ label: 'ошибки', color: '#e5484d', values: s.errors }],
    },
  ];
}
