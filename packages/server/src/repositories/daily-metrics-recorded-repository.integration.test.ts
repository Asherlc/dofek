import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { DailyMetricsRecordedRepository } from "./daily-metrics-recorded-repository.ts";
import { ProviderDetailRepository } from "./provider-detail-repository.ts";

const userId = "00000000-0000-4000-8000-0000000000c1";
const otherUserId = "00000000-0000-4000-8000-0000000000c2";

describe("DailyMetricsRecordedRepository (integration)", () => {
  let ctx: TestContext;

  async function seed(
    user: string,
    providerId: string,
    date: string,
    values: Record<string, number>,
    sourceName: string | null = null,
  ) {
    const [parent] = await ctx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.daily_metrics (date, provider_id, user_id, source_name)
          VALUES (${date}::date, ${providerId}, ${user}::uuid, ${sourceName})
          RETURNING id`,
    );
    for (const [metric, value] of Object.entries(values)) {
      await ctx.db.execute(
        sql`INSERT INTO fitness.daily_metric_value (daily_metrics_id, metric_type_id, value)
            VALUES (${parent?.id}::uuid, ${metric}, ${value})`,
      );
    }
  }

  const repository = (
    accessWindow?: ConstructorParameters<typeof DailyMetricsRecordedRepository>[3],
  ) => new DailyMetricsRecordedRepository(ctx.db, userId, "UTC", accessWindow);

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${userId}::uuid, 'Recorded A'), (${otherUserId}::uuid, 'Recorded B')`,
    );
    await ensureProvider(ctx.db, "intervals.icu", "Intervals.icu", "https://intervals.icu");
    await ensureProvider(ctx.db, "withings", "Withings", "https://wbsapi.withings.net");
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority, body_priority, sleep_priority)
          VALUES ('withings', 10, 5, NULL), ('intervals.icu', 50, 50, 50)
          ON CONFLICT (provider_id) DO UPDATE SET priority = EXCLUDED.priority,
            body_priority = EXCLUDED.body_priority, sleep_priority = EXCLUDED.sleep_priority`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.device_priority (provider_id, source_name_pattern, body_priority)
          VALUES ('withings', 'Old Scale%', 90)
          ON CONFLICT (provider_id, source_name_pattern) DO UPDATE SET body_priority = 90`,
    );
    // Day 1: both providers record weight; the higher-priority provider wins that metric only.
    await seed(userId, "intervals.icu", "2026-03-01", {
      weight: 71,
      resting_heart_rate: 50,
      sleep_duration_reported: 0,
    });
    await seed(userId, "withings", "2026-03-01", { weight: 70 });
    // Day 2: only Intervals.icu; Day 3: a demoted device loses to Intervals.icu.
    await seed(userId, "intervals.icu", "2026-03-02", { weight: 72.3 });
    await seed(userId, "withings", "2026-03-03", { weight: 60 }, "Old Scale 1");
    await seed(userId, "intervals.icu", "2026-03-03", { weight: 73 });
    // Outside the window and another user's data.
    await seed(userId, "intervals.icu", "2026-01-01", { weight: 99 });
    await seed(otherUserId, "intervals.icu", "2026-03-01", { weight: 1 });
  }, 120_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("resolves each exact day and metric independently by body priority", async () => {
    await expect(repository().listRecorded("body", 7, "2026-03-05")).resolves.toEqual([
      {
        date: "2026-03-01",
        metric: "resting_heart_rate",
        value: 50,
        unit: "bpm",
        providerId: "intervals.icu",
        sourceName: null,
      },
      {
        date: "2026-03-01",
        metric: "weight",
        value: 70,
        unit: "kg",
        providerId: "withings",
        sourceName: null,
      },
      {
        date: "2026-03-02",
        metric: "weight",
        value: 72.3,
        unit: "kg",
        providerId: "intervals.icu",
        sourceName: null,
      },
      {
        date: "2026-03-03",
        metric: "weight",
        value: 73,
        unit: "kg",
        providerId: "intervals.icu",
        sourceName: null,
      },
    ]);
  });

  it("serves a monthly window and an all-time window", async () => {
    const monthly = await repository().listRecorded("body", 31, "2026-03-31");
    expect(monthly.map((row) => row.date)).toEqual([
      "2026-03-01",
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
    ]);
    const allTime = await repository().listRecorded("body", null, "2026-03-31");
    expect(allTime[0]).toMatchObject({ date: "2026-01-01", value: 99 });
  });

  it("returns only the sleep group, keeping a zero duration", async () => {
    await expect(repository().listRecorded("sleep", 7, "2026-03-05")).resolves.toEqual([
      {
        date: "2026-03-01",
        metric: "sleep_duration_reported",
        value: 0,
        unit: "sec",
        providerId: "intervals.icu",
        sourceName: null,
      },
    ]);
  });

  it("applies the limited access window", async () => {
    const limited = repository({
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-03-02",
      endDateExclusive: "2026-03-03",
    });
    expect((await limited.listRecorded("body", 7, "2026-03-05")).map((row) => row.date)).toEqual([
      "2026-03-02",
    ]);
  });

  it("is removed by provider data deletion without touching another user's values", async () => {
    await new ProviderDetailRepository(ctx.db, userId).requestProviderDataDeletion("intervals.icu");

    const rows = await ctx.db.execute<{ user_id: string }>(
      sql`SELECT dm.user_id FROM fitness.daily_metric_value v
          JOIN fitness.daily_metrics dm ON dm.id = v.daily_metrics_id
          WHERE dm.provider_id = 'intervals.icu'`,
    );
    expect(rows.map((row) => row.user_id)).toEqual([otherUserId]);
  });
});
