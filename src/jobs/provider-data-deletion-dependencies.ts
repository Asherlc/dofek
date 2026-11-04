import type { ClickHouseClient } from "../db/clickhouse.ts";
import { markProviderDataDeletionCompleted } from "../db/provider-data-deletion.ts";
import type { Database } from "../db/typed-sql.ts";
import {
  readProviderDeletionAcknowledgement,
  readProviderDeletionSourcePage,
} from "../metric-stream/provider-generation-deletion.ts";
import { createKafkaMetricStreamEventPublisherForRoute } from "../metric-stream/redpanda-producer.ts";
import { createProviderArtifactStorageFromEnv } from "../provider-artifact-storage.ts";
import type { ProviderDataDeletionDependencies } from "./process-provider-data-deletion-job.ts";
import { deleteStagedProviderFitFiles } from "./provider-fit-staging.ts";
import { enqueueProviderDeleteAnalyticsRefresh } from "./queues.ts";

export function createProviderDataDeletionDependencies(
  database: Database,
  clickHouseClient: Pick<ClickHouseClient, "query">,
  accountErasureAllowsWork: ProviderDataDeletionDependencies["accountErasureAllowsWork"],
): ProviderDataDeletionDependencies {
  const artifacts = createProviderArtifactStorageFromEnv();
  return {
    accountErasureAllowsWork,
    async publishProviderGenerationDeletion(command) {
      const publisher = await createKafkaMetricStreamEventPublisherForRoute("live");
      await publisher.publishProviderGenerationDeletion(command);
    },
    readCommandAcknowledgement: (command) =>
      readProviderDeletionAcknowledgement(clickHouseClient, command),
    readSourcePage: (data) =>
      readProviderDeletionSourcePage(
        clickHouseClient,
        data,
        data.checkpoint
          ? { generation: data.checkpoint.lastGeneration, id: data.checkpoint.lastId }
          : null,
        1000,
      ),
    deleteProviderArtifacts: async (userId, providerId) => {
      await deleteStagedProviderFitFiles(userId, providerId);
      await artifacts.deleteForProvider(userId, providerId);
    },
    enqueueAnalyticsRefresh: enqueueProviderDeleteAnalyticsRefresh,
    markCompleted(eventId) {
      return markProviderDataDeletionCompleted(database, eventId);
    },
  };
}
