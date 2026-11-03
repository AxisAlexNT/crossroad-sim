/** Для отображения линий на общей оси времени. Сводные показатели не меняются. */
export function alignChartValues(time: number[], values: number[], axis: number[]): number[] {
  let i = 0;
  return axis.map(t => {
    while (i + 1 < time.length && time[i + 1] <= t) i++;
    if (!time.length || t < time[0] || t > time[time.length - 1]) return NaN;
    if (time[i] === t) return Number.isFinite(values[i]) ? values[i] : NaN;
    const next = i + 1;
    if (next >= time.length || !Number.isFinite(values[i]) || !Number.isFinite(values[next])) return NaN;
    return values[i] + (values[next] - values[i]) * (t - time[i]) / (time[next] - time[i]);
  });
}
