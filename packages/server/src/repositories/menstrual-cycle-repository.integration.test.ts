import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { MenstrualCycleRepository } from "./menstrual-cycle-repository.ts";

describe("MenstrualCycleRepository period durations", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`INSERT INTO fitness.menstrual_period (user_id, start_date, end_date, notes)
          VALUES
            (${TEST_USER_ID}, CURRENT_DATE - 10, CURRENT_DATE - 6, 'five-day period'),
            (${TEST_USER_ID}, CURRENT_DATE - 4, CURRENT_DATE - 4, 'one-day period'),
            (${TEST_USER_ID}, CURRENT_DATE - 2, NULL, 'open period')`,
    );
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("returns inclusive calendar-day durations from history", async () => {
    const repository = new MenstrualCycleRepository(testContext.db, TEST_USER_ID);

    const periods = await repository.getHistory(1);
    const byNotes = new Map(periods.map((period) => [period.notes, period]));

    expect(byNotes.get("five-day period")).toMatchObject({
      durationDays: 5,
      durationLabel: "5 days",
    });
    expect(byNotes.get("one-day period")).toMatchObject({
      durationDays: 1,
      durationLabel: "1 day",
    });
    expect(byNotes.get("open period")).toMatchObject({
      durationDays: null,
      durationLabel: null,
    });
  });

  it("returns the same canonical duration fields after logging a period", async () => {
    const repository = new MenstrualCycleRepository(testContext.db, TEST_USER_ID);

    const period = await repository.logPeriod("2099-01-10", "2099-01-14", "logged period");

    expect(period).toMatchObject({
      startDate: "2099-01-10",
      endDate: "2099-01-14",
      durationDays: 5,
      durationLabel: "5 days",
    });
  });
});
