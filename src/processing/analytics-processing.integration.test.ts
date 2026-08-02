import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { recordAnalyticsRunForPendingProcessing } from "./analytics-processing.ts";
import {
  appendProcessingStageEvent,
  createProcessingOperation,
  getLatestProcessingEvents,
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

  it("persists analytics events for operations that share a dataset", async () => {
    const operations = [];
    for (const correlationKey of ["shared-dataset-1", "shared-dataset-2"]) {
      const operation = await createProcessingOperation(testContext.db, {
        userId,
        providerId: "kaya",
        kind: "provider_sync",
        externalCorrelationKey: correlationKey,
        datasetKeys: ["providers"],
      });
      operations.push(operation);
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
    }

    await expect(
      recordAnalyticsRunForPendingProcessing(testContext.db, {
        runId: "shared-dataset-run",
        modelResults: [
          {
            name: "provider_metric_stream_daily",
            status: "succeeded",
            errorCode: null,
            message: null,
          },
          {
            name: "provider_change_watermark",
            status: "succeeded",
            errorCode: null,
            message: null,
          },
          {
            name: "provider_stats",
            status: "succeeded",
            errorCode: null,
            message: null,
          },
        ],
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
});
