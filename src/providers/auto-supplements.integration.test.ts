import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nutrientAmountEntriesFromLegacyFields } from "../db/nutrient-columns.ts";
import {
  foodEntry,
  foodEntryNutrient,
  supplement,
  supplementDefinition,
  supplementDefinitionNutrient,
  supplementDoseEvent,
} from "../db/schema/nutrition.ts";
import { userProfile } from "../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider } from "../db/tokens.ts";
import { AutoSupplementsProvider } from "./auto-supplements.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

const PRIMARY_USER_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_USER_ID = "22222222-2222-4222-8222-222222222222";

async function insertSupplementWithNutrition(
  db: TestContext["db"],
  values: {
    userId: string;
    name: string;
    effectiveFrom: string;
    effectiveTo?: string;
    meal?: "breakfast" | "lunch" | "dinner" | "snack" | "other";
  },
  nutrients: Record<string, number | null>,
) {
  const [schedule] = await db
    .insert(supplement)
    .values({
      userId: values.userId,
      sortOrder: 0,
    })
    .returning({
      id: supplement.id,
    });
  if (!schedule) throw new Error(`Failed to insert supplement schedule: ${values.name}`);
  const [definition] = await db
    .insert(supplementDefinition)
    .values({
      supplementId: schedule.id,
      name: values.name,
      effectiveFrom: values.effectiveFrom,
      effectiveTo: values.effectiveTo,
      meal: values.meal,
    })
    .returning({ id: supplementDefinition.id });
  if (!definition) throw new Error(`Failed to insert supplement definition: ${values.name}`);

  const nutrientEntries = nutrientAmountEntriesFromLegacyFields(nutrients);
  if (nutrientEntries.length > 0) {
    await db.insert(supplementDefinitionNutrient).values(
      nutrientEntries.map((nutrient) => ({
        definitionId: definition.id,
        nutrientId: nutrient.nutrientId,
        amount: nutrient.amount,
      })),
    );
  }
  return { id: definition.id, scheduleId: schedule.id };
}

function syncRun(ctx: TestContext, userId: string, sinceDate: string, untilDate: string): SyncRun {
  return new SyncRun({
    db: ctx.db,
    userId,
    window: SyncWindow.fromDateRange({ sinceDate, untilDate }),
  });
}

