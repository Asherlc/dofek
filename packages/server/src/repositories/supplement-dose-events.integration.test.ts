import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { nutritionSourceResolutionSchema } from "@dofek/nutrition/selected-date-summary";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { foodEntry, supplement, supplementDoseEvent } from "../../../../src/db/schema/nutrition.ts";
import { userProfile } from "../../../../src/db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { insertSupplementDefinitionForTest } from "./test-helpers.ts";

const OTHER_USER_ID = "00000000-0000-4000-8000-000000002064";

const dailyOverlaySchema = z.object({
  calories: z.coerce.number(),
  resolution_status: nutritionSourceResolutionSchema.shape.status,
  source_providers: z.array(z.string()),
  contribution_grain: nutritionSourceResolutionSchema.shape.contributionGrain,
  contribution_source_label: nutritionSourceResolutionSchema.shape.contributionLabel,
});

const nutrientOverlaySchema = z.object({
  amount: z.coerce.number(),
  food_entry_id: z.string().nullable(),
  supplement_dose_event_id: z.string().nullable(),
});

describe("Supplement dose events with Postgres", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db
      .insert(userProfile)
      .values({ id: OTHER_USER_ID, name: "Other Supplement User" })
      .onConflictDoNothing();
  }, 60_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  beforeEach(async () => {
    await context.db.delete(supplementDoseEvent);
    await context.db.delete(supplement);
    await context.db.delete(foodEntry);
  });

  it("rejects a dose event whose user does not own its supplement schedule", async () => {
    const date = formatDateYmdInTimeZone(new Date(), "UTC");
    const definition = await insertSupplementDefinitionForTest(context.db, {
      userId: TEST_USER_ID,
      name: "Owned Vitamin C",
      effectiveFrom: date,
    });
    await ensureProvider(
      context.db,
      "auto-supplements",
      "Auto-Supplements",
      undefined,
      OTHER_USER_ID,
    );

    await expect(
      context.db.insert(supplementDoseEvent).values({
        userId: OTHER_USER_ID,
        supplementId: definition.scheduleId,
        definitionId: definition.definitionId,
        providerId: "auto-supplements",
        externalId: "cross-user-dose-event",
        scheduledDate: date,
        status: "planned",
        recordedAt: new Date(),
      }),
    ).rejects.toMatchObject({
      cause: {
        code: "23503",
        constraint: "supplement_dose_event_supplement_user_fkey",
      },
    });
  });

  it("adds a current taken event to resolved food without creating a source conflict", async () => {
    const date = formatDateYmdInTimeZone(new Date(), "UTC");
    const definition = await insertSupplementDefinitionForTest(
      context.db,
      {
        userId: TEST_USER_ID,
        name: "Overlay Vitamin D",
        effectiveFrom: date,
        meal: "breakfast",
      },
      { vitaminDMcg: 25 },
    );

    await ensureProvider(
      context.db,
      "supplement-food-fixture",
      "Food Fixture",
      undefined,
      TEST_USER_ID,
    );
    await ensureProvider(
      context.db,
      "auto-supplements",
      "Auto-Supplements",
      undefined,
      TEST_USER_ID,
    );
    await context.db.execute(sql`
      WITH entry AS (
        INSERT INTO fitness.food_entry (
          user_id, provider_id, external_id, date, nutrition_grain, meal, food_name, confirmed
        )
        VALUES (
          ${TEST_USER_ID},
          'supplement-food-fixture',
          ${`overlay-food:${date}`},
          ${date}::date,
          'itemized',
          'breakfast',
          'Overlay Breakfast',
          TRUE
        )
        RETURNING id
      )
      INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
      SELECT id, 'calories', 400 FROM entry
    `);
    const [taken] = await context.db
      .insert(supplementDoseEvent)
      .values({
        userId: TEST_USER_ID,
        supplementId: definition.scheduleId,
        definitionId: definition.definitionId,
        providerId: "auto-supplements",
        externalId: `overlay-vitamin-d:${date}`,
        scheduledDate: date,
        status: "taken",
        recordedAt: new Date(),
        sourceName: "Auto-Supplements",
      })
      .returning({ id: supplementDoseEvent.id });
    if (!taken) throw new Error("Overlay Vitamin D event was not saved");

    const [daily] = await executeWithSchema(
      context.db,
      dailyOverlaySchema,
      sql`SELECT
            calories,
            resolution_status,
            source_providers,
            contribution_grain,
            contribution_source_label
          FROM fitness.v_nutrition_daily
          WHERE user_id = ${TEST_USER_ID}
            AND date = ${date}::date`,
    );
    expect(daily).toEqual({
      calories: 400,
      resolution_status: "available",
      source_providers: ["auto-supplements", "supplement-food-fixture"],
      contribution_grain: "itemized",
      contribution_source_label: "Food Fixture",
    });

    const nutrients = await executeWithSchema(
      context.db,
      nutrientOverlaySchema,
      sql`SELECT amount, food_entry_id, supplement_dose_event_id
          FROM fitness.v_nutrition_canonical_nutrient
          WHERE user_id = ${TEST_USER_ID}
            AND date = ${date}::date
            AND nutrient_id = 'vitamin_d'`,
    );
    expect(nutrients).toEqual([
      {
        amount: 25,
        food_entry_id: null,
        supplement_dose_event_id: taken.id,
      },
    ]);
  });
});
