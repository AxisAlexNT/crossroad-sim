/** Идентичность входного события, независимая от размещения на дороге. */
export interface DemandId { source: string; serial: number }
export interface DemandEvent extends DemandId {
  at: number;
  attributes: ReadonlyArray<string | number | null>;
}

interface ArrivalOrder { id: number; tWanted?: number; demand?: DemandId }

/** При равных правилах сначала проходит раньше прибывший участник. */
export function compareArrivalOrder(a: ArrivalOrder, b: ArrivalOrder): number {
  const ta = Number.isFinite(a.tWanted) ? a.tWanted! : Infinity;
  const tb = Number.isFinite(b.tWanted) ? b.tWanted! : Infinity;
  if (ta !== tb) return ta < tb ? -1 : 1;
  const sa = a.demand?.source ?? '', sb = b.demand?.source ?? '';
  if (sa !== sb) return sa < sb ? -1 : 1;
  const ordinal = (a.demand?.serial ?? a.id) - (b.demand?.serial ?? b.id);
  return ordinal || a.id - b.id;
}
