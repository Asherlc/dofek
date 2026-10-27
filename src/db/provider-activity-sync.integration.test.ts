import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findUniqueProviderActivityByExactIdentity,
  type ProviderActivityExactIdentity,
} from "./provider-activity-sync.ts";
import { activity } from "./schema/activity.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";

describe("findUniqueProviderActivityByExactIdentity", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "garmin-dump-identity-test", "Garmin Dump Identity Test");
  }, 60_000);

  afterAll(async () => {
    if (context) await context.cleanup();
  });

  it("matches one exact activity and rejects absent or ambiguous identities", async () => {
    const startedAt = new Date("2022-05-17T17:23:08.000Z");
    const endedAt = new Date("2022-05-17T19:03:19.201Z");
    const [summaryActivity] = await context.db
      .insert(activity)
      .values({
        providerId: "garmin-dump-identity-test",
        externalId: "8844120420",
        canonicalType: "hiking",
        providerType: "hiking",
        modality: null,
        startedAt,
        endedAt,
        name: "Tronadora Hiking",
      })
      .returning({ id: activity.id, userId: activity.userId });
    if (!summaryActivity) throw new Error("Expected the Garmin summary fixture to be inserted");

    const identity: ProviderActivityExactIdentity = {
      providerId: "garmin-dump-identity-test",
      userId: summaryActivity.userId,
      canonicalType: "hiking",
      providerType: "hiking",
      modality: null,
      startedAt,
      endedAt,
    };
    await expect(findUniqueProviderActivityByExactIdentity(context.db, identity)).resolves.toEqual({
      id: summaryActivity.id,
    });
    await expect(
      findUniqueProviderActivityByExactIdentity(context.db, {
        ...identity,
        endedAt: new Date("2022-05-17T19:03:19.202Z"),
      }),
    ).resolves.toBe(undefined);

    await context.db.insert(activity).values({
      providerId: identity.providerId,
      userId: identity.userId,
      externalId: "second-exact-identity",
      canonicalType: identity.canonicalType,
      providerType: "hiking",
      modality: null,
      startedAt,
      endedAt,
    });
    await expect(findUniqueProviderActivityByExactIdentity(context.db, identity)).resolves.toBe(
      undefined,
    );
  });
});
