import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { markProviderDataDeletionCompleted } from "../db/provider-data-deletion.ts";
import { createProviderDataDeletionDependencies } from "./provider-data-deletion-dependencies.ts";
import type { ProviderDataDeletionContinuationJobData } from "./queues.ts";
import {
  enqueueProviderDataDeletionContinuation,
  enqueueProviderDeleteAnalyticsRefresh,
  getProviderDataDeletionQueue,
} from "./queues.ts";

const deleteProviderArtifacts = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../provider-artifact-storage.ts", () => ({
  createProviderArtifactStorageFromEnv: () => ({ deleteForProvider: deleteProviderArtifacts }),
}));

vi.mock("../db/provider-data-deletion.ts", () => ({
  markProviderDataDeletionCompleted: vi.fn(async () => undefined),
}));

vi.mock("./queues.ts", () => ({
  enqueueProviderDataDeletionContinuation: vi.fn(async () => undefined),
  enqueueProviderDeleteAnalyticsRefresh: vi.fn(async () => undefined),
  getProviderDataDeletionQueue: vi.fn(() => ({ name: "provider-data-deletion" })),
}));

describe("createProviderDataDeletionDependencies", () => {
  it("erases an owned pending original without queue discovery while preserving other scopes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-staging-deletion-"));
    vi.stubEnv("JOB_FILES_DIR", directory);
    const owned = join(
      directory,
      "provider-fit",
      "user-1",
      "wahoo",
      "a".repeat(64),
      "activity.fit",
    );
    const otherProvider = join(
      directory,
      "provider-fit",
      "user-1",
      "garmin",
      "a".repeat(64),
      "activity.fit",
    );
    const otherUser = join(
      directory,
      "provider-fit",
      "user-2",
      "wahoo",
      "a".repeat(64),
      "activity.fit",
    );
    try {
      for (const filePath of [owned, otherProvider, otherUser]) {
        await mkdir(join(filePath, ".."), { recursive: true });
        await writeFile(filePath, "unarchived FIT original");
      }
      const dependencies = createProviderDataDeletionDependencies(
        { execute: vi.fn(async () => []) },
        {
          command: vi.fn(async () => undefined),
          query: vi.fn(async () => ({ json: async () => [] })),
        },
        async () => true,
      );

      await dependencies.deleteProviderArtifacts("user-1", "wahoo");

      expect(existsSync(owned)).toBe(false);
      expect(existsSync(otherProvider)).toBe(true);
      expect(existsSync(otherUser)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { force: true, recursive: true });
    }
  });

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
    await dependencies.deleteProviderArtifacts(continuation.userId, continuation.providerId);

    const queue = vi.mocked(getProviderDataDeletionQueue).mock.results[0]?.value;
    expect(enqueueProviderDataDeletionContinuation).toHaveBeenCalledWith(continuation, queue);
    expect(markProviderDataDeletionCompleted).toHaveBeenCalledWith(database, continuation.eventId);
    expect(deleteProviderArtifacts).toHaveBeenCalledWith(
      continuation.userId,
      continuation.providerId,
    );
    expect(dependencies.clickHouseClient).toBe(clickHouseClient);
    expect(dependencies.accountErasureAllowsWork).toBe(accountErasureAllowsWork);
    expect(dependencies.enqueueAnalyticsRefresh).toBe(enqueueProviderDeleteAnalyticsRefresh);
  });
});
