import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { ProcessingDatasetKey } from "../../../../src/processing/dataset-contracts.ts";
import { appendProcessingStageEvent } from "../../../../src/processing/processing-event-store.ts";
import { ProcessingRepository } from "./processing-repository.ts";

const userId = "20000000-0000-4000-8000-000000000001";
const failedOperationId = "20000000-0000-4000-8000-000000000010";
const readyOperationId = "20000000-0000-4000-8000-000000000011";
const datasetKeys = ["activity", "recovery", "sleep"] satisfies ProcessingDatasetKey[];

describe("ProcessingRepository integration", () => {
  let testContext: TestContext;
  let baseTime: Date;

  const isoAt = (minutesFromBase: number) =>
    new Date(baseTime.getTime() + minutesFromBase * 60_000).toISOString();

  beforeAll(async () => {
    baseTime = new Date(Date.now() - 10 * 60_000);
    testContext = await setupTestDatabase();
    await testContext.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}::uuid, 'Processing Repository Test User')
    `);
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  async function insertOperation(input: {
    operationId: string;
    externalCorrelationKey: string;
    createdAt: string;
  }): Promise<void> {
    await testContext.db.execute(sql`
      INSERT INTO fitness.processing_operation (
        id,
        user_id,
        provider_id,
        kind,
        external_correlation_key,
        dataset_keys,
        created_at
      )
      VALUES (
        ${input.operationId}::uuid,
        ${userId}::uuid,
        'wahoo',
        'provider_sync',
        ${input.externalCorrelationKey},
        ARRAY[${sql.join(
          datasetKeys.map((datasetKey) => sql`${datasetKey}`),
          sql`, `,
        )}]::text[],
        ${input.createdAt}::timestamptz
      )
    `);
  }

  async function appendSucceededStage(input: {
    operationId: string;
    stage: "ingest" | "analytics" | "cache_refresh";
    datasetKey: ProcessingDatasetKey | null;
    occurredAt: string;
    idempotencyKey: string;
  }): Promise<void> {
    await appendProcessingStageEvent(testContext.db, {
      operationId: input.operationId,
      stage: input.stage,
      status: "succeeded",
      datasetKey: input.datasetKey,
      occurredAt: new Date(input.occurredAt),
      idempotencyKey: input.idempotencyKey,
    });
  }

  async function seedFailedOperation(): Promise<void> {
    await insertOperation({
      operationId: failedOperationId,
      externalCorrelationKey: "processing-repository-integration-failed",
      createdAt: isoAt(-9),
    });
    await appendSucceededStage({
      operationId: failedOperationId,
      stage: "ingest",
      datasetKey: null,
      occurredAt: isoAt(-8),
      idempotencyKey: "failed-ingest-succeeded",
    });

    for (const [datasetIndex, datasetKey] of datasetKeys.entries()) {
      await appendProcessingStageEvent(testContext.db, {
        operationId: failedOperationId,
        stage: "analytics",
        status: "failed",
        datasetKey,
        occurredAt: new Date(isoAt(-7 + datasetIndex)),
        errorCode: "analytics_failed",
        errorMessage: `${datasetKey} analytics failed`,
        idempotencyKey: `failed-analytics-${datasetKey}`,
      });
    }
  }

  async function seedReadyOperation(): Promise<void> {
    await insertOperation({
      operationId: readyOperationId,
      externalCorrelationKey: "processing-repository-integration-ready",
      createdAt: isoAt(-4),
    });
    await appendSucceededStage({
      operationId: readyOperationId,
      stage: "ingest",
      datasetKey: null,
      occurredAt: isoAt(-3),
      idempotencyKey: "ready-ingest-succeeded",
    });

    for (const datasetKey of datasetKeys) {
      await appendSucceededStage({
        operationId: readyOperationId,
        stage: "analytics",
        datasetKey,
        occurredAt: isoAt(-2),
        idempotencyKey: `ready-analytics-${datasetKey}`,
      });
      await appendSucceededStage({
        operationId: readyOperationId,
        stage: "cache_refresh",
        datasetKey,
        occurredAt: isoAt(-1),
        idempotencyKey: `ready-cache-refresh-${datasetKey}`,
      });
    }
  }

  it("derives grouped alerts, dismissals, and later ready status from migrated tables", async () => {
    await seedFailedOperation();
    const repository = new ProcessingRepository(testContext.db, userId);

    const failedStatus = await repository.status({ providerId: "wahoo" });

    expect(failedStatus.datasets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "activity",
          status: "failed",
          lastFailedAt: isoAt(-7),
        }),
        expect.objectContaining({
          key: "recovery",
          status: "failed",
          lastFailedAt: isoAt(-6),
        }),
        expect.objectContaining({
          key: "sleep",
          status: "failed",
          lastFailedAt: isoAt(-5),
        }),
      ]),
    );

    await expect(repository.alerts()).resolves.toEqual({
      generatedAt: expect.any(String),
      alerts: [
        expect.objectContaining({
          id: failedOperationId,
          providerId: "wahoo",
          datasetKeys,
          datasetLabels: ["Activities", "Recovery", "Sleep"],
          occurredAt: isoAt(-5),
          action: "retry_sync",
        }),
      ],
    });

    await expect(repository.dismiss(failedOperationId)).resolves.toEqual({ dismissed: true });

    const dismissedStatus = await repository.status({ providerId: "wahoo" });
    expect(dismissedStatus.operations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: failedOperationId, dismissed: true })]),
    );
    await expect(repository.alerts()).resolves.toEqual(expect.objectContaining({ alerts: [] }));

    await seedReadyOperation();
    const readyStatus = await repository.status({ providerId: "wahoo" });

    expect(readyStatus.datasets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "activity",
          status: "ready",
          lastFailedAt: isoAt(-7),
        }),
        expect.objectContaining({
          key: "recovery",
          status: "ready",
          lastFailedAt: isoAt(-6),
        }),
        expect.objectContaining({
          key: "sleep",
          status: "ready",
          lastFailedAt: isoAt(-5),
        }),
      ]),
    );
    await expect(repository.alerts()).resolves.toEqual(expect.objectContaining({ alerts: [] }));
  });
});
