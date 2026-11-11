import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findUniqueProviderActivityByExactIdentity,
  type ProviderActivityExactIdentity,
  upsertProviderActivity,
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

  it("preserves FIT recovery status during ordinary provider upserts", async () => {
    const startedAt = new Date("2026-10-14T10:00:00.000Z");
    const endedAt = new Date("2026-10-14T11:00:00.000Z");
    const externalId = randomUUID();
    const [existing] = await context.db
      .insert(activity)
      .values({
        providerId: "garmin-dump-identity-test",
        externalId,
        canonicalType: "hiking",
        providerType: "hiking",
        modality: null,
        startedAt,
        endedAt,
        raw: { sourceName: "original" },
      })
      .returning({ id: activity.id, userId: activity.userId });
    if (!existing) throw new Error("Expected the FIT summary activity to be inserted");

    await context.db
      .update(activity)
      .set({ fitRecoveryError: "Recovered FIT tail" })
      .where(eq(activity.id, existing.id));
    await upsertProviderActivity(
      context.db,
      {
        providerId: "garmin-dump-identity-test",
        userId: existing.userId,
        externalId,
        activityType: { canonicalType: "hiking", providerType: "hiking", modality: null },
        startedAt,
        endedAt,
        name: "Updated provider activity",
        raw: { sourceName: "updated" },
      },
      { name: "Updated provider activity", raw: { sourceName: "updated" } },
    );

    const [updated] = await context.db
      .select({ fitRecoveryError: activity.fitRecoveryError, raw: activity.raw })
      .from(activity)
      .where(eq(activity.id, existing.id));
    expect(updated?.fitRecoveryError).toBe("Recovered FIT tail");
    expect(updated?.raw).toEqual({ sourceName: "updated" });
  });
});
