import type { WhoopCycle } from "@dofek/whoop/types";

/** Resolve the canonical WHOOP day shared by all metrics from one cycle. */
export function resolveWhoopCycleDay(cycle: WhoopCycle, fallback: Date | string): string {
  const cycleDay = cycle.days?.[0];
  if (cycleDay) return cycleDay;

  const timestamp = cycle.recovery?.created_at ?? fallback;
  return new Date(timestamp).toISOString().slice(0, 10);
}
