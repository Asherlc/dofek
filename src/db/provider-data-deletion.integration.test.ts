import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProviderDataDeletionRequest,
  findProviderDataDeletionRequest,
  getProviderDataGenerations,
  listPendingProviderDataDeletionRequests,
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

  it("excludes pending requests owned by an account being erased", async () => {
    const fencedEventId = randomUUID();
    const visibleEventId = randomUUID();
    await createProviderDataDeletionRequest(context.db, firstUserId, "wahoo", fencedEventId);
    await createProviderDataDeletionRequest(context.db, secondUserId, "wahoo", visibleEventId);
    await context.db.execute(
      sql`INSERT INTO fitness.account_erasure_request (
            id,
            user_id,
            user_hash,
            user_hash_key_id,
            write_fence_hash,
            status_token_hash,
            replay_retained_until,
            completion_deadline
          )
          VALUES (
            ${randomUUID()}::uuid,
            ${firstUserId}::uuid,
            ${"1".repeat(64)},
            'test-key',
            ${"2".repeat(64)},
            ${"3".repeat(64)},
            now() + interval '7 days',
            now() + interval '30 days'
          )`,
    );

    const requests = await listPendingProviderDataDeletionRequests(context.db, 100);

    expect(requests.map((request) => request.eventId)).not.toContain(fencedEventId);
    expect(requests.map((request) => request.eventId)).toContain(visibleEventId);
  });
});
