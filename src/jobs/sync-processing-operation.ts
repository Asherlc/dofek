import type { Database, SyncDatabase } from "../db/index.ts";
import { createKafkaMetricStreamEventPublisherForRoute } from "../metric-stream/redpanda-producer.ts";
import { metricStreamRouteForSyncJob } from "../metric-stream/routes.ts";
import { currentMetricStreamWriteDatabase } from "../metric-stream/write-fence-context.ts";
import {
  type ProcessingDatasetKey,
  processingDatasetKeysForOutputPath,
  processingDatasetKeysForProvider,
} from "../processing/dataset-contracts.ts";
import {
  createLazyMetricStreamEventPublisher,
  MetricStreamProcessingPublisher,
} from "../processing/metric-stream-processing-publisher.ts";
import {
  appendProcessingStageEvent,
  createProcessingOperation,
  getProcessingOutputManifest,
  recordMetricStreamBatchPublished,
  recordMetricStreamBatchPublishedInTransaction,
  recordRelationalCanonicalCommits,
} from "../processing/processing-event-store.ts";
import type { SyncJob } from "./queues.ts";

async function ensureProcessingOperation(
  job: SyncJob,
  db: SyncDatabase,
  provider: { id: string; processingDatasetKeys?: readonly ProcessingDatasetKey[] },
) {
  const datasetKeys = processingDatasetKeysForProvider(provider.id, provider.processingDatasetKeys);
  const existingOperationId = job.data.processingOperationIds?.[provider.id];
  if (existingOperationId) {
    return { id: existingOperationId, datasetKeys };
  }

  const fallbackCorrelationKey = [
    job.data.userId,
    provider.id,
    job.data.sinceIso ?? `days:${job.data.sinceDays ?? "all"}`,
    job.data.untilIso ?? "open",
  ].join(":");
  const operation = await createProcessingOperation(db, {
    userId: job.data.userId,
    providerId: provider.id,
    kind: "provider_sync",
    // Queue IDs are reusable after removal; the creation timestamp identifies this job instance.
    externalCorrelationKey: `${job.id ?? fallbackCorrelationKey}:${job.timestamp}:${provider.id}`,
    datasetKeys: [...datasetKeys],
  });
  const nextData = {
    ...job.data,
    processingOperationIds: {
      ...job.data.processingOperationIds,
      [provider.id]: operation.id,
    },
  };
  await job.updateData(nextData);
  job.data = nextData;
  return { id: operation.id, datasetKeys };
}

function hasTransaction(
  database: SyncDatabase,
): database is SyncDatabase & Pick<Database, "transaction"> {
  return "transaction" in database && typeof database.transaction === "function";
}

export function requireTransactionalSyncDatabase(
  database: SyncDatabase,
): SyncDatabase & Pick<Database, "transaction"> {
  if (!hasTransaction(database)) {
    throw new Error("Processing metric-stream publication requires a transactional database");
  }
  return database;
}

async function recordNoOutputStageSkips(
  database: SyncDatabase,
  operationId: string,
  datasetKeys: readonly ProcessingDatasetKey[],
): Promise<void> {
  for (const datasetKey of datasetKeys) {
    for (const stage of ["analytics", "cache_refresh"] as const) {
      await appendProcessingStageEvent(database, {
        operationId,
        stage,
        status: "skipped",
        datasetKey,
        message: "No new data was emitted for this dataset",
        idempotencyKey: `no-output:${datasetKey}:${stage}`,
      });
    }
  }
}

