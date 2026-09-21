import type { SyncJobData } from "../../jobs/queues.ts";
import { syncWindowFromJobData } from "../../jobs/sync-job-window.ts";
import type { SyncApiQuery } from "../../lib/sync-api-query.ts";
import { planZivaSyncChunk } from "./sync-plan.ts";

export function resolveZivaSyncRequestQuery(jobData: SyncJobData): SyncApiQuery | null {
  const window = syncWindowFromJobData(jobData);
  const chunk = planZivaSyncChunk(window, jobData.checkpoint ?? null);
  const nextDate = chunk.dates[0];
  if (!nextDate) return null;

  return {
    path: "get_meals_for_date",
    filters: { start_date: nextDate },
  };
}
