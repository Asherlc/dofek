import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { executeWithSchema } from "../db/execute-with-schema.ts";
import { nutrientAmountEntriesFromLegacyFields } from "../db/nutrient-columns.ts";
import {
  foodEntry,
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
const canonicalNutrientRowSchema = z.object({
  amount: z.coerce.number(),
  food_entry_id: z.string().nullable(),
  supplement_dose_event_id: z.string().nullable(),
});

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

  beforeEach(async () => {
    await ctx.db.delete(supplementDoseEvent);
    await ctx.db.delete(supplement);
    await ctx.db.delete(foodEntry);
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
      .where(eq(supplementDoseEvent.definitionId, primary.id))
      .orderBy(asc(supplementDoseEvent.scheduledDate));
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
      .where(eq(supplementDoseEvent.definitionId, definition.id))
      .orderBy(asc(supplementDoseEvent.recordedAt));
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

    const takenRows = await executeWithSchema(
      ctx.db,
      canonicalNutrientRowSchema,
      sql`SELECT amount, food_entry_id, supplement_dose_event_id
          FROM fitness.v_nutrition_canonical_nutrient
          WHERE user_id = ${PRIMARY_USER_ID}
            AND date = '2098-01-01'
            AND nutrient_id = 'vitamin_d'
          ORDER BY supplement_dose_event_id`,
    );
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

    const skippedRows = await executeWithSchema(
      ctx.db,
      canonicalNutrientRowSchema,
      sql`SELECT amount, food_entry_id, supplement_dose_event_id
          FROM fitness.v_nutrition_canonical_nutrient
          WHERE user_id = ${PRIMARY_USER_ID}
            AND date = '2098-01-01'
            AND nutrient_id = 'vitamin_d'`,
    );
    expect(skippedRows).toEqual([]);
  });
});
