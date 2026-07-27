import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { PersonalExperimentsRepository } from "./personal-experiments-repository.ts";

describe("PersonalExperimentsRepository integration", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("creates, lists, and stops a personal experiment with schedule enrichment", async () => {
    await testContext.db.execute(
      sql`DELETE FROM fitness.personal_experiment WHERE user_id = ${TEST_USER_ID}`,
    );

    const repository = new PersonalExperimentsRepository(
      testContext.db,
      TEST_USER_ID,
      "America/Los_Angeles",
    );

    const created = await repository.create({
      hypothesis: "Does a consistent bedtime improve heart rate variability?",
      intervention: "Lights out by 10pm on weeknights",
      outcomeMetricId: "hrv",
      lagDays: 1,
      baselineDays: 7,
      interventionDays: 14,
      startDate: "2099-01-01",
    });

    expect(created).toMatchObject({
      hypothesis: "Does a consistent bedtime improve heart rate variability?",
      intervention: "Lights out by 10pm on weeknights",
      outcomeMetricId: "hrv",
      outcomeMetricLabel: "Heart Rate Variability",
      lagDays: 1,
      status: "active",
      stoppedAt: null,
      phase: "upcoming",
      schedule: {
        baselineStartDate: "2099-01-01",
        baselineEndDate: "2099-01-07",
        interventionStartDate: "2099-01-08",
        interventionEndDate: "2099-01-21",
        scheduleSummary: "Starts on 2099-01-01",
      },
    });

    const listed = await repository.list();
    expect(listed.some((experiment) => experiment.id === created.id)).toBe(true);

    const stopped = await repository.stop(created.id);
    expect(stopped).toMatchObject({
      id: created.id,
      status: "stopped",
      phase: "stopped",
    });
    expect(stopped?.stoppedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const alreadyStopped = await repository.stop(created.id);
    expect(alreadyStopped).toBeNull();
  });
});
