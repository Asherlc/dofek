import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { SyncDatabase } from "../../db/index.ts";
import { foodEntry, foodEntryNutrient } from "../../db/schema/nutrition.ts";
import {
  humanFoodNutrientDecision,
  humanRecordChange,
  humanRecordIdentity,
  humanRecordTarget,
} from "../../db/schema/record-modifications.ts";
import { provider, userProfile } from "../../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import { executeWithSchema } from "../../db/typed-sql.ts";
import { upsertZivaMealsForDate } from "./nutrition-writer.ts";
import { type NormalizedZivaMeal, normalizeZivaMeal, parseZivaMealPayload } from "./schemas.ts";

const ZIVA_PROVIDER_ID = "ziva";
const TEST_DATE = "2026-09-20";
const effectiveOverlayRowSchema = z.object({
  source_entry_id: z.uuid(),
  serving_unit: z.string().nullable(),
  serving_weight_grams: z.coerce.number().nullable(),
  source_serving_unit: z.string().nullable(),
  source_serving_weight_grams: z.coerce.number().nullable(),
  deleted: z.boolean(),
  protein: z.coerce.number().nullable(),
  source_protein: z.coerce.number().nullable(),
});

function makeMeal(overrides: Partial<NormalizedZivaMeal> = {}): NormalizedZivaMeal {
  const externalId = overrides.externalId ?? `meal:${randomUUID()}`;
  return {
    externalId,
    sourceAccountKey: "account-a",
    date: TEST_DATE,
    meal: "lunch",
    foodName: "Ziva sandwich",
    foodDescription: "Lunch sandwich",
    numberOfUnits: 1,
    servingUnit: "sandwich",
    servingWeightGrams: 180,
    loggedAt: new Date("2026-09-20T12:30:00-07:00"),
    raw: {
      mealId: externalId,
      description: "Lunch sandwich",
      itemCount: 1,
    },
    nutrients: [
      { nutrientId: "calories", amount: 410 },
      { nutrientId: "protein", amount: 22 },
      { nutrientId: "carbohydrate", amount: 45 },
      { nutrientId: "fat", amount: 16 },
    ],
    ...overrides,
  };
}

