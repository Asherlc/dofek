import { SyncWindow } from "../providers/sync-window.ts";
import type { SyncJobData } from "./queues.ts";

export type SyncWindowTriggerInput = {
  sinceDays?: number;
  sinceDate?: string;
  untilDate?: string;
  now?: Date;
};

export type SyncJobWindowFields = Pick<
  SyncJobData,
  "sinceDays" | "sinceIso" | "untilIso" | "targetRefreshWindow"
>;

export function syncWindowFromTriggerInput(input: SyncWindowTriggerInput): SyncWindow {
  if (input.sinceDate && input.untilDate) {
    return SyncWindow.fromDateRange({ sinceDate: input.sinceDate, untilDate: input.untilDate });
  }
  if (input.sinceDate) {
    throw new Error("untilDate is required when sinceDate is set");
  }
  if (input.untilDate && input.sinceDays == null) {
    throw new Error("sinceDate is required when untilDate is set");
  }
  if (input.sinceDays != null) {
    return SyncWindow.lastDays(input.sinceDays, {
      untilDate: input.untilDate,
      now: input.now,
    });
  }
  return SyncWindow.full(input.now);
}

export function syncWindowFromJobData(data: SyncJobData, now = SyncWindow.now()): SyncWindow {
  if (data.sinceIso && data.untilIso) {
    return SyncWindow.fromIsoRange({ sinceIso: data.sinceIso, untilIso: data.untilIso });
  }
  if (data.sinceIso) {
    const since = new Date(data.sinceIso);
    if (Number.isNaN(since.getTime())) {
      throw new Error(`Invalid sync job sinceIso: ${data.sinceIso}`);
    }
    return new SyncWindow({ since: since, until: now });
  }
  return syncWindowFromTriggerInput({ sinceDays: data.sinceDays, now });
}

export function syncWindowToJobData(window: SyncWindow, sinceDays?: number): SyncJobWindowFields {
  return {
    sinceDays,
    sinceIso: window.sinceIso,
    untilIso: window.untilIso,
    targetRefreshWindow: targetRefreshWindowFor(window, sinceDays),
  };
}

function targetRefreshWindowFor(
  window: SyncWindow,
  sinceDays?: number,
): SyncJobData["targetRefreshWindow"] {
  if (sinceDays != null) {
    return { type: "days", days: sinceDays };
  }
  if (window.since.getTime() === 0) {
    return { type: "full" };
  }
  return {
    type: "range",
    sinceIso: window.sinceIso,
    untilIso: window.untilIso,
  };
}
