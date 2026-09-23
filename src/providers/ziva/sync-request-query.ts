import type { SyncJobData } from "../../jobs/queues.ts";
import { syncRequestedAtFromJobData, syncWindowFromJobData } from "../../jobs/sync-job-window.ts";
import type { SyncApiQuery } from "../../lib/sync-api-query.ts";
import { parseZivaSyncCheckpoint } from "./sync-plan.ts";

export function resolveZivaSyncRequestQuery(jobData: SyncJobData): SyncApiQuery | null {
  const window = syncWindowFromJobData(jobData);
  const checkpoint =
    jobData.checkpoint === undefined ? null : parseZivaSyncCheckpoint(jobData.checkpoint);

  return {
    path: "ziva-diary-chunk",
    filters: {
      checkpoint_end_date: checkpoint?.endDate ?? null,
      next_date: checkpoint?.nextDate ?? null,
      origin: jobData.origin ?? null,
      requested_at_iso:
        jobData.requestedAtIso === undefined
          ? null
          : syncRequestedAtFromJobData(jobData).toISOString(),
      source_account_key: checkpoint?.sourceAccountKey ?? null,
      window_kind: window.kind,
      window_since_iso: window.sinceIso,
      window_until_iso: window.untilIso,
    },
  };
}
