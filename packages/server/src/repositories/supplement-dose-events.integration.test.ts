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
import { SupplementDoseConflictError, SupplementsRepository } from "./supplements-repository.ts";

const OTHER_USER_ID = "00000000-0000-4000-8000-000000002064";

const definitionVersionSchema = z.object({
  id: z.string(),
  schedule_id: z.string(),
  supersedes_definition_id: z.string().nullable(),
  name: z.string(),
  amount: z.coerce.number().nullable(),
  effective_from: z.string(),
  effective_to: z.string().nullable(),
});

const currentDefinitionSchema = z.object({
  id: z.string(),
  schedule_id: z.string(),
});

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

describe("SupplementsRepository dose events with Postgres", () => {
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

  it("archives changed definitions and preserves one stable schedule identity", async () => {
    const repository = new SupplementsRepository(context.db, TEST_USER_ID, "UTC");
    await repository.save([
      { name: "Versioned Magnesium", amount: 200, unit: "mg", magnesiumMg: 200 },
    ]);
    const [initial] = await executeWithSchema(
      context.db,
      currentDefinitionSchema,
      sql`SELECT
            definition.id,
            definition.supplement_id AS schedule_id
          FROM fitness.supplement_definition AS definition
          INNER JOIN fitness.supplement AS supplement
            ON supplement.id = definition.supplement_id
          WHERE supplement.user_id = ${TEST_USER_ID}
            AND definition.effective_to IS NULL`,
    );
    if (!initial) throw new Error("Initial magnesium definition was not saved");
    await ensureProvider(
      context.db,
      "auto-supplements",
      "Auto-Supplements",
      undefined,
      TEST_USER_ID,
    );
    const scheduledDate = formatDateYmdInTimeZone(new Date(), "UTC");
    await context.db.insert(supplementDoseEvent).values({
      userId: TEST_USER_ID,
      supplementId: initial.schedule_id,
      definitionId: initial.id,
      providerId: "auto-supplements",
      externalId: `versioned-magnesium:${scheduledDate}`,
      scheduledDate,
      status: "planned",
      recordedAt: new Date(),
    });
    await repository.save([
      { name: "Renamed Magnesium", amount: 300, unit: "mg", magnesiumMg: 300 },
    ]);

    const versions = await executeWithSchema(
      context.db,
      definitionVersionSchema,
      sql`SELECT
            definition.id,
            definition.supplement_id AS schedule_id,
            definition.supersedes_definition_id,
            definition.name,
            definition.amount,
            definition.effective_from,
            definition.effective_to
          FROM fitness.supplement_definition AS definition
          INNER JOIN fitness.supplement AS supplement
            ON supplement.id = definition.supplement_id
          WHERE supplement.user_id = ${TEST_USER_ID}
          ORDER BY definition.created_at, definition.id`,
    );

    expect(versions).toHaveLength(2);
    expect(versions[0]?.schedule_id).toBe(versions[1]?.schedule_id);
    expect(versions[0]?.effective_to).toBe(versions[1]?.effective_from);
    expect(versions[1]?.supersedes_definition_id).toBe(versions[0]?.id);
    expect(versions.map((version) => version.amount)).toEqual([200, 300]);
    expect(await repository.list()).toEqual([
      { name: "Renamed Magnesium", amount: 300, unit: "mg", magnesiumMg: 300 },
    ]);
    expect(
      (await repository.occurrences(7)).occurrences.find(
        (occurrence) => occurrence.scheduleId === initial.schedule_id,
      )?.supplementName,
    ).toBe("Versioned Magnesium");
  });

  it("appends one successor and rejects stale or cross-user expected leaves", async () => {
    const repository = new SupplementsRepository(context.db, TEST_USER_ID, "UTC");
    await repository.save([{ name: "Conflict Zinc", zincMg: 15 }]);
    const [definition] = await executeWithSchema(
      context.db,
      currentDefinitionSchema,
      sql`SELECT
            definition.id,
            definition.supplement_id AS schedule_id
          FROM fitness.supplement_definition AS definition
          INNER JOIN fitness.supplement AS supplement
            ON supplement.id = definition.supplement_id
          WHERE supplement.user_id = ${TEST_USER_ID}
            AND definition.name = 'Conflict Zinc'
            AND definition.effective_to IS NULL`,
    );
    if (!definition) throw new Error("Conflict Zinc definition was not saved");

    await ensureProvider(
      context.db,
      "auto-supplements",
      "Auto-Supplements",
      undefined,
      TEST_USER_ID,
    );
    const today = formatDateYmdInTimeZone(new Date(), "UTC");
    const [planned] = await context.db
      .insert(supplementDoseEvent)
      .values({
        userId: TEST_USER_ID,
        supplementId: definition.schedule_id,
        definitionId: definition.id,
        providerId: "auto-supplements",
        externalId: `conflict-zinc:${today}`,
        scheduledDate: today,
        status: "planned",
        recordedAt: new Date(),
      })
      .returning({ id: supplementDoseEvent.id });
    if (!planned) throw new Error("Planned Conflict Zinc event was not saved");

    await expect(repository.recordDose(planned.id, "taken")).resolves.toMatchObject({
      scheduledDate: today,
      status: "taken",
    });
    await expect(repository.recordDose(planned.id, "skipped")).rejects.toBeInstanceOf(
      SupplementDoseConflictError,
    );
    await expect(
      new SupplementsRepository(context.db, OTHER_USER_ID, "UTC").recordDose(planned.id, "taken"),
    ).rejects.toBeInstanceOf(SupplementDoseConflictError);

    const result = await repository.occurrences(7);
    const occurrence = result.occurrences.find(
      (candidate) => candidate.supplementName === "Conflict Zinc",
    );
    expect(occurrence?.status).toBe("taken");
    expect(occurrence?.history.map((event) => event.status)).toEqual(["planned", "taken"]);
    expect(result.counts.taken).toBeGreaterThanOrEqual(1);
  });

  it("rejects a dose event whose user does not own its supplement schedule", async () => {
    const repository = new SupplementsRepository(context.db, TEST_USER_ID, "UTC");
    await repository.save([{ name: "Owned Vitamin C", vitaminCMg: 100 }]);
    const [definition] = await executeWithSchema(
      context.db,
      currentDefinitionSchema,
      sql`SELECT
            definition.id,
            definition.supplement_id AS schedule_id
          FROM fitness.supplement_definition AS definition
          INNER JOIN fitness.supplement AS supplement
            ON supplement.id = definition.supplement_id
          WHERE supplement.user_id = ${TEST_USER_ID}
            AND definition.name = 'Owned Vitamin C'
            AND definition.effective_to IS NULL`,
    );
    if (!definition) throw new Error("Owned Vitamin C definition was not saved");
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
        supplementId: definition.schedule_id,
        definitionId: definition.id,
        providerId: "auto-supplements",
        externalId: "cross-user-dose-event",
        scheduledDate: formatDateYmdInTimeZone(new Date(), "UTC"),
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

  it("adds a current taken leaf to resolved food without creating a source conflict", async () => {
    const repository = new SupplementsRepository(context.db, TEST_USER_ID, "UTC");
    await repository.save([
      {
        name: "Overlay Vitamin D",
        meal: "breakfast",
        vitaminDMcg: 25,
      },
    ]);
    const [definition] = await executeWithSchema(
      context.db,
      currentDefinitionSchema,
      sql`SELECT
            definition.id,
            definition.supplement_id AS schedule_id
          FROM fitness.supplement_definition AS definition
          INNER JOIN fitness.supplement AS supplement
            ON supplement.id = definition.supplement_id
          WHERE supplement.user_id = ${TEST_USER_ID}
            AND definition.name = 'Overlay Vitamin D'
            AND definition.effective_to IS NULL`,
    );
    if (!definition) throw new Error("Overlay Vitamin D definition was not saved");

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
    const date = formatDateYmdInTimeZone(new Date(), "UTC");
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
    const [planned] = await context.db
      .insert(supplementDoseEvent)
      .values({
        userId: TEST_USER_ID,
        supplementId: definition.schedule_id,
        definitionId: definition.id,
        providerId: "auto-supplements",
        externalId: `overlay-vitamin-d:${date}`,
        scheduledDate: date,
        status: "planned",
        recordedAt: new Date(),
      })
      .returning({ id: supplementDoseEvent.id });
    if (!planned) throw new Error("Overlay Vitamin D occurrence was not saved");
    const taken = await repository.recordDose(planned.id, "taken");

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
      source_providers: ["dofek", "supplement-food-fixture"],
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
