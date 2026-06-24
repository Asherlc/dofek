import type { SyncJobData } from "../../jobs/queues.ts";
import type { SyncApiQuery } from "../../lib/sync-api-query.ts";
import { garminSyncStepToApiQuery } from "./sync-api-query.ts";
import { parseGarminSyncCheckpoint } from "./sync-checkpoint.ts";

export function resolveGarminSyncRequestQuery(jobData: SyncJobData): SyncApiQuery | null {
  const checkpoint = parseGarminSyncCheckpoint(jobData.checkpoint);
  if (checkpoint?.phase === "done") {
    return null;
  }
  if (!checkpoint) {
    return {
      path: "connectapi/activities",
      filters: { start: 0 },
    };
  }

  const step = checkpoint.steps[checkpoint.stepIndex];
  if (!step) return null;
  return garminSyncStepToApiQuery(step);
}
