// Типы для графиков оптимизации.
export interface PlotPoint {
  /** значения по осям: id оси → число */
  v: Record<string, number | undefined>;
  front: boolean;
  feasible: boolean;
  label: string;
}

export interface PlotAxis {
  id: string;
  label: string;
}
