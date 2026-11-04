import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { markProviderDataDeletionCompleted } from "../db/provider-data-deletion.ts";
import { createMetricStreamProviderGenerationDeletedEvent } from "../metric-stream/events.ts";
import {
  readProviderDeletionAcknowledgement,
  readProviderDeletionSourcePage,
} from "../metric-stream/provider-generation-deletion.ts";
import { createKafkaMetricStreamEventPublisherForRoute } from "../metric-stream/redpanda-producer.ts";
import { createProviderDataDeletionDependencies } from "./provider-data-deletion-dependencies.ts";
import { enqueueProviderDeleteAnalyticsRefresh } from "./queues.ts";

const deleteProviderArtifacts = vi.hoisted(() => vi.fn(async () => undefined));
const publishCommand = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../metric-stream/redpanda-producer.ts", () => ({
  createKafkaMetricStreamEventPublisherForRoute: vi.fn(async () => ({
    publishProviderGenerationDeletion: publishCommand,
  })),
}));
vi.mock("../metric-stream/provider-generation-deletion.ts", () => ({
  readProviderDeletionAcknowledgement: vi.fn(async () => null),
  readProviderDeletionSourcePage: vi.fn(async () => []),
}));

vi.mock("../provider-artifact-storage.ts", () => ({
  createProviderArtifactStorageFromEnv: () => ({ deleteForProvider: deleteProviderArtifacts }),
}));

vi.mock("../db/provider-data-deletion.ts", () => ({
  markProviderDataDeletionCompleted: vi.fn(async () => undefined),
}));

vi.mock("./queues.ts", () => ({
  enqueueProviderDeleteAnalyticsRefresh: vi.fn(async () => undefined),
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
        await writeFile(filePath, "pending FIT original");
      }
      const dependencies = createProviderDataDeletionDependencies(
        { execute: vi.fn(async () => []) },
        {
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

  it("binds the canonical publisher, exact ACK reader and bounded structural source reader", async () => {
    const database = { execute: vi.fn(async () => []) };
    const clickHouseClient = {
      query: vi.fn(async () => ({ json: async () => [] })),
    };
    const command = createMetricStreamProviderGenerationDeletedEvent({
      deletionEventId: "30000000-0000-4000-8000-000000000003",
      userId: "00000000-0000-4000-8000-000000000004",
      providerId: "garmin",
      generation: 2,
      sourceIds: [],
      complete: false,
      previousCommandId: null,
    });
    const data = {
      type: "provider-data-deletion" as const,
      eventId: command.deletionEventId,
      generation: 2,
      providerId: command.providerId,
      userId: command.userId,
    };
    const accountErasureAllowsWork = vi.fn(async () => true);

    const dependencies = createProviderDataDeletionDependencies(
      database,
      clickHouseClient,
      accountErasureAllowsWork,
    );
    await dependencies.publishProviderGenerationDeletion(command);
    await dependencies.readCommandAcknowledgement(command);
    await dependencies.readSourcePage(data);
    await dependencies.markCompleted(command.deletionEventId);
    await dependencies.deleteProviderArtifacts(command.userId, command.providerId);

    expect(createKafkaMetricStreamEventPublisherForRoute).toHaveBeenCalledWith("live");
    expect(publishCommand).toHaveBeenCalledWith(command);
    expect(readProviderDeletionAcknowledgement).toHaveBeenCalledWith(clickHouseClient, command);
    expect(readProviderDeletionSourcePage).toHaveBeenCalledWith(clickHouseClient, data, null, 1000);
    expect(markProviderDataDeletionCompleted).toHaveBeenCalledWith(
      database,
      command.deletionEventId,
    );
    expect(deleteProviderArtifacts).toHaveBeenCalledWith(command.userId, command.providerId);
    expect(dependencies.accountErasureAllowsWork).toBe(accountErasureAllowsWork);
    expect(dependencies.enqueueAnalyticsRefresh).toBe(enqueueProviderDeleteAnalyticsRefresh);
  });
});
