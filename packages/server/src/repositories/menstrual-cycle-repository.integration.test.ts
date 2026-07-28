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

describe("MenstrualCycleRepository phase estimate history", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`INSERT INTO fitness.menstrual_period (user_id, start_date)
          VALUES
            (${TEST_USER_ID}, '2026-04-05'),
            (${TEST_USER_ID}, '2026-05-02'),
            (${TEST_USER_ID}, '2026-06-02'),
            (${TEST_USER_ID}, '2026-07-01')`,
    );
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("uses the same completed cycle intervals for average, count, and observed range", async () => {
    const repository = new MenstrualCycleRepository(testContext.db, TEST_USER_ID);

    const result = await repository.getCurrentPhase(new Date("2026-07-13T12:00:00Z"));

    expect(result).toMatchObject({
      phase: "follicular",
      dayOfCycle: 13,
      cycleLength: 29,
      estimate: {
        basis: "personal-cycle-average",
        completedCycleCount: 3,
        observedCycleLengthRange: {
          minimumDays: 27,
          maximumDays: 31,
        },
        methodLabel: "Phase and cycle length use the average of 3 completed cycles.",
        uncertaintyLabel: "Recorded cycle lengths ranged from 27 to 31 days.",
      },
    });
  });
});
