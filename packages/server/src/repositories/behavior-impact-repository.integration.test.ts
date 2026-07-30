import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { BehaviorImpactRepository } from "./behavior-impact-repository.ts";

const sensorStore = {
  query: async <TSchema extends z.ZodType>(schema: TSchema): Promise<Array<z.infer<TSchema>>> =>
    z.array(schema).parse([]),
} satisfies Pick<ActivitySensorStore, "query">;

describe("BehaviorImpactRepository provider provenance", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name)
      VALUES
        ('manual_review', 'Manual review'),
        ('whoop', 'WHOOP')
      ON CONFLICT (id) DO NOTHING
    `);

    for (let dayIndex = 0; dayIndex < 10; dayIndex++) {
      const entryDate = `2026-07-${String(dayIndex + 10).padStart(2, "0")}`;
      const readinessDate = `2026-07-${String(dayIndex + 11).padStart(2, "0")}`;
      const providerId = dayIndex % 2 === 0 ? "manual_review" : "whoop";
      const answerNumeric = dayIndex < 5 ? 1 : 0;
      const answerText = answerNumeric === 1 ? "yes" : "no";

      await context.db.execute(sql`
        INSERT INTO fitness.journal_entry (
          user_id, provider_id, date, question_slug, answer_text, answer_numeric
        )
        VALUES (
          ${TEST_USER_ID}, ${providerId}, ${entryDate}::date, 'meditation',
          ${answerText}, ${answerNumeric}
        )
      `);
      await context.db.execute(sql`
        INSERT INTO fitness.daily_metrics (user_id, provider_id, date, hrv)
        VALUES (${TEST_USER_ID}, ${providerId}, ${readinessDate}::date, ${60 + dayIndex})
      `);
    }
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  it("executes the association query and returns every contributing provider once", async () => {
    const impacts = await new BehaviorImpactRepository(
      context.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
    ).getImpactSummary(null);

    expect(impacts).toHaveLength(1);
    expect(impacts[0]?.toDetail()).toEqual(
      expect.objectContaining({
        questionSlug: "meditation",
        yesCount: 5,
        noCount: 5,
        sources: [
          { providerId: "manual_review", label: "Manual review" },
          { providerId: "whoop", label: "WHOOP (Cloud)" },
        ],
      }),
    );
  });
});
