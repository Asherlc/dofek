import type { WhoopCycle } from "@dofek/whoop/types";
import { z } from "zod";

const whoopDateSchema = z.iso.date();
const whoopTimestampSchema = z.iso.datetime({ offset: true });

/** Normalize a WHOOP timestamp or date to a safe canonical UTC date. */
export function normalizeWhoopDay(value: Date | string | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }

  const dateResult = whoopDateSchema.safeParse(value);
  if (dateResult.success) return dateResult.data;
  if (!whoopTimestampSchema.safeParse(value).success) return null;

  return new Date(value).toISOString().slice(0, 10);
}

/** Resolve the canonical WHOOP day shared by all metrics from one cycle. */
export function resolveWhoopCycleDay(cycle: WhoopCycle, fallback: Date | string): string {
  for (const cycleDay of cycle.days ?? []) {
    const normalizedCycleDay = normalizeWhoopDay(cycleDay);
    if (normalizedCycleDay) return normalizedCycleDay;
  }

  const recoveryDay = normalizeWhoopDay(cycle.recovery?.created_at);
  if (recoveryDay) return recoveryDay;

  const fallbackDay = normalizeWhoopDay(fallback);
  if (fallbackDay) return fallbackDay;

  throw new Error("WHOOP cycle has no valid date");
}
