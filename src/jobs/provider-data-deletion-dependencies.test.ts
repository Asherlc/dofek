import { describe, expect, it, vi } from "vitest";
import { markProviderDataDeletionCompleted } from "../db/provider-data-deletion.ts";
import { createProviderDataDeletionDependencies } from "./provider-data-deletion-dependencies.ts";
import type { ProviderDataDeletionContinuationJobData } from "./queues.ts";
import {
  enqueueProviderDataDeletionContinuation,
  enqueueProviderDeleteAnalyticsRefresh,
  getProviderDataDeletionQueue,
} from "./queues.ts";

vi.mock("../db/provider-data-deletion.ts", () => ({
  markProviderDataDeletionCompleted: vi.fn(async () => undefined),
}));

vi.mock("./queues.ts", () => ({
  enqueueProviderDataDeletionContinuation: vi.fn(async () => undefined),
  enqueueProviderDeleteAnalyticsRefresh: vi.fn(async () => undefined),
  getProviderDataDeletionQueue: vi.fn(() => ({ name: "provider-data-deletion" })),
}));

describe("createProviderDataDeletionDependencies", () => {
  it("binds the durable database, ClickHouse client, and canonical queues", async () => {
    const database = { execute: vi.fn(async () => []) };
    const clickHouseClient = {
      command: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ json: async () => [] })),
    };
    const continuation = {
      type: "provider-data-deletion",
      eventId: "30000000-0000-4000-8000-000000000003",
      generation: 2,
      providerId: "garmin",
      userId: "00000000-0000-4000-8000-000000000004",
      checkpoint: {
        batches: 1,
        deletedRows: 1_000,
        examinedRows: 1_000,
        lastGeneration: 1,
        lastId: "10000000-0000-4000-8000-000000000001",
      },
    } satisfies ProviderDataDeletionContinuationJobData;
    const accountErasureAllowsWork = vi.fn(async () => true);

    const dependencies = createProviderDataDeletionDependencies(
      database,
      clickHouseClient,
      accountErasureAllowsWork,
    );
    await dependencies.enqueueContinuation(continuation);
    await dependencies.markCompleted(continuation.eventId);

    const queue = vi.mocked(getProviderDataDeletionQueue).mock.results[0]?.value;
    expect(enqueueProviderDataDeletionContinuation).toHaveBeenCalledWith(continuation, queue);
    expect(markProviderDataDeletionCompleted).toHaveBeenCalledWith(database, continuation.eventId);
    expect(dependencies.clickHouseClient).toBe(clickHouseClient);
    expect(dependencies.accountErasureAllowsWork).toBe(accountErasureAllowsWork);
    expect(dependencies.enqueueAnalyticsRefresh).toBe(enqueueProviderDeleteAnalyticsRefresh);
  });
});
