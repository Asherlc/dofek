import { markProviderDataDeletionCompleted } from "../db/provider-data-deletion.ts";
import type { Database } from "../db/typed-sql.ts";
import type {
  ProviderDataDeletionClickHouseClient,
  ProviderDataDeletionDependencies,
} from "./process-provider-data-deletion-job.ts";
import {
  enqueueProviderDataDeletionContinuation,
  enqueueProviderDeleteAnalyticsRefresh,
  getProviderDataDeletionQueue,
} from "./queues.ts";

export function createProviderDataDeletionDependencies(
  database: Database,
  clickHouseClient: ProviderDataDeletionClickHouseClient,
  accountErasureAllowsWork: ProviderDataDeletionDependencies["accountErasureAllowsWork"],
): ProviderDataDeletionDependencies {
  return {
    accountErasureAllowsWork,
    clickHouseClient,
    enqueueAnalyticsRefresh: enqueueProviderDeleteAnalyticsRefresh,
    enqueueContinuation(data) {
      return enqueueProviderDataDeletionContinuation(data, getProviderDataDeletionQueue());
    },
    markCompleted(eventId) {
      return markProviderDataDeletionCompleted(database, eventId);
    },
  };
}
