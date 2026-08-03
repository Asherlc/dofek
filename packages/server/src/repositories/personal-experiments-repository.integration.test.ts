import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { LifeEventsRepository } from "./life-events-repository.ts";
import { PersonalExperimentsRepository } from "./personal-experiments-repository.ts";

const checkInRowSchema = z.object({
  adherence: z.enum(["adherent", "partial", "not_adherent", "unknown"]),
  confounder: z.string().nullable(),
  note: z.string().nullable(),
});

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

  it("upserts one raw check-in per experiment day and keeps linked annotations after deletion", async () => {
    const experiments = new PersonalExperimentsRepository(
      testContext.db,
      TEST_USER_ID,
      "America/Los_Angeles",
    );
    const lifeEvents = new LifeEventsRepository(
      testContext.db,
      TEST_USER_ID,
      "America/Los_Angeles",
    );
    const experiment = await experiments.create({
      hypothesis: "Does a bedtime change improve HRV?",
      intervention: "Lights out by 10pm",
      outcomeMetricId: "hrv",
      lagDays: 0,
      baselineDays: 7,
      interventionDays: 14,
      startDate: "2099-02-01",
    });
    let annotationId: string | null = null;

    try {
      await experiments.upsertCheckIn(experiment.id, {
        date: "2099-02-08",
        adherence: "adherent",
        confounder: "Late meal",
        note: "First entry",
      });
      const current = await experiments.upsertCheckIn(experiment.id, {
        date: "2099-02-08",
        adherence: "partial",
        confounder: null,
        note: "Updated entry",
      });

      expect(current).toMatchObject({
        date: "2099-02-08",
        adherence: "partial",
        confounder: null,
        note: "Updated entry",
      });
      const checkIns = await executeWithSchema(
        testContext.db,
        checkInRowSchema,
        sql`SELECT adherence, confounder, note
            FROM fitness.personal_experiment_check_in
            WHERE personal_experiment_id = ${experiment.id} AND date = '2099-02-08'::date`,
      );
      expect(checkIns).toEqual([{ adherence: "partial", confounder: null, note: "Updated entry" }]);

      const annotation = await lifeEvents.create({
        label: "Travel",
        startedAt: "2099-02-08",
        endedAt: null,
        category: null,
        ongoing: false,
        notes: "Different time zone",
        personalExperimentId: experiment.id,
      });
      annotationId = annotation.id;
      expect(annotation.personal_experiment_id).toBe(experiment.id);

      await testContext.db.execute(
        sql`DELETE FROM fitness.personal_experiment WHERE id = ${experiment.id}`,
      );
      const annotations = await lifeEvents.list();
      expect(annotations.find((event) => event.id === annotation.id)).toMatchObject({
        personal_experiment_id: null,
      });
    } finally {
      if (annotationId) {
        await testContext.db.execute(
          sql`DELETE FROM fitness.life_events WHERE id = ${annotationId}`,
        );
      }
    }
  });
});
