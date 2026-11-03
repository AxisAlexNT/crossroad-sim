/** Приоритет не отменяет проверку физически свободного пространства. */
import { compareArrivalOrder, type DemandId } from './demand';
export interface PriorityParticipant {
  id: number;
  tWanted?: number;
  demand?: DemandId;
  arm: string;
  left: boolean;
  illegal: boolean;
  clearing: boolean;
  arrow: boolean;
}
export interface PriorityDecision {
  yields: boolean;
  reason: 'illegal' | 'clearing' | 'arrow' | 'opposite-left' | 'right' | 'tie';
}
export function decidePriority(a: PriorityParticipant, b: PriorityParticipant, opposite: Record<string, string | null>, right: Record<string, string | null>): PriorityDecision {
  if (a.illegal !== b.illegal) return { yields: a.illegal, reason: 'illegal' };
  if (a.clearing !== b.clearing) return { yields: b.clearing, reason: 'clearing' };
  if (a.arrow !== b.arrow) return { yields: a.arrow, reason: 'arrow' };
  if (a.left !== b.left && (opposite[a.arm] === b.arm || opposite[b.arm] === a.arm)) return { yields: a.left, reason: 'opposite-left' };
  const ar = right[a.arm] === b.arm, br = right[b.arm] === a.arm;
  if (ar !== br) return { yields: ar, reason: 'right' };
  return { yields: compareArrivalOrder(a, b) > 0, reason: 'tie' };
}
