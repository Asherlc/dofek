import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { recordProcessingAnalyticsRun } from "./analytics-processing.ts";
import {
  appendProcessingStageEvent,
  createProcessingOperation,
  getLatestProcessingEvents,
  listProcessingDatasetsAwaitingAnalytics,
  recordProcessingOutput,
} from "./processing-event-store.ts";

describe("analytics processing (integration)", () => {
  const userId = "00000000-0000-4000-8000-000000001856";
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(sql`INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}, 'Analytics Processing User')`);
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  async function createReadyOperation(correlationKey: string) {
    const operation = await createProcessingOperation(testContext.db, {
      userId,
      providerId: "kaya",
      kind: "provider_sync",
      externalCorrelationKey: correlationKey,
      datasetKeys: ["providers"],
    });
    await recordProcessingOutput(testContext.db, {
      operationId: operation.id,
      datasetKey: "providers",
      outputPath: "relational",
    });
    for (const stageEvent of [
      { stage: "ingest", outputPath: null },
      { stage: "canonical_commit", outputPath: "relational" },
      { stage: "cdc", outputPath: "relational" },
    ] as const) {
      await appendProcessingStageEvent(testContext.db, {
        operationId: operation.id,
        datasetKey: "providers",
        status: "succeeded",
        ...stageEvent,
        idempotencyKey: `${operation.id}:${stageEvent.stage}`,
      });
    }
    return operation;
  }

  const modelResults = [
    "provider_metric_stream_daily",
    "provider_change_watermark",
    "provider_stats",
  ].map((name) => ({
    name,
    status: "succeeded" as const,
    errorCode: null,
    message: null,
  }));

  it("persists analytics events for operations that share a dataset", async () => {
    const operations = [
      await createReadyOperation("shared-dataset-1"),
      await createReadyOperation("shared-dataset-2"),
    ];
    const buildSnapshot = await listProcessingDatasetsAwaitingAnalytics(testContext.db);

    await expect(
      recordProcessingAnalyticsRun(testContext.db, {
        pendingDatasets: buildSnapshot,
        runId: "shared-dataset-run",
        modelResults,
      }),
    ).resolves.toEqual({ datasets: 2, failed: 0 });

    for (const operation of operations) {
      await expect(getLatestProcessingEvents(testContext.db, operation.id)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: "analytics",
            datasetKey: "providers",
            modelName: null,
            status: "succeeded",
          }),
          expect.objectContaining({
            stage: "cache_refresh",
            datasetKey: "providers",
            status: "queued",
          }),
        ]),
      );
    }
  });

  it("leaves operations that become ready during a build pending for the next run", async () => {
    await createReadyOperation("before-build");
    const buildSnapshot = await listProcessingDatasetsAwaitingAnalytics(testContext.db);
    const laterOperation = await createReadyOperation("during-build");
    await expect(
      recordProcessingAnalyticsRun(testContext.db, {
        pendingDatasets: buildSnapshot,
        runId: "snapshot-run",
        modelResults,
      }),
    ).resolves.toEqual({ datasets: 1, failed: 0 });
    expect(await listProcessingDatasetsAwaitingAnalytics(testContext.db)).toEqual([
      { operationId: laterOperation.id, datasetKey: "providers" },
    ]);
  });
});
