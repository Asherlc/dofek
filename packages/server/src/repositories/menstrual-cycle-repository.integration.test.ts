import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { MenstrualCycleRepository } from "./menstrual-cycle-repository.ts";

const periodIdRowSchema = z.object({ id: z.string().uuid() });

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

  it("corrects a period by stable ID and returns its inclusive duration", async () => {
    const repository = new MenstrualCycleRepository(testContext.db, TEST_USER_ID);
    const [row] = await executeWithSchema(
      testContext.db,
      periodIdRowSchema,
      sql`INSERT INTO fitness.menstrual_period (user_id, start_date, end_date, notes)
          VALUES (${TEST_USER_ID}, '2099-02-10', '2099-02-11', 'before correction')
          RETURNING id`,
    );
    if (!row) throw new Error("Expected correction fixture row");

    const corrected = await repository.updatePeriod(
      row.id,
      "2099-02-12",
      "2099-02-15",
      "after correction",
    );

    expect(corrected).toMatchObject({
      id: row.id,
      startDate: "2099-02-12",
      endDate: "2099-02-15",
      durationDays: 4,
      durationLabel: "4 days",
      notes: "after correction",
    });
  });

  it("deletes only a period owned by the repository user", async () => {
    const secondUserId = "00000000-0000-4000-8000-000000000216";
    const ownedPeriodId = "00000000-0000-4000-8000-000000002166";
    const otherPeriodId = "00000000-0000-4000-8000-000000002167";
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${secondUserId}, 'Cycle Integration Other User')`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.menstrual_period (id, user_id, start_date)
          VALUES
            (${ownedPeriodId}, ${TEST_USER_ID}, '2099-03-01'),
            (${otherPeriodId}, ${secondUserId}, '2099-03-01')`,
    );
    const repository = new MenstrualCycleRepository(testContext.db, TEST_USER_ID);

    await expect(
      repository.updatePeriod(otherPeriodId, "2099-03-02", null, null),
    ).resolves.toBeNull();
    await expect(repository.deletePeriod(otherPeriodId)).resolves.toBe(false);
    await expect(repository.deletePeriod(ownedPeriodId)).resolves.toBe(true);

    const rows = await executeWithSchema(
      testContext.db,
      periodIdRowSchema,
      sql`SELECT id
          FROM fitness.menstrual_period
          WHERE id IN (${ownedPeriodId}, ${otherPeriodId})
          ORDER BY id`,
    );
    expect(rows).toEqual([{ id: otherPeriodId }]);
  });

  it("preserves the per-user unique start-date constraint during correction", async () => {
    const repository = new MenstrualCycleRepository(testContext.db, TEST_USER_ID);
    const firstPeriodId = "00000000-0000-4000-8000-000000002168";
    await testContext.db.execute(
      sql`INSERT INTO fitness.menstrual_period (id, user_id, start_date)
          VALUES
            (${firstPeriodId}, ${TEST_USER_ID}, '2099-04-01'),
            ('00000000-0000-4000-8000-000000002169', ${TEST_USER_ID}, '2099-04-08')`,
    );

    await expect(repository.updatePeriod(firstPeriodId, "2099-04-08", null, null)).rejects.toThrow(
      "A period is already recorded for 2099-04-08. Choose a different start date.",
    );
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

  it("withholds a regular-cycle phase model for irregular intervals", async () => {
    await testContext.db.execute(
      sql`DELETE FROM fitness.menstrual_period WHERE user_id = ${TEST_USER_ID}`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.menstrual_period (user_id, start_date)
          VALUES
            (${TEST_USER_ID}, '2026-03-01'),
            (${TEST_USER_ID}, '2026-03-23'),
            (${TEST_USER_ID}, '2026-04-26'),
            (${TEST_USER_ID}, '2026-05-18')`,
    );
    const repository = new MenstrualCycleRepository(testContext.db, TEST_USER_ID);

    const result = await repository.getCurrentPhase(new Date("2026-05-23T12:00:00Z"));

    expect(result).toMatchObject({
      phase: null,
      cycleLength: null,
      estimate: null,
      availability: {
        status: "irregular-history",
      },
    });
  });
});
