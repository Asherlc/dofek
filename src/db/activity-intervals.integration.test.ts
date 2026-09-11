import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activity } from "./schema/activity.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";

const providerId = "activity-interval-source-test";

describe("provider-neutral activity interval schema", () => {
  let context: TestContext;
  let activityId: string;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, providerId, "Activity Interval Source Test");
    const [storedActivity] = await context.db
      .insert(activity)
      .values({
        providerId,
        externalId: "source-interval-activity",
        canonicalType: "cycling",
        providerType: "cycling",
        startedAt: new Date("2026-09-10T12:00:00Z"),
        endedAt: new Date("2026-09-10T13:00:00Z"),
      })
      .returning({ id: activity.id });
    if (!storedActivity) throw new Error("Expected activity fixture");
    activityId = storedActivity.id;
  }, 60_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("stores provider-recorded source and target provenance", async () => {
    await expect(
      context.db.execute(
        sql.raw(`INSERT INTO fitness.activity_interval (
          activity_id, interval_index, started_at, ended_at,
          source_kind, source_provider, source_activity_id,
          segment_type, target_intensity, target_zone, target_cadence_rpm,
          target_power_watts, target_resistance, work_recovery_kind, raw
        ) VALUES (
          '${activityId}', 1, '2026-09-10T12:00:00Z', '2026-09-10T12:05:00Z',
          'provider_recorded', '${providerId}', '${activityId}',
          'power', 0.96, 4, 95, 240, 38, 'work', '{"source":"fixture"}'::jsonb
        )`),
      ),
    ).resolves.toBeDefined();

    const result = await context.db.execute(
      sql.raw(`SELECT source_kind, source_provider, source_activity_id, target_power_watts,
        work_recovery_kind, raw
       FROM fitness.activity_interval
       WHERE activity_id = '${activityId}' AND interval_index = 1`),
    );
    expect(result).toEqual([
      {
        source_kind: "provider_recorded",
        source_provider: providerId,
        source_activity_id: activityId,
        target_power_watts: 240,
        work_recovery_kind: "work",
        raw: { source: "fixture" },
      },
    ]);
  });

  it("rejects inferred intervals with invented target values", async () => {
    await expect(
      context.db.execute(
        sql.raw(`INSERT INTO fitness.activity_interval (
          activity_id, interval_index, started_at, ended_at, source_kind, target_power_watts
        ) VALUES (
          '${activityId}', 2, '2026-09-10T12:05:00Z', '2026-09-10T12:10:00Z', 'inferred', 240
        )`),
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});
