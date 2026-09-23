import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";

const conflictRowSchema = z.object({
  resolution_status: z.literal("source_conflict"),
  source_labels: z.array(z.string()),
  excluded_source_labels: z.array(z.string()),
});

describe("nutrition source-key namespaces", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name)
      VALUES ('nutrition-namespace-test', 'Namespace Nutrition')
      ON CONFLICT (id) DO NOTHING
    `);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  async function addDailyAggregate(input: {
    date: string;
    calories: number;
    sourceAccountKey?: string;
    sourceName?: string;
  }): Promise<void> {
    const entryId = crypto.randomUUID();
    await context.db.execute(sql`
      INSERT INTO fitness.food_entry (
        id, user_id, provider_id, date, nutrition_grain, source_account_key, source_name, confirmed
      )
      VALUES (
        ${entryId},
        ${TEST_USER_ID},
        'nutrition-namespace-test',
        ${input.date}::date,
        'daily_aggregate',
        ${input.sourceAccountKey ?? null},
        ${input.sourceName ?? null},
        true
      )
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
      VALUES (${entryId}::uuid, 'calories', ${input.calories}::real)
    `);
  }

  it.each([
    {
      label: "account and source-name",
      date: "2026-01-19",
      first: { sourceAccountKey: "a" },
      second: { sourceName: "account:a" },
      expectedLabels: ["Namespace Nutrition", "account:a (via Namespace Nutrition)"],
    },
    {
      label: "provider fallback and source-name",
      date: "2026-01-18",
      first: {},
      second: { sourceName: "provider" },
      expectedLabels: ["Namespace Nutrition", "provider (via Namespace Nutrition)"],
    },
  ])("keeps $label namespaces distinct", async ({ date, first, second, expectedLabels }) => {
    await addDailyAggregate({ date, calories: 1900, ...first });
    await addDailyAggregate({ date, calories: 1850, ...second });

    const rows = await executeWithSchema(
      context.db,
      conflictRowSchema,
      sql`
        SELECT resolution_status, source_labels, excluded_source_labels
        FROM fitness.v_nutrition_daily
        WHERE user_id = ${TEST_USER_ID} AND date = ${date}::date
      `,
    );

    expect(rows).toEqual([
      {
        resolution_status: "source_conflict",
        source_labels: expectedLabels,
        excluded_source_labels: expectedLabels,
      },
    ]);
  });
});
