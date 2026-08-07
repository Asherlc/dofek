import type { SyncJobData } from "../../jobs/queues.ts";
import { syncWindowFromJobData } from "../../jobs/sync-job-window.ts";
import type { SyncApiQuery } from "../../lib/sync-api-query.ts";
import { whoopSyncStepToApiQuery } from "./sync-api-query.ts";
import { parseWhoopSyncCheckpoint } from "./sync-checkpoint.ts";

function whoopSyncWindowFromJobData(jobData: SyncJobData) {
  const window = syncWindowFromJobData(jobData);
  return { since: window.since, windowEnd: window.until };
}

export function resolveWhoopSyncRequestQuery(jobData: SyncJobData): SyncApiQuery | null {
  const windowContext = whoopSyncWindowFromJobData(jobData);
  const checkpoint = parseWhoopSyncCheckpoint(jobData.checkpoint);

  if (!checkpoint) {
    return {
      path: "core-details-bff/v0/cycles/details",
      filters: {
        start: windowContext.since.toISOString(),
        end: windowContext.windowEnd.toISOString(),
        cursorMs: windowContext.since.getTime(),
      },
    };
  }

  if (checkpoint.phase === "bootstrap") {
    if (checkpoint.cycleFetchCursorMs == null) {
      return null;
    }
    return {
      path: "core-details-bff/v0/cycles/details",
      filters: {
        start: windowContext.since.toISOString(),
        end: windowContext.windowEnd.toISOString(),
        cursorMs: checkpoint.cycleFetchCursorMs,
      },
    };
  }

  if (checkpoint.phase === "api") {
    const step = checkpoint.apiSteps[checkpoint.apiStepIndex];
    if (!step) return null;
    return whoopSyncStepToApiQuery(step, windowContext);
  }

  return null;
}
