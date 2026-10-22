import { markProviderDataDeletionCompleted } from "../db/provider-data-deletion.ts";
import type { Database } from "../db/typed-sql.ts";
import { createProviderArtifactStorageFromEnv } from "../provider-artifact-storage.ts";
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
  const artifacts = createProviderArtifactStorageFromEnv();
  return {
    accountErasureAllowsWork,
    clickHouseClient,
    deleteProviderArtifacts: (userId, providerId) =>
      artifacts.deleteForProvider(userId, providerId),
    enqueueAnalyticsRefresh: enqueueProviderDeleteAnalyticsRefresh,
    enqueueContinuation(data) {
      return enqueueProviderDataDeletionContinuation(data, getProviderDataDeletionQueue());
    },
    markCompleted(eventId) {
      return markProviderDataDeletionCompleted(database, eventId);
    },
  };
}
