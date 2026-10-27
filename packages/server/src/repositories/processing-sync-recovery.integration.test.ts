import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { getRedisConnection, type SyncJobData } from "../../../../src/jobs/queues.ts";
import { SyncProcessingOperation } from "../../../../src/jobs/sync-processing-operation.ts";
import { ProcessingRepository } from "./processing-repository.ts";

const userId = "30000000-0000-4000-8000-000000000001";
const provider = { id: "withings", processingDatasetKeys: ["sleep", "body"] as const };

describe("sync processing operation integration", () => {
  let testContext: TestContext;
  let queue: Queue<SyncJobData>;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}::uuid, 'Sync Processing Test User')
    `);
    queue = new Queue(`test-sync-processing-${randomUUID()}`, {
      connection: getRedisConnection(),
    });
  }, 120_000);

  afterAll(async () => {
    try {
      if (queue) await queue.obliterate({ force: true });
    } finally {
      await queue?.close();
      await testContext?.cleanup();
    }
  });

  it("clears a failed-sync alert after a successful new job reuses the queue ID", async () => {
    const repository = new ProcessingRepository(testContext.db, userId);
    const timestamp = Date.now();
    const jobData: SyncJobData = {
      providerId: provider.id,
      userId,
      origin: "scheduled",
      sinceDays: 1,
    };
    const jobId = "reused-withings-sync-request";
    const firstJob = await queue.add("sync", jobData, { jobId, timestamp });
    const firstOperation = await SyncProcessingOperation.start(firstJob, testContext.db, provider);
    await firstOperation.recordOutputs(0);
    await firstOperation.finish();
    await expect(repository.alerts()).resolves.toMatchObject({ alerts: [] });
    await firstJob.remove();

    const failedJob = await queue.add("sync", jobData, {
      jobId,
      timestamp: timestamp + 30 * 60_000,
    });
    const failedOperation = await SyncProcessingOperation.start(
      failedJob,
      testContext.db,
      provider,
    );
    await failedOperation.finish({
      errorCode: "provider_sync_failed",
      errorMessage: "Withings could not be synced. Try the sync again later.",
    });
    await expect(repository.alerts()).resolves.toMatchObject({
      alerts: [{ id: failedOperation.id, providerId: "withings", action: "retry_sync" }],
    });
    await failedJob.remove();

    const recoveredJob = await queue.add("sync", jobData, {
      jobId,
      timestamp: timestamp + 60 * 60_000,
    });
    const recoveredOperation = await SyncProcessingOperation.start(
      recoveredJob,
      testContext.db,
      provider,
    );
    await recoveredOperation.recordOutputs(0);
    await recoveredOperation.finish();

    await expect(repository.status({ providerId: "withings" })).resolves.toMatchObject({
      overallStatus: "ready",
      datasets: expect.arrayContaining([
        expect.objectContaining({ key: "sleep", status: "ready" }),
        expect.objectContaining({ key: "body", status: "ready" }),
      ]),
    });
    await expect(repository.alerts()).resolves.toMatchObject({ alerts: [] });
    expect(new Set([firstOperation.id, failedOperation.id, recoveredOperation.id]).size).toBe(3);

    const retriedJob = await queue.getJob(jobId);
    if (!retriedJob) throw new Error("The recovered sync job was not persisted in Redis");
    const retryOperation = await SyncProcessingOperation.start(
      retriedJob,
      testContext.db,
      provider,
    );
    expect(retryOperation.id).toBe(recoveredOperation.id);

    const continuationJob = await queue.add(
      "sync",
      { ...retriedJob.data },
      { jobId: "withings-sync-continuation", timestamp: timestamp + 90 * 60_000 },
    );
    const continuationOperation = await SyncProcessingOperation.start(
      continuationJob,
      testContext.db,
      provider,
    );
    expect(continuationOperation.id).toBe(recoveredOperation.id);
  });
});