/** Tracks the output paths and durable ingest lifecycle of one provider sync. */
export class SyncProcessingOperation {
  recordingCanonicalCommit = false;
  readonly #job: SyncJob;
  readonly #db: SyncDatabase;
  readonly id: string;
  readonly datasetKeys: readonly ProcessingDatasetKey[];
  readonly metricStreamPublisher: MetricStreamProcessingPublisher | undefined;
  constructor(
    job: SyncJob,
    db: SyncDatabase,
    id: string,
    datasetKeys: readonly ProcessingDatasetKey[],
    metricStreamPublisher: MetricStreamProcessingPublisher | undefined,
  ) {
    this.#job = job;
    this.#db = db;
    this.id = id;
    this.datasetKeys = datasetKeys;
    this.metricStreamPublisher = metricStreamPublisher;
  }

  static async start(
    job: SyncJob,
    db: SyncDatabase,
    provider: { id: string; processingDatasetKeys?: readonly ProcessingDatasetKey[] },
  ): Promise<SyncProcessingOperation> {
    const processingOperation = await ensureProcessingOperation(job, db, provider);
    await appendProcessingStageEvent(db, {
      operationId: processingOperation.id,
      stage: "ingest",
      status: "queued",
      progressPercentage: 0,
      idempotencyKey: "worker-queued",
    });
    await appendProcessingStageEvent(db, {
      operationId: processingOperation.id,
      stage: "ingest",
      status: "running",
      progressPercentage: 0,
      idempotencyKey: "worker-running",
    });
    const emittedMetricStreamDatasetKeys = processingDatasetKeysForOutputPath(
      processingOperation.datasetKeys,
      "metric_stream",
    );
    const metricStreamPublisher =
      emittedMetricStreamDatasetKeys.length > 0
        ? new MetricStreamProcessingPublisher(
            createLazyMetricStreamEventPublisher(() =>
              createKafkaMetricStreamEventPublisherForRoute(
                metricStreamRouteForSyncJob(job.data.targetRefreshWindow),
              ),
            ),
            {
              operationId: processingOperation.id,
              datasetKeys: emittedMetricStreamDatasetKeys,
              recordPublishedBatch: (batch) => {
                const transaction = currentMetricStreamWriteDatabase();
                return transaction
                  ? recordMetricStreamBatchPublishedInTransaction(transaction, batch)
                  : recordMetricStreamBatchPublished(requireTransactionalSyncDatabase(db), batch);
              },
            },
          )
        : undefined;

    return new SyncProcessingOperation(
      job,
      db,
      processingOperation.id,
      processingOperation.datasetKeys,
      metricStreamPublisher,
    );
  }
  async recordOutputs(recordsSynced: number): Promise<void> {
    const job = this.#job;
    const db = this.#db;
    const emittedRelationalDatasetKeys = processingDatasetKeysForOutputPath(
      this.datasetKeys,
      "relational",
    );
    if (recordsSynced > 0 && emittedRelationalDatasetKeys.length > 0) {
      this.recordingCanonicalCommit = true;
      await recordRelationalCanonicalCommits(requireTransactionalSyncDatabase(db), {
        operationId: this.id,
        datasetKeys: emittedRelationalDatasetKeys,
        idempotencyKey: `worker-relational-commit:${job.id ?? "unidentified-job"}`,
      });
      this.recordingCanonicalCommit = false;
    }
    const outputManifest = await getProcessingOutputManifest(db, this.id);
    const noOutputDatasetKeys = this.datasetKeys.filter(
      (datasetKey) => (outputManifest[datasetKey]?.length ?? 0) === 0,
    );
    if (noOutputDatasetKeys.length > 0) {
      await recordNoOutputStageSkips(db, this.id, noOutputDatasetKeys);
    }
  }

  async finish(failure?: {
    errorCode: "provider_auth_failed" | "provider_sync_failed";
    errorMessage: string;
  }): Promise<void> {
    await appendProcessingStageEvent(this.#db, {
      operationId: this.id,
      stage: "ingest",
      status: failure ? "failed" : "succeeded",
      progressPercentage: 100,
      errorCode: failure?.errorCode,
      errorMessage: failure?.errorMessage,
      idempotencyKey: failure ? "worker-failed" : "worker-succeeded",
    });
  }
}