describe("AutoSupplementsProvider — dose events with Postgres", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ctx.db
      .insert(userProfile)
      .values([
        { id: PRIMARY_USER_ID, name: "Primary Supplement User" },
        { id: SECOND_USER_ID, name: "Second Supplement User" },
      ])
      .onConflictDoNothing();
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("materializes only the requested user's effective definitions inside the exact window", async () => {
    const primary = await insertSupplementWithNutrition(
      ctx.db,
      {
        userId: PRIMARY_USER_ID,
        name: "Scoped Vitamin D",
        effectiveFrom: "2099-01-02",
        effectiveTo: "2099-01-04",
      },
      { vitaminDMcg: 50 },
    );
    await insertSupplementWithNutrition(
      ctx.db,
      {
        userId: SECOND_USER_ID,
        name: "Other User Zinc",
        effectiveFrom: "2099-01-01",
      },
      { zincMg: 15 },
    );

    const provider = new AutoSupplementsProvider();
    const result = await provider.sync(syncRun(ctx, PRIMARY_USER_ID, "2099-01-01", "2099-01-05"));

    expect(result).toMatchObject({
      provider: "auto-supplements",
      errors: [],
      recordsSynced: 2,
    });
    const rows = await ctx.db
      .select()
      .from(supplementDoseEvent)
      .where(eq(supplementDoseEvent.userId, PRIMARY_USER_ID));
    expect(rows.map((row) => [row.definitionId, row.scheduledDate, row.status])).toEqual([
      [primary.id, "2099-01-02", "planned"],
      [primary.id, "2099-01-03", "planned"],
    ]);
    expect(
      await ctx.db
        .select()
        .from(supplementDoseEvent)
        .where(eq(supplementDoseEvent.userId, SECOND_USER_ID)),
    ).toEqual([]);
    expect(
      await ctx.db.select().from(foodEntry).where(eq(foodEntry.providerId, "auto-supplements")),
    ).toEqual([]);
  });

  it("is idempotent and never infers a past occurrence was taken", async () => {
    const definition = await insertSupplementWithNutrition(
      ctx.db,
      {
        userId: PRIMARY_USER_ID,
        name: "Historical Magnesium",
        effectiveFrom: "2020-01-01",
        effectiveTo: "2020-01-02",
      },
      { magnesiumMg: 400 },
    );
    const provider = new AutoSupplementsProvider();

    const first = await provider.sync(syncRun(ctx, PRIMARY_USER_ID, "2020-01-01", "2020-01-01"));
    const second = await provider.sync(syncRun(ctx, PRIMARY_USER_ID, "2020-01-01", "2020-01-01"));

    expect(first.recordsSynced).toBe(1);
    expect(second.recordsSynced).toBe(0);
    const rows = await ctx.db
      .select()
      .from(supplementDoseEvent)
      .where(eq(supplementDoseEvent.definitionId, definition.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("unknown");
  });

  it("advances a stale planned leaf to unknown without rewriting its history", async () => {
    const definition = await insertSupplementWithNutrition(
      ctx.db,
      {
        userId: PRIMARY_USER_ID,
        name: "Stale Plan",
        effectiveFrom: "2021-01-01",
        effectiveTo: "2021-01-02",
      },
      { magnesiumMg: 200 },
    );
    await ensureProvider(
      ctx.db,
      "auto-supplements",
      "Auto-Supplements",
      undefined,
      PRIMARY_USER_ID,
    );
    const [planned] = await ctx.db
      .insert(supplementDoseEvent)
      .values({
        userId: PRIMARY_USER_ID,
        supplementId: definition.scheduleId,
        definitionId: definition.id,
        providerId: "auto-supplements",
        externalId: "stale-planned",
        scheduledDate: "2021-01-01",
        status: "planned",
        recordedAt: new Date("2021-01-01T12:00:00Z"),
      })
      .returning({ id: supplementDoseEvent.id });
    if (!planned) throw new Error("Failed to seed planned supplement dose");

    const result = await new AutoSupplementsProvider().sync(
      syncRun(ctx, PRIMARY_USER_ID, "2021-01-01", "2021-01-01"),
    );

    expect(result.recordsSynced).toBe(1);
    const history = await ctx.db
      .select()
      .from(supplementDoseEvent)
      .where(eq(supplementDoseEvent.definitionId, definition.id));
    expect(history).toHaveLength(2);
    expect(history.find((event) => event.id === planned.id)?.status).toBe("planned");
    expect(history.find((event) => event.supersedesEventId === planned.id)?.status).toBe("unknown");
  });

  it("adds nutrients only while a taken event is the current leaf", async () => {
    const definition = await insertSupplementWithNutrition(
      ctx.db,
      {
        userId: PRIMARY_USER_ID,
        name: "Taken Vitamin D",
        effectiveFrom: "2098-01-01",
        effectiveTo: "2098-01-02",
        meal: "breakfast",
      },
      { vitaminDMcg: 25 },
    );
    await new AutoSupplementsProvider().sync(
      syncRun(ctx, PRIMARY_USER_ID, "2098-01-01", "2098-01-01"),
    );
    const [planned] = await ctx.db
      .select()
      .from(supplementDoseEvent)
      .where(eq(supplementDoseEvent.definitionId, definition.id));
    if (!planned) throw new Error("Failed to materialize planned supplement dose");

    const [taken] = await ctx.db
      .insert(supplementDoseEvent)
      .values({
        userId: PRIMARY_USER_ID,
        supplementId: definition.scheduleId,
        definitionId: definition.id,
        providerId: "auto-supplements",
        externalId: "taken-overlay",
        scheduledDate: planned.scheduledDate,
        status: "taken",
        supersedesEventId: planned.id,
        recordedAt: new Date("2098-01-01T12:00:00Z"),
      })
      .returning({ id: supplementDoseEvent.id });
    if (!taken) throw new Error("Failed to record taken supplement dose");

    const takenRows = await ctx.db.execute<{
      amount: number;
      food_entry_id: string | null;
      supplement_dose_event_id: string | null;
    }>(sql`SELECT amount, food_entry_id, supplement_dose_event_id
           FROM fitness.v_nutrition_canonical_nutrient
           WHERE user_id = ${PRIMARY_USER_ID}
             AND date = '2098-01-01'
             AND nutrient_id = 'vitamin_d'`);
    expect(takenRows).toEqual([
      {
        amount: 25,
        food_entry_id: null,
        supplement_dose_event_id: taken.id,
      },
    ]);

    await ctx.db.insert(supplementDoseEvent).values({
      userId: PRIMARY_USER_ID,
      supplementId: definition.scheduleId,
      definitionId: definition.id,
      providerId: "auto-supplements",
      externalId: "skipped-overlay",
      scheduledDate: planned.scheduledDate,
      status: "skipped",
      supersedesEventId: taken.id,
      recordedAt: new Date("2098-01-01T13:00:00Z"),
    });

    const skippedRows = await ctx.db.execute(
      sql`SELECT amount
          FROM fitness.v_nutrition_canonical_nutrient
          WHERE user_id = ${PRIMARY_USER_ID}
            AND date = '2098-01-01'
            AND nutrient_id = 'vitamin_d'`,
    );
    expect(skippedRows).toEqual([]);
  });

  it("migration cleanup removes only fictional auto-supplement foods and cascades nutrients", async () => {
    await ensureProvider(
      ctx.db,
      "fixture-food-source",
      "Fixture Food Source",
      undefined,
      PRIMARY_USER_ID,
    );
    const [fictional, real] = await ctx.db
      .insert(foodEntry)
      .values([
        {
          userId: PRIMARY_USER_ID,
          providerId: "auto-supplements",
          externalId: "fictional-food",
          date: "2022-01-01",
          foodName: "Fictional supplement food",
        },
        {
          userId: PRIMARY_USER_ID,
          providerId: "fixture-food-source",
          externalId: "real-food",
          date: "2022-01-01",
          foodName: "Real food",
        },
      ])
      .returning({ id: foodEntry.id, providerId: foodEntry.providerId });
    if (!fictional || !real) throw new Error("Failed to seed cleanup fixtures");
    await ctx.db.insert(foodEntryNutrient).values([
      { foodEntryId: fictional.id, nutrientId: "vitamin_d_mcg", amount: 10 },
      { foodEntryId: real.id, nutrientId: "vitamin_d_mcg", amount: 5 },
    ]);

    await ctx.db.execute(
      sql`DELETE FROM fitness.food_entry WHERE provider_id = 'auto-supplements'`,
    );

    expect(await ctx.db.select().from(foodEntry).where(eq(foodEntry.id, fictional.id))).toEqual([]);
    expect(
      await ctx.db
        .select()
        .from(foodEntryNutrient)
        .where(eq(foodEntryNutrient.foodEntryId, fictional.id)),
    ).toEqual([]);
    expect(
      await ctx.db
        .select()
        .from(foodEntry)
        .where(and(eq(foodEntry.id, real.id), eq(foodEntry.providerId, "fixture-food-source"))),
    ).toHaveLength(1);
    expect(
      await ctx.db
        .select()
        .from(foodEntryNutrient)
        .where(eq(foodEntryNutrient.foodEntryId, real.id)),
    ).toHaveLength(1);
  });
});