describe.sequential("upsertZivaMealsForDate", () => {
  let context: TestContext;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db
      .insert(provider)
      .values({ id: ZIVA_PROVIDER_ID, name: "Ziva" })
      .onConflictDoNothing();
  }, 120_000);

  beforeEach(async () => {
    userId = randomUUID();
    otherUserId = randomUUID();
    await context.db.insert(userProfile).values([
      { id: userId, name: "Ziva writer user" },
      { id: otherUserId, name: "Other Ziva writer user" },
    ]);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  async function entriesFor(owner: string) {
    return context.db
      .select()
      .from(foodEntry)
      .where(and(eq(foodEntry.userId, owner), eq(foodEntry.providerId, ZIVA_PROVIDER_ID)))
      .orderBy(foodEntry.externalId);
  }

  async function nutrientsFor(foodEntryId: string) {
    return context.db
      .select({ nutrientId: foodEntryNutrient.nutrientId, amount: foodEntryNutrient.amount })
      .from(foodEntryNutrient)
      .where(eq(foodEntryNutrient.foodEntryId, foodEntryId))
      .orderBy(foodEntryNutrient.nutrientId);
  }

  it("inserts once, repeats idempotently, and updates every mutable source field", async () => {
    const original = makeMeal({ externalId: "meal:stable-entry" });

    await expect(upsertZivaMealsForDate(context.db, userId, [original])).resolves.toBe(1);
    const initialRows = await entriesFor(userId);
    expect(initialRows).toHaveLength(1);
    const initial = initialRows[0];
    if (!initial) throw new Error("Expected the initial Ziva food entry");
    expect(initial).toMatchObject({
      userId,
      providerId: ZIVA_PROVIDER_ID,
      externalId: original.externalId,
      sourceAccountKey: "account-a",
      date: TEST_DATE,
      nutritionGrain: "meal_aggregate",
      meal: "lunch",
      foodName: "Ziva sandwich",
      foodDescription: "Lunch sandwich",
      numberOfUnits: 1,
      servingUnit: "sandwich",
      servingWeightGrams: 180,
      sourceName: "Ziva",
      providerFoodId: null,
      providerServingId: null,
      confirmed: true,
      raw: original.raw,
    });
    expect(initial.loggedAt?.toISOString()).toBe("2026-09-20T19:30:00.000Z");
    expect(await nutrientsFor(initial.id)).toEqual([
      { nutrientId: "calories", amount: 410 },
      { nutrientId: "carbohydrate", amount: 45 },
      { nutrientId: "fat", amount: 16 },
      { nutrientId: "protein", amount: 22 },
    ]);

    await expect(upsertZivaMealsForDate(context.db, userId, [original])).resolves.toBe(1);
    const repeated = await entriesFor(userId);
    expect(repeated).toHaveLength(1);
    expect(repeated[0]?.id).toBe(initial.id);
    expect(await nutrientsFor(initial.id)).toHaveLength(4);

    const changed = makeMeal({
      ...original,
      sourceAccountKey: "account-a-renamed-namespace",
      date: "2026-09-21",
      meal: "dinner",
      foodName: "Edited Ziva bowl",
      foodDescription: "Edited dinner description",
      numberOfUnits: 2,
      servingUnit: "large bowl",
      servingWeightGrams: 325,
      loggedAt: new Date("2026-09-21T18:45:00-07:00"),
      raw: { mealId: "source-meal-1", revision: 2, description: "Edited source payload" },
      nutrients: [
        { nutrientId: "calories", amount: 620 },
        { nutrientId: "protein", amount: 35 },
        { nutrientId: "carbohydrate", amount: 70 },
        { nutrientId: "fat", amount: 21 },
      ],
    });
    await expect(upsertZivaMealsForDate(context.db, userId, [changed])).resolves.toBe(1);

    const changedRows = await entriesFor(userId);
    expect(changedRows).toHaveLength(1);
    expect(changedRows[0]).toMatchObject({
      id: initial.id,
      sourceAccountKey: "account-a-renamed-namespace",
      date: "2026-09-21",
      meal: "dinner",
      foodName: "Edited Ziva bowl",
      foodDescription: "Edited dinner description",
      numberOfUnits: 2,
      servingUnit: "large bowl",
      servingWeightGrams: 325,
      raw: changed.raw,
    });
    expect(changedRows[0]?.loggedAt?.toISOString()).toBe("2026-09-22T01:45:00.000Z");
    expect(await nutrientsFor(initial.id)).toEqual([
      { nutrientId: "calories", amount: 620 },
      { nutrientId: "carbohydrate", amount: 70 },
      { nutrientId: "fat", amount: 21 },
      { nutrientId: "protein", amount: 35 },
    ]);

    const multiItemAggregate = makeMeal({
      ...changed,
      foodName: "Edited multi-item dinner",
      numberOfUnits: null,
      servingUnit: null,
      servingWeightGrams: null,
      loggedAt: null,
      raw: { mealId: "source-meal-1", revision: 3, itemCount: 2 },
    });
    await upsertZivaMealsForDate(context.db, userId, [multiItemAggregate]);

    expect((await entriesFor(userId))[0]).toMatchObject({
      id: initial.id,
      foodName: "Edited multi-item dinner",
      numberOfUnits: null,
      servingUnit: null,
      servingWeightGrams: null,
      loggedAt: null,
      raw: multiItemAggregate.raw,
    });
  });

  it("scopes identical external IDs by user and keeps distinct account identities for one user", async () => {
    const accountAMeal = makeMeal({
      externalId: "meal:same-normalized-id",
      sourceAccountKey: "account-a",
      raw: { mealId: "same-provider-meal-id", account: "a" },
    });
    const accountBMeal = makeMeal({
      externalId: "meal:different-account-digest",
      sourceAccountKey: "account-b",
      raw: { mealId: "same-provider-meal-id", account: "b" },
    });

    await expect(
      upsertZivaMealsForDate(context.db, userId, [accountAMeal, accountBMeal]),
    ).resolves.toBe(2);
    await expect(upsertZivaMealsForDate(context.db, otherUserId, [accountAMeal])).resolves.toBe(1);

    const ownerRows = await entriesFor(userId);
    const otherRows = await entriesFor(otherUserId);
    expect(ownerRows).toHaveLength(2);
    expect(ownerRows.map((row) => row.sourceAccountKey).sort()).toEqual(["account-a", "account-b"]);
    expect(ownerRows.map((row) => row.externalId).sort()).toEqual([
      "meal:different-account-digest",
      "meal:same-normalized-id",
    ]);
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0]).toMatchObject({
      userId: otherUserId,
      externalId: "meal:same-normalized-id",
      sourceAccountKey: "account-a",
    });
    expect(otherRows[0]?.id).not.toBe(
      ownerRows.find((row) => row.externalId === "meal:same-normalized-id")?.id,
    );
  });

  it("replaces the complete nutrient set, removes stale fiber, and preserves explicit zero", async () => {
    const meal = makeMeal({ externalId: "meal:exact-nutrients" });
    await upsertZivaMealsForDate(context.db, userId, [meal]);
    const entry = (await entriesFor(userId))[0];
    if (!entry) throw new Error("Expected a Ziva food entry for exact nutrient replacement");

    await context.db.insert(foodEntryNutrient).values({
      foodEntryId: entry.id,
      nutrientId: "fiber",
      amount: 9,
    });
    await upsertZivaMealsForDate(context.db, userId, [
      makeMeal({
        ...meal,
        nutrients: [
          { nutrientId: "calories", amount: 390 },
          { nutrientId: "protein", amount: 20 },
          { nutrientId: "carbohydrate", amount: 0 },
          { nutrientId: "fat", amount: 18 },
        ],
      }),
    ]);

    expect(await nutrientsFor(entry.id)).toEqual([
      { nutrientId: "calories", amount: 390 },
      { nutrientId: "carbohydrate", amount: 0 },
      { nutrientId: "fat", amount: 18 },
      { nutrientId: "protein", amount: 20 },
    ]);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
  ])("rejects a %s macro before invoking the writer", async (_case, invalidFat) => {
    const macros: Record<string, unknown> = {
      protein: 22,
      carbs: 45,
      calories: 410,
      ...(invalidFat === undefined ? {} : { fat: invalidFat }),
    };
    const payload = {
      meals: [
        {
          mealId: "invalid-complete-set",
          description: "Invalid incomplete meal",
          mealDate: TEST_DATE,
          mealType: "Lunch",
          mealTime: "12:30",
          createdAt: "2026-09-20T12:30:00-07:00",
          itemCount: 1,
          items: [
            {
              food: "Invalid sandwich",
              portion: "one sandwich",
              gramWeight: 180,
              quantity: 1,
            },
          ],
          macros,
        },
      ],
    };

    const parseNormalizeAndWrite = async () => {
      const parsed = parseZivaMealPayload(payload, { expectedDate: TEST_DATE });
      const normalized = parsed.meals.map((meal) =>
        normalizeZivaMeal(meal, { userId, accountSubject: "subject-a" }),
      );
      return upsertZivaMealsForDate(context.db, userId, normalized);
    };

    await expect(parseNormalizeAndWrite()).rejects.toThrow();
    expect(await entriesFor(userId)).toEqual([]);
  });

  it("rolls back the complete date when the second meal violates the nutrient primary key", async () => {
    const original = makeMeal({ externalId: "meal:rollback-existing" });
    await upsertZivaMealsForDate(context.db, userId, [original]);
    const existing = (await entriesFor(userId))[0];
    if (!existing) throw new Error("Expected the existing rollback fixture entry");
    const originalNutrients = await nutrientsFor(existing.id);

    const changedExisting = makeMeal({
      ...original,
      date: "2026-09-22",
      meal: "dinner",
      foodName: "Should roll back",
      raw: { mealId: "rollback-existing", revision: 2 },
      nutrients: [
        { nutrientId: "calories", amount: 999 },
        { nutrientId: "protein", amount: 99 },
        { nutrientId: "carbohydrate", amount: 99 },
        { nutrientId: "fat", amount: 99 },
      ],
    });
    const invalidNew = makeMeal({
      externalId: "meal:rollback-new",
      date: "2026-09-22",
      nutrients: [
        { nutrientId: "calories", amount: 100 },
        { nutrientId: "calories", amount: 101 },
        { nutrientId: "protein", amount: 5 },
        { nutrientId: "carbohydrate", amount: 12 },
        { nutrientId: "fat", amount: 4 },
      ],
    });

    await expect(
      upsertZivaMealsForDate(context.db, userId, [changedExisting, invalidNew]),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    const after = await entriesFor(userId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: existing.id,
      externalId: original.externalId,
      date: TEST_DATE,
      meal: "lunch",
      foodName: "Ziva sandwich",
      raw: original.raw,
    });
    expect(await nutrientsFor(existing.id)).toEqual(originalNutrients);
    expect(after).not.toContainEqual(
      expect.objectContaining({ externalId: invalidNew.externalId }),
    );
  });

  it("preserves human nutrient, serving, and hidden overlays across a stable source update", async () => {
    const original = makeMeal({ externalId: "meal:human-overlays" });
    await upsertZivaMealsForDate(context.db, userId, [original]);
    const source = (await entriesFor(userId))[0];
    if (!source) throw new Error("Expected the source entry for human overlay coverage");

    const identityId = randomUUID();
    const changeId = randomUUID();
    const targetId = randomUUID();
    await context.db.insert(humanRecordIdentity).values({
      id: identityId,
      userId,
      domain: "nutrition.food",
      namespace: ZIVA_PROVIDER_ID,
      sourceKey: `external:${original.externalId}`,
    });
    await context.db.insert(humanRecordChange).values({
      id: changeId,
      userId,
      requestId: randomUUID(),
      requestHash: "a".repeat(64),
      kind: "update",
      channel: "web",
      schemaVersion: 1,
    });
    await context.db.insert(humanRecordTarget).values({
      id: targetId,
      userId,
      identityId,
      changeId,
      predecessorId: null,
      fields: {
        serving_unit: { operation: "set", value: "human bowl" },
        serving_weight_grams: { operation: "set", value: 777 },
      },
      deleted: true,
    });
    await context.db.insert(humanFoodNutrientDecision).values({
      targetId,
      identityId,
      userId,
      nutrientId: "protein",
      operation: "set",
      amount: 88,
    });

    const providerUpdate = makeMeal({
      ...original,
      servingUnit: "provider plate",
      servingWeightGrams: 250,
      raw: { mealId: "human-overlays", revision: 2 },
      nutrients: [
        { nutrientId: "calories", amount: 500 },
        { nutrientId: "protein", amount: 31 },
        { nutrientId: "carbohydrate", amount: 52 },
        { nutrientId: "fat", amount: 19 },
      ],
    });
    await upsertZivaMealsForDate(context.db, userId, [providerUpdate]);

    const updatedSource = (await entriesFor(userId))[0];
    expect(updatedSource).toMatchObject({
      id: source.id,
      servingUnit: "provider plate",
      servingWeightGrams: 250,
      raw: providerUpdate.raw,
    });
    expect(await nutrientsFor(source.id)).toContainEqual({ nutrientId: "protein", amount: 31 });

    const effectiveRows = await executeWithSchema(
      context.db,
      effectiveOverlayRowSchema,
      sql`
        SELECT
          effective.source_entry_id,
          effective.serving_unit,
          effective.serving_weight_grams,
          effective.source_serving_unit,
          effective.source_serving_weight_grams,
          effective.deleted,
          nutrient.amount AS protein,
          nutrient.source_amount AS source_protein
        FROM fitness.v_food_entry_effective AS effective
        INNER JOIN fitness.v_food_entry_effective_nutrient AS nutrient
          ON nutrient.source_entry_id = effective.source_entry_id
          AND nutrient.nutrient_id = 'protein'
        WHERE effective.user_id = ${userId}
          AND effective.provider_id = ${ZIVA_PROVIDER_ID}
          AND effective.external_id = ${original.externalId}
      `,
    );
    expect(effectiveRows).toEqual([
      {
        source_entry_id: source.id,
        serving_unit: "human bowl",
        serving_weight_grams: 777,
        source_serving_unit: "provider plate",
        source_serving_weight_grams: 250,
        deleted: true,
        protein: 88,
        source_protein: 31,
      },
    ]);
  });

  it("fails loudly when transaction support is unavailable", async () => {
    const nonTransactionalDatabase: SyncDatabase = {
      select: context.db.select,
      insert: context.db.insert,
      delete: context.db.delete,
      execute: context.db.execute,
    };

    await expect(
      upsertZivaMealsForDate(nonTransactionalDatabase, userId, [makeMeal()]),
    ).rejects.toThrow("Ziva nutrition sync requires a transactional database");
  });
});
