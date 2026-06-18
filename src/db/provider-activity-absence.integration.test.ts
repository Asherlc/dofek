import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileProviderActivityAbsence } from "./provider-activity-absence.ts";
import { activity } from "./schema.ts";
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
        activityType: "running",
        startedAt: new Date("2026-03-01T10:00:00Z"),
      },
      {
        providerId: "provider-absence-test",
        externalId: "missing-activity",
        activityType: "cycling",
        startedAt: new Date("2026-03-02T10:00:00Z"),
      },
      {
        providerId: "provider-absence-test",
        externalId: "outside-window",
        activityType: "walking",
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
      activityType: "running",
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
});
