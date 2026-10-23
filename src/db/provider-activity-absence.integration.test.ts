import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  markProviderActivityAbsent,
  markProviderActivityPresent,
  reconcileProviderActivityAbsence,
} from "./provider-activity-absence.ts";
import { activity } from "./schema/activity.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";

describe("reconcileProviderActivityAbsence", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "provider-absence-test", "Provider Absence Test");
    await ensureProvider(ctx.db, "whoop", "WHOOP");
    await ensureProvider(ctx.db, "peloton", "Peloton");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  async function insertWhoopCopy() {
    const originId = randomUUID();
    const externalId = originId.replaceAll("-", "");
    const [copy] = await ctx.db
      .insert(activity)
      .values({
        providerId: "peloton",
        externalId,
        canonicalType: "cardio",
        providerType: "cardio",
        startedAt: new Date("2026-10-22T15:34:00Z"),
        endedAt: new Date("2026-10-22T15:50:58Z"),
        raw: { platform: "whoop", deviceType: "whoop" },
      })
      .returning();
    if (!copy) throw new Error("Missing copy fixture");
    return { copy, originId, externalId };
  }

  const sourceWindow = {
    windowStart: new Date("2026-10-22T00:00:00Z"),
    windowEnd: new Date("2026-10-23T00:00:00Z"),
  };

  it("rejects absence attribution to a provider that does not exist", async () => {
    const { copy } = await insertWhoopCopy();
    await expect(
      ctx.db
        .update(activity)
        .set({ absenceProviderId: randomUUID() })
        .where(eq(activity.id, copy.id)),
    ).rejects.toMatchObject({
      cause: { code: "23503", constraint: "activity_absence_provider_id_provider_id_fk" },
    });
    const [stored] = await ctx.db.select().from(activity).where(eq(activity.id, copy.id));
    expect(stored?.absenceProviderId).toBeNull();
  });

  it("retires an absent origin's copy and restores it only after both providers return it", async () => {
    const { copy, originId, externalId } = await insertWhoopCopy();
    const readCopy = async () =>
      (await ctx.db.select().from(activity).where(eq(activity.id, copy.id)))[0];
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "whoop",
      ...sourceWindow,
      presentExternalIds: new Set([randomUUID()]),
    });
    expect((await readCopy())?.providerAbsentAt).toBeInstanceOf(Date);

    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "peloton",
      ...sourceWindow,
      presentExternalIds: new Set([externalId]),
    });
    expect((await readCopy())?.providerAbsentAt).toBeInstanceOf(Date);

    await ctx.db.insert(activity).values({
      providerId: "whoop",
      externalId: originId,
      canonicalType: "climbing",
      providerType: "rock-climbing",
      startedAt: copy.startedAt,
      endedAt: copy.endedAt,
    });
    // A late origin insert is not authoritative confirmation that it returned.
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "peloton",
      ...sourceWindow,
      presentExternalIds: new Set([externalId]),
    });
    expect((await readCopy())?.providerAbsentAt).toBeInstanceOf(Date);
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "whoop",
      ...sourceWindow,
      presentExternalIds: new Set([originId]),
    });
    // The origin's confirmation does not prove the downstream copy still exists.
    expect((await readCopy())?.providerAbsentAt).toBeInstanceOf(Date);
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "peloton",
      ...sourceWindow,
      presentExternalIds: new Set([externalId]),
    });
    expect((await readCopy())?.providerAbsentAt).toBeNull();
  });

  it("restores a Peloton-only absence without inferring WHOOP deletion from an unimported origin", async () => {
    const { copy, externalId } = await insertWhoopCopy();
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "peloton",
      ...sourceWindow,
      presentExternalIds: new Set([randomUUID()]),
    });
    const [absent] = await ctx.db.select().from(activity).where(eq(activity.id, copy.id));
    expect(absent?.providerAbsentAt).toBeInstanceOf(Date);
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "peloton",
      ...sourceWindow,
      presentExternalIds: new Set([externalId]),
    });
    const [present] = await ctx.db.select().from(activity).where(eq(activity.id, copy.id));
    expect(present?.providerAbsentAt).toBeNull();
  });

  it("upgrades an existing downstream tombstone when WHOOP confirms origin absence", async () => {
    const { copy, externalId } = await insertWhoopCopy();
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "peloton",
      ...sourceWindow,
      presentExternalIds: new Set([randomUUID()]),
    });
    const [initial] = await ctx.db.select().from(activity).where(eq(activity.id, copy.id));
    expect(initial?.absenceProviderId).toBe("peloton");
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "whoop",
      ...sourceWindow,
      presentExternalIds: new Set([randomUUID()]),
    });
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "peloton",
      ...sourceWindow,
      presentExternalIds: new Set([externalId]),
    });
    const [stored] = await ctx.db.select().from(activity).where(eq(activity.id, copy.id));
    expect(stored?.absenceProviderId).toBe("whoop");
    expect(stored?.providerAbsentAt).toEqual(initial?.providerAbsentAt);
  });

  it("preserves origin deletion evidence through downstream delete and present events", async () => {
    const { copy, originId, externalId } = await insertWhoopCopy();
    await markProviderActivityAbsent(ctx.db, { providerId: "whoop", externalId: originId });
    await markProviderActivityAbsent(ctx.db, { providerId: "peloton", externalId });
    await markProviderActivityPresent(ctx.db, { providerId: "peloton", externalId });
    const [stored] = await ctx.db.select().from(activity).where(eq(activity.id, copy.id));
    expect(stored?.providerAbsentAt).toBeInstanceOf(Date);
    expect(stored?.absenceProviderId).toBe("whoop");

    await markProviderActivityPresent(ctx.db, { providerId: "whoop", externalId: originId });
    const [originPresent] = await ctx.db.select().from(activity).where(eq(activity.id, copy.id));
    expect(originPresent?.providerAbsentAt).toBeInstanceOf(Date);
    expect(originPresent?.absenceProviderId).toBe("peloton");
    await markProviderActivityPresent(ctx.db, { providerId: "peloton", externalId });
    const [copyPresent] = await ctx.db.select().from(activity).where(eq(activity.id, copy.id));
    expect(copyPresent?.providerAbsentAt).toBeNull();
  });

  it("propagates an explicit deletion even before the origin row was imported", async () => {
    const { copy, originId } = await insertWhoopCopy();
    await markProviderActivityAbsent(ctx.db, { providerId: "whoop", externalId: originId });
    const [stored] = await ctx.db.select().from(activity).where(eq(activity.id, copy.id));
    expect(stored?.providerAbsentAt).toBeInstanceOf(Date);
    expect(stored?.raw).toEqual({ platform: "whoop", deviceType: "whoop" });
  });

  it("reconciles copies when multiple source rows normalize to the same upstream UUID", async () => {
    const { copy, originId, externalId } = await insertWhoopCopy();
    await ctx.db.insert(activity).values(
      [originId, externalId].map((id) => ({
        providerId: "whoop",
        externalId: id,
        canonicalType: "climbing" as const,
        providerType: "rock-climbing",
        startedAt: copy.startedAt,
        endedAt: copy.endedAt,
        providerAbsentAt: new Date("2026-10-22T16:00:00Z"),
      })),
    );
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "peloton",
      ...sourceWindow,
      presentExternalIds: new Set([externalId]),
    });
    const [stored] = await ctx.db.select().from(activity).where(eq(activity.id, copy.id));
    expect(stored?.providerAbsentAt).toBeInstanceOf(Date);
    expect(stored?.absenceProviderId).toBe("whoop");
  });

  it("keeps a late copy of a tombstoned origin absent during downstream sync and present events", async () => {
    const { copy, originId, externalId } = await insertWhoopCopy();
    await ctx.db.insert(activity).values({
      providerId: "whoop",
      externalId: originId,
      canonicalType: "climbing",
      providerType: "rock-climbing",
      startedAt: copy.startedAt,
      endedAt: copy.endedAt,
      providerAbsentAt: new Date("2026-10-22T16:00:00Z"),
    });
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "peloton",
      ...sourceWindow,
      presentExternalIds: new Set([externalId]),
    });
    await markProviderActivityPresent(ctx.db, { providerId: "peloton", externalId });
    const [stored] = await ctx.db.select().from(activity).where(eq(activity.id, copy.id));
    expect(stored?.providerAbsentAt).toBeInstanceOf(Date);
  });

  it("keeps unrelated Peloton recordings when a coincidentally equal WHOOP identity disappears", async () => {
    const externalId = randomUUID();
    const [native] = await ctx.db
      .insert(activity)
      .values({
        providerId: "peloton",
        externalId: externalId.replaceAll("-", ""),
        canonicalType: "cardio",
        providerType: "cardio",
        startedAt: new Date("2026-10-22T15:34:00Z"),
        raw: { platform: "home_bike", deviceType: "bike" },
      })
      .returning();
    if (!native) throw new Error("Missing native fixture");
    await markProviderActivityAbsent(ctx.db, { providerId: "whoop", externalId });
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "whoop",
      ...sourceWindow,
      presentExternalIds: new Set([randomUUID()]),
    });
    const [stored] = await ctx.db.select().from(activity).where(eq(activity.id, native.id));
    expect(stored?.providerAbsentAt).toBeNull();
  });

  it("keeps copies visible when their origin is present or the authoritative window excludes them", async () => {
    const { copy, originId } = await insertWhoopCopy();
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "whoop",
      ...sourceWindow,
      presentExternalIds: new Set([originId]),
    });
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "whoop",
      windowStart: new Date("2026-10-23T00:00:00Z"),
      windowEnd: new Date("2026-10-24T00:00:00Z"),
      presentExternalIds: new Set([randomUUID()]),
    });
    const [stored] = await ctx.db.select().from(activity).where(eq(activity.id, copy.id));
    expect(stored?.providerAbsentAt).toBeNull();
  });

  it("does not treat an ambiguous empty origin list as evidence of deletion", async () => {
    const { copy } = await insertWhoopCopy();
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "whoop",
      ...sourceWindow,
      presentExternalIds: new Set(),
    });
    const [stored] = await ctx.db.select().from(activity).where(eq(activity.id, copy.id));
    expect(stored?.providerAbsentAt).toBeNull();
  });

  it("accepts a validated authoritative empty origin list as evidence of deletion", async () => {
    const { copy } = await insertWhoopCopy();
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "whoop",
      ...sourceWindow,
      presentExternalIds: new Set(),
      emptyListIsAuthoritative: true,
    });
    const [stored] = await ctx.db.select().from(activity).where(eq(activity.id, copy.id));
    expect(stored?.providerAbsentAt).toBeInstanceOf(Date);
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

  it("reports whether a targeted deletion changed an activity", async () => {
    await ctx.db.insert(activity).values({
      providerId: "provider-absence-test",
      externalId: "targeted-delete-activity",
      canonicalType: "running",
      providerType: "running",
      modality: null,
      startedAt: new Date("2026-03-04T12:00:00Z"),
    });
    const mark = {
      providerId: "provider-absence-test",
      externalId: "targeted-delete-activity",
    };

    expect(await markProviderActivityAbsent(ctx.db, mark)).toBe(1);
    expect(await markProviderActivityAbsent(ctx.db, mark)).toBe(0);

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(
        and(
          eq(activity.providerId, "provider-absence-test"),
          eq(activity.externalId, "targeted-delete-activity"),
        ),
      );
    expect(rows[0]?.providerAbsentAt).toBeInstanceOf(Date);
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

  it("tombstones an explicitly authoritative empty activity window", async () => {
    await ctx.db.insert(activity).values({
      providerId: "provider-absence-test",
      externalId: "authoritative-empty-activity",
      canonicalType: "climbing",
      providerType: "climbing",
      modality: null,
      startedAt: new Date("2026-03-08T10:00:00Z"),
    });
    await reconcileProviderActivityAbsence(ctx.db, {
      providerId: "provider-absence-test",
      windowStart: new Date("2026-03-08T00:00:00Z"),
      windowEnd: new Date("2026-03-09T00:00:00Z"),
      presentExternalIds: new Set(),
      emptyListIsAuthoritative: true,
    });
    const rows = await ctx.db
      .select()
      .from(activity)
      .where(
        and(
          eq(activity.providerId, "provider-absence-test"),
          eq(activity.externalId, "authoritative-empty-activity"),
        ),
      );
    expect(rows).toEqual([expect.objectContaining({ providerAbsentAt: expect.any(Date) })]);
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
