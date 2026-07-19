import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findProviderDataDeletionRequest,
  getProviderDataGenerations,
  markProviderDataDeletionFailed,
} from "./provider-data-deletion.ts";
import { providerDataDeletionOutbox, providerDataGeneration } from "./schema/events.ts";
import { userProfile } from "./schema/reference.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

const firstUserId = "10000000-0000-4000-8000-000000000001";
const secondUserId = "20000000-0000-4000-8000-000000000001";
const deletionEventId = "30000000-0000-4000-8000-000000000001";

describe("provider data deletion persistence (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.insert(userProfile).values([
      { id: firstUserId, name: "Generation Test User One" },
      { id: secondUserId, name: "Generation Test User Two" },
    ]);
    await context.db.insert(providerDataGeneration).values({
      currentGeneration: 4,
      providerId: "garmin",
      userId: firstUserId,
    });
    await context.db.insert(providerDataDeletionOutbox).values({
      eventId: deletionEventId,
      generation: 5,
      providerId: "garmin",
      status: "dispatched",
      userId: firstUserId,
    });
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("loads existing and default provider generations in one batch", async () => {
    await expect(
      getProviderDataGenerations(context.db, [
        { providerId: "garmin", userId: firstUserId },
        { providerId: "coros", userId: secondUserId },
      ]),
    ).resolves.toEqual({
      generations: expect.arrayContaining([
        { generation: 4, providerId: "garmin", userId: firstUserId },
        { generation: 0, providerId: "coros", userId: secondUserId },
      ]),
      operationRevision: expect.stringMatching(/^[1-9]\d*$/),
    });
  });

  it("loads deletion status only for the owning user and provider", async () => {
    await expect(
      findProviderDataDeletionRequest(context.db, firstUserId, "garmin", deletionEventId),
    ).resolves.toEqual({
      eventId: deletionEventId,
      failureReason: null,
      generation: 5,
      providerId: "garmin",
      status: "dispatched",
      userId: firstUserId,
    });
    await expect(
      findProviderDataDeletionRequest(context.db, secondUserId, "garmin", deletionEventId),
    ).resolves.toBeNull();
  });

  it("persists terminal deletion failures after the queue job is gone", async () => {
    await markProviderDataDeletionFailed(
      context.db,
      deletionEventId,
      "ClickHouse rejected the deletion",
    );

    await expect(
      findProviderDataDeletionRequest(context.db, firstUserId, "garmin", deletionEventId),
    ).resolves.toEqual({
      eventId: deletionEventId,
      failureReason: "ClickHouse rejected the deletion",
      generation: 5,
      providerId: "garmin",
      status: "failed",
      userId: firstUserId,
    });
  });
});
