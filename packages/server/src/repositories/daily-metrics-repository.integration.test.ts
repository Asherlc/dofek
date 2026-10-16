import { randomUUID } from "node:crypto";
import { TEST_USER_ID } from "dofek/db/schema/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { DailyMetricsRepository } from "./daily-metrics-repository.ts";
import { restingHeartRateValuesCte } from "./resting-heart-rate-query.ts";

describe("DailyMetricsRepository resting heart rate baseline", () => {
  let testContext: TestContext;
  let repository: DailyMetricsRepository;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    repository = new DailyMetricsRepository(testContext.db, TEST_USER_ID);
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("averages only the preceding seven calendar days when readings have gaps", async () => {
    const rows = await repository.getHrvBaseline(
      10,
      "2026-10-10",
      restingHeartRateValuesCte([
        { date: "2026-10-01", resting_hr: 90 },
        { date: "2026-10-08", resting_hr: 60 },
        { date: "2026-10-10", resting_hr: 54 },
      ]),
    );

    expect(rows.map(({ date, resting_hr_mean_7d }) => ({ date, resting_hr_mean_7d }))).toEqual([
      { date: "2026-10-01", resting_hr_mean_7d: 90 },
      { date: "2026-10-08", resting_hr_mean_7d: 60 },
      { date: "2026-10-10", resting_hr_mean_7d: 57 },
    ]);
  });

  it("includes six-day-old warmup readings and excludes seven-day-old readings on the first requested day", async () => {
    const rows = await repository.getHrvBaseline(
      1,
      "2026-10-10",
      restingHeartRateValuesCte([
        { date: "2026-10-03", resting_hr: 90 },
        { date: "2026-10-04", resting_hr: 60 },
        { date: "2026-10-09", resting_hr: 54 },
        { date: "2026-10-10", resting_hr: 48 },
      ]),
    );

    expect(rows).toEqual([
      expect.objectContaining({
        date: "2026-10-10",
        resting_hr: 48,
        resting_hr_mean_7d: 54,
      }),
    ]);
  });

  it("ignores missing readings without carrying values beyond their calendar window", async () => {
    const userId = randomUUID();
    const providerId = `resting-hr-null-${userId}`;
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${userId}::uuid, 'Resting heart rate null fixture')`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES (${providerId}, 'Daily metrics fixture', ${userId}::uuid)`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.daily_metrics (date, provider_id, user_id, hrv)
          VALUES
            ('2026-10-09', ${providerId}, ${userId}::uuid, 45),
            ('2026-10-17', ${providerId}, ${userId}::uuid, 46)`,
    );

    const rows = await new DailyMetricsRepository(testContext.db, userId).getHrvBaseline(
      11,
      "2026-10-17",
      restingHeartRateValuesCte([
        { date: "2026-10-08", resting_hr: 60 },
        { date: "2026-10-10", resting_hr: 48 },
      ]),
    );

    expect(
      rows.map(({ date, resting_hr, resting_hr_mean_7d }) => ({
        date,
        resting_hr,
        resting_hr_mean_7d,
      })),
    ).toEqual([
      { date: "2026-10-08", resting_hr: 60, resting_hr_mean_7d: 60 },
      { date: "2026-10-09", resting_hr: null, resting_hr_mean_7d: 60 },
      { date: "2026-10-10", resting_hr: 48, resting_hr_mean_7d: 54 },
      { date: "2026-10-17", resting_hr: null, resting_hr_mean_7d: null },
    ]);
  });
});
