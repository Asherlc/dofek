import { formatDateYmdInTimeZone, shiftDateYmd } from "@dofek/format/format";
import { getProviderIngestContext } from "../../db/provider-ingest-context.ts";
import type { SyncRun } from "../sync-run.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const ymd = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Exact athlete-local calendar bounds for the date-only wellness feed.
 *
 * Explicit range labels are encoded in UTC by `SyncWindow.fromDateRange` and must be
 * passed through unchanged. A full sync keeps its UTC lower bound (preserving the epoch
 * date) while anchoring its upper bound to the home timezone. A relative window keeps its
 * lookback duration but re-anchors it to the stable `requestedAt` clock, so crossing a UTC
 * day boundary cannot shift the local dates.
 */
export function intervalsIcuLocalDateWindow(run: SyncRun): { oldest: string; newest: string } {
  const timezone = getProviderIngestContext()?.homeTimezone ?? "UTC";
  if (run.window.kind === "full") {
    return {
      oldest: run.window.sinceIso.slice(0, 10),
      newest: formatDateYmdInTimeZone(run.window.until, timezone),
    };
  }
  if (!run.options.relativeWindow) {
    return { oldest: ymd(run.window.since), newest: ymd(run.window.until) };
  }
  if (!run.options.requestedAt) {
    throw new Error("Relative Intervals.icu wellness sync requires a fixed request time");
  }
  const lookbackDays = Math.round(
    (Date.parse(ymd(run.window.until)) - Date.parse(ymd(run.window.since))) / DAY_MS,
  );
  const newest = formatDateYmdInTimeZone(run.options.requestedAt, timezone);
  return { oldest: shiftDateYmd(newest, -lookbackDays), newest };
}
