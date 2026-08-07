import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileProviderActivityAbsence } from "./provider-activity-absence.ts";
import { activity } from "./schema/activity.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";

describe("reconcileProviderActivityAbsence", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "provider-absence-test", "Provider Absence Test");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("marks activities absent only when missing from an authoritative provider window", async () => {
    await ctx.db.insert(activity).values([
      {
        providerId: "provider-absence-test",
        externalId: "present-activity",
        canonicalType: "running",
        providerType: "running",
        modality: null,
        startedAt: new Date("2026-03-01T10:00:00Z"),
      },
      {
        providerId: "provider-absence-test",
        externalId: "missing-activity",
        canonicalType: "cycling",
        providerType: "cycling",
        modality: null,
        startedAt: new Date("2026-03-02T10:00:00Z"),
      },
      {
        providerId: "provider-absence-test",
        externalId: "outside-window",
        canonicalType: "walking",
        providerType: "walking",
        modality: null,
        startedAt: new Date("2026-02-01T10:00:00Z"),
      },
    ]);

    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "provider-absence-test",
      windowStart: new Date("2026-03-01T00:00:00Z"),
      windowEnd: new Date("2026-03-03T00:00:00Z"),
      presentExternalIds: new Set(["present-activity"]),
    });

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "provider-absence-test"));
    const present = rows.find((row) => row.externalId === "present-activity");
    const missing = rows.find((row) => row.externalId === "missing-activity");
    const outsideWindow = rows.find((row) => row.externalId === "outside-window");

    expect(present?.providerAbsentAt).toBeNull();
    expect(missing?.providerAbsentAt).toBeInstanceOf(Date);
    expect(outsideWindow?.providerAbsentAt).toBeNull();
  });

  it("clears provider absence when the provider returns the activity again", async () => {
    await ctx.db.insert(activity).values({
      providerId: "provider-absence-test",
      externalId: "restored-activity",
      canonicalType: "running",
      providerType: "running",
      modality: null,
      startedAt: new Date("2026-03-04T10:00:00Z"),
      providerAbsentAt: new Date("2026-03-05T00:00:00Z"),
    });

    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "provider-absence-test",
      windowStart: new Date("2026-03-04T00:00:00Z"),
      windowEnd: new Date("2026-03-05T00:00:00Z"),
      presentExternalIds: new Set(["restored-activity"]),
    });

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(
        and(
          eq(activity.providerId, "provider-absence-test"),
          eq(activity.externalId, "restored-activity"),
        ),
      );

    expect(rows[0]?.providerAbsentAt).toBeNull();
  });

  it("does not tombstone activities when the provider list is empty", async () => {
    await ctx.db.insert(activity).values({
      providerId: "provider-absence-test",
      externalId: "empty-list-activity",
      canonicalType: "running",
      providerType: "running",
      modality: null,
      startedAt: new Date("2026-03-06T10:00:00Z"),
    });

    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "provider-absence-test",
      windowStart: new Date("2026-03-06T00:00:00Z"),
      windowEnd: new Date("2026-03-07T00:00:00Z"),
      presentExternalIds: new Set(),
    });

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(
        and(
          eq(activity.providerId, "provider-absence-test"),
          eq(activity.externalId, "empty-list-activity"),
        ),
      );

    expect(rows[0]?.providerAbsentAt).toBeNull();
  });

  it("does not tombstone older apple_health duplicates when the sync identifier is still present", async () => {
    await ensureProvider(ctx.db, "apple_health", "Apple Health");

    await ctx.db.insert(activity).values([
      {
        providerId: "apple_health",
        externalId: "hk:workout:old-strava-uuid",
        canonicalType: "cycling",
        providerType: "cycling",
        modality: null,
        startedAt: new Date("2026-03-06T10:00:00Z"),
        endedAt: new Date("2026-03-06T11:00:00Z"),
        raw: {
          sourceName: "Strava",
          metadata: { HKMetadataKeySyncIdentifier: "19016909441", HKMetadataKeySyncVersion: 1 },
        },
      },
      {
        providerId: "apple_health",
        externalId: "hk:workout:new-strava-uuid",
        canonicalType: "cycling",
        providerType: "cycling",
        modality: null,
        startedAt: new Date("2026-03-06T10:00:00Z"),
        endedAt: new Date("2026-03-06T11:00:00Z"),
        raw: {
          sourceName: "Strava",
          metadata: { HKMetadataKeySyncIdentifier: "19016909441", HKMetadataKeySyncVersion: 2 },
        },
      },
      {
        providerId: "apple_health",
        externalId: "hk:workout:missing-garmin-uuid",
        canonicalType: "running",
        providerType: "running",
        modality: null,
        startedAt: new Date("2026-03-06T12:00:00Z"),
        endedAt: new Date("2026-03-06T13:00:00Z"),
        raw: {
          sourceName: "Garmin",
          metadata: {
            HKMetadataKeySyncIdentifier: "unrelated-sync-id",
            HKMetadataKeySyncVersion: 1,
          },
        },
      },
    ]);

    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "apple_health",
      windowStart: new Date("2026-03-06T00:00:00Z"),
      windowEnd: new Date("2026-03-07T00:00:00Z"),
      presentExternalIds: new Set(["hk:workout:new-strava-uuid"]),
      presentAppleHealthIdentities: [
        {
          syncIdentifier: "19016909441",
          startedAt: new Date("2026-03-06T10:00:00Z"),
          endedAt: new Date("2026-03-06T11:00:00Z"),
          sourceName: "Strava",
        },
      ],
    });

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "apple_health"));

    expect(
      rows
        .filter((row) => row.externalId !== "hk:workout:missing-garmin-uuid")
        .every((row) => row.providerAbsentAt == null),
    ).toBe(true);
    expect(
      rows.find((row) => row.externalId === "hk:workout:missing-garmin-uuid")?.providerAbsentAt,
    ).toBeInstanceOf(Date);
  });
});
