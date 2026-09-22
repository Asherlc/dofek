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
  "requestedAtIso" | "sinceDays" | "sinceIso" | "untilIso" | "targetRefreshWindow"
>;

export type SyncJobWindowSource = Pick<SyncWindowTriggerInput, "sinceDays" | "untilDate">;

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

export function syncJobDataFromTriggerInput(input: SyncWindowTriggerInput): SyncJobWindowFields {
  const requestedAt = input.now ?? SyncWindow.now();
  const window = syncWindowFromTriggerInput({ ...input, now: requestedAt });
  const fields = syncWindowToJobData(window, input);
  if (fields.targetRefreshWindow?.type !== "days") return fields;
  return { ...fields, requestedAtIso: requestedAt.toISOString() };
}

export function syncRequestedAtFromJobData(data: SyncJobData, fallback = SyncWindow.now()): Date {
  if (data.requestedAtIso === undefined) return fallback;
  const requestedAt = new Date(data.requestedAtIso);
  if (Number.isNaN(requestedAt.getTime())) {
    throw new Error(`Invalid sync job requestedAtIso: ${data.requestedAtIso}`);
  }
  return requestedAt;
}

export function syncWindowFromJobData(
  data: SyncJobData,
  fallbackNow = SyncWindow.now(),
): SyncWindow {
  const now = syncRequestedAtFromJobData(data, fallbackNow);
  if (data.sinceIso && data.untilIso) {
    const window = SyncWindow.fromIsoRange({ sinceIso: data.sinceIso, untilIso: data.untilIso });
    return data.targetRefreshWindow?.type === "full" ? SyncWindow.full(window.until) : window;
  }
  if (data.sinceIso) {
    const since = new Date(data.sinceIso);
    if (Number.isNaN(since.getTime())) {
      throw new Error(`Invalid sync job sinceIso: ${data.sinceIso}`);
    }
    return new SyncWindow({
      since,
      until: now,
      kind: data.targetRefreshWindow?.type === "full" ? "full" : "bounded",
    });
  }
  return syncWindowFromTriggerInput({ sinceDays: data.sinceDays, now });
}

export function syncWindowToJobData(
  window: SyncWindow,
  source: SyncJobWindowSource = {},
): SyncJobWindowFields {
  const { sinceDays, untilDate } = source;
  return {
    sinceDays,
    sinceIso: window.sinceIso,
    untilIso: window.untilIso,
    targetRefreshWindow: targetRefreshWindowFor(window, sinceDays, untilDate !== undefined),
  };
}

function targetRefreshWindowFor(
  window: SyncWindow,
  sinceDays?: number,
  hasFixedEnd = false,
): SyncJobData["targetRefreshWindow"] {
  if (sinceDays != null && !hasFixedEnd) {
    return { type: "days", days: sinceDays };
  }
  if (window.kind === "full") {
    return { type: "full" };
  }
  return {
    type: "range",
    sinceIso: window.sinceIso,
    untilIso: window.untilIso,
  };
}
