import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { erasePostgresAccount } from "../account-erasure/postgres-erasure.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { executeWithSchema } from "./typed-sql.ts";

let ctx: TestContext;
let userId: string;
let otherUserId: string;
const hash = "a".repeat(64);
const decisionRowSchema = z.object({
  amount: z.number().nullable(),
  operation: z.enum(["set", "clear"]),
  target_id: z.uuid(),
});
const idRowSchema = z.object({ target_id: z.uuid() });
const effectiveFoodRowSchema = z.object({
  record_id: z.uuid(),
  source_entry_id: z.uuid(),
  date: z.string(),
  meal: z.string().nullable(),
  food_name: z.string().nullable(),
  food_description: z.string().nullable(),
  category: z.string().nullable(),
  number_of_units: z.coerce.number().nullable(),
  serving_unit: z.string().nullable(),
  serving_weight_grams: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
});
const rawFoodRowSchema = z.object({
  meal: z.string().nullable(),
  protein_g: z.coerce.number().nullable(),
});

async function identity(owner = userId): Promise<string> {
  const id = randomUUID();
  await ctx.db.execute(sql`INSERT INTO fitness.human_record_identity
    (id, user_id, domain, namespace, source_key)
    VALUES (${id}, ${owner}, 'food', 'provider:test', ${randomUUID()})`);
  return id;
}

async function change(owner = userId): Promise<string> {
  const id = randomUUID();
  await ctx.db.execute(sql`INSERT INTO fitness.human_record_change
    (id, user_id, request_id, request_hash, kind, channel, schema_version)
    VALUES (${id}, ${owner}, ${randomUUID()}, ${hash}, 'update', 'web', 1)`);
  return id;
}

async function target(
  identityId: string,
  predecessorId: string | null = null,
  owner = userId,
): Promise<string> {
  const id = randomUUID();
  await ctx.db.execute(sql`INSERT INTO fitness.human_record_target
    (id, user_id, identity_id, change_id, predecessor_id)
    VALUES (${id}, ${owner}, ${identityId}, ${await change(owner)}, ${predecessorId})`);
  return id;
}

async function insertDecision(
  targetId: string,
  identityId: string,
  nutrientId: string,
  operation: "set" | "clear",
  amount: number | null,
  owner = userId,
): Promise<void> {
  await ctx.db.execute(sql`INSERT INTO fitness.human_food_nutrient_decision
    (target_id, identity_id, user_id, nutrient_id, operation, amount)
    VALUES (${targetId}, ${identityId}, ${owner}, ${nutrientId}, ${operation}, ${amount})`);
}

async function effectiveNutrient(identityId: string, nutrientId: string) {
  const rows = await executeWithSchema(
    ctx.db,
    decisionRowSchema,
    sql`SELECT operation, amount, target_id
      FROM fitness.v_human_food_nutrient_decision
      WHERE identity_id = ${identityId} AND nutrient_id = ${nutrientId}`,
  );
  return rows[0];
}

async function decisionsFor(owner: string) {
  return executeWithSchema(
    ctx.db,
    idRowSchema,
    sql`SELECT target_id
      FROM fitness.human_food_nutrient_decision
      WHERE user_id = ${owner}
      ORDER BY target_id`,
  );
}

async function addEffectiveFoodFixture() {
  const sourceEntryId = randomUUID();
  const externalId = randomUUID();
  const identityId = randomUUID();
  const providerId = "food-modification-test";
  await ctx.db.execute(sql`INSERT INTO fitness.provider (id, name)
    VALUES (${providerId}, 'Food modification test') ON CONFLICT (id) DO NOTHING`);
  await ctx.db.execute(sql`INSERT INTO fitness.food_entry
    (id, user_id, provider_id, external_id, date, nutrition_grain, meal, food_name,
     food_description, category, number_of_units, serving_unit, serving_weight_grams)
    VALUES (${sourceEntryId}, ${userId}, ${providerId}, ${externalId}, '2026-09-01', 'itemized',
      'lunch', 'Raw lunch', 'Raw description', 'other', 1, 'serving', 100)`);
  await ctx.db.execute(sql`INSERT INTO fitness.food_entry_nutrient
    (food_entry_id, nutrient_id, amount)
    VALUES (${sourceEntryId}, 'protein', 20)`);
  await ctx.db.execute(sql`INSERT INTO fitness.human_record_identity
    (id, user_id, domain, namespace, source_key)
    VALUES (${identityId}, ${userId}, 'nutrition.food', ${providerId}, ${`external:${externalId}`})`);
  return { externalId, identityId, providerId, sourceEntryId };
}

async function appendFoodDecision(input: {
  identityId: string;
  predecessorId?: string | null;
  fields?: Record<string, { operation: "set" | "clear"; value?: unknown }>;
  deleted?: boolean | null;
  nutrient?: { operation: "set" | "clear"; amount: number | null };
}) {
  const targetId = randomUUID();
  await ctx.db.execute(sql`INSERT INTO fitness.human_record_target
    (id, user_id, identity_id, change_id, predecessor_id, fields, deleted)
    VALUES (${targetId}, ${userId}, ${input.identityId}, ${await change()},
      ${input.predecessorId ?? null}, ${JSON.stringify(input.fields ?? {})}::jsonb,
      ${input.deleted ?? null})`);
  if (input.nutrient) {
    await insertDecision(
      targetId,
      input.identityId,
      "protein",
      input.nutrient.operation,
      input.nutrient.amount,
    );
  }
  return targetId;
}

async function effectiveFood(identityId: string) {
  const rows = await executeWithSchema(
    ctx.db,
    effectiveFoodRowSchema,
    sql`SELECT
      effective.record_id,
      effective.source_entry_id,
      effective.date,
      effective.meal,
      effective.food_name,
      effective.food_description,
      effective.category,
      effective.number_of_units,
      effective.serving_unit,
      effective.serving_weight_grams,
      nutrient.amount AS protein_g
    FROM fitness.v_food_entry_effective AS effective
    LEFT JOIN fitness.v_food_entry_effective_nutrient AS nutrient
      ON nutrient.source_entry_id = effective.source_entry_id
      AND nutrient.nutrient_id = 'protein'
    WHERE effective.record_id = ${identityId}`,
  );
  return rows[0];
}

async function rawFood(sourceEntryId: string) {
  const rows = await executeWithSchema(
    ctx.db,
    rawFoodRowSchema,
    sql`SELECT food.meal, nutrient.amount AS protein_g
      FROM fitness.food_entry AS food
      LEFT JOIN fitness.food_entry_nutrient AS nutrient
        ON nutrient.food_entry_id = food.id AND nutrient.nutrient_id = 'protein'
      WHERE food.id = ${sourceEntryId}`,
  );
  return rows[0];
}

beforeAll(async () => {
  ctx = await setupTestDatabase();
}, 120_000);

beforeEach(async () => {
  userId = randomUUID();
  otherUserId = randomUUID();
  await ctx.db.execute(sql`INSERT INTO fitness.user_profile (id, name)
    VALUES (${userId}, 'Food decision owner'), (${otherUserId}, 'Other food decision owner')`);
});

afterAll(async () => {
  await ctx?.cleanup();
});

describe("human food nutrient decisions", () => {
  it("stores set, explicit-null, and clear nutrient decisions", async () => {
    const record = await identity();
    const firstTarget = await target(record);
    const secondTarget = await target(record, firstTarget);
    const thirdTarget = await target(record, secondTarget);

    await insertDecision(firstTarget, record, "protein", "set", 30);
    expect(await effectiveNutrient(record, "protein")).toEqual({
      operation: "set",
      amount: 30,
      target_id: firstTarget,
    });
    await insertDecision(secondTarget, record, "protein", "set", null);
    expect(await effectiveNutrient(record, "protein")).toEqual({
      operation: "set",
      amount: null,
      target_id: secondTarget,
    });
    await insertDecision(thirdTarget, record, "protein", "clear", null);

    const stored = await executeWithSchema(
      ctx.db,
      decisionRowSchema,
      sql`SELECT operation, amount, target_id
        FROM fitness.human_food_nutrient_decision
        WHERE identity_id = ${record}
        ORDER BY CASE target_id
          WHEN ${firstTarget} THEN 1
          WHEN ${secondTarget} THEN 2
          ELSE 3
        END`,
    );
    expect(stored).toEqual([
      { operation: "set", amount: 30, target_id: firstTarget },
      { operation: "set", amount: null, target_id: secondTarget },
      { operation: "clear", amount: null, target_id: thirdTarget },
    ]);
    expect(await effectiveNutrient(record, "protein")).toEqual({
      operation: "clear",
      amount: null,
      target_id: thirdTarget,
    });
  });

  it("rejects negative amounts, clear-with-value, duplicate nutrients, and cross-user targets", async () => {
    const record = await identity();
    const targetId = await target(record);
    await expect(insertDecision(targetId, record, "protein", "set", -1)).rejects.toMatchObject({
      cause: { code: "23514" },
    });
    await expect(insertDecision(targetId, record, "protein", "clear", 1)).rejects.toMatchObject({
      cause: { code: "23514" },
    });
    await insertDecision(targetId, record, "protein", "set", 30);
    await expect(insertDecision(targetId, record, "protein", "set", 31)).rejects.toMatchObject({
      cause: { code: "23505" },
    });
    await expect(
      insertDecision(targetId, record, "fat", "set", 1, otherUserId),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("keeps nutrient decisions append-only except during verified account erasure", async () => {
    const record = await identity();
    const targetId = await target(record);
    await insertDecision(targetId, record, "protein", "set", 30);
    const otherRecord = await identity(otherUserId);
    const otherTarget = await target(otherRecord, null, otherUserId);
    await insertDecision(otherTarget, otherRecord, "protein", "set", 20, otherUserId);

    await expect(
      ctx.db.execute(sql`UPDATE fitness.human_food_nutrient_decision
        SET amount = 31 WHERE target_id = ${targetId}`),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
    await expect(
      ctx.db.execute(sql`DELETE FROM fitness.human_food_nutrient_decision
        WHERE target_id = ${targetId}`),
    ).rejects.toMatchObject({ cause: { code: "55000" } });

    const request = randomUUID();
    await ctx.db.execute(sql`INSERT INTO fitness.account_erasure_request
      (id, user_id, user_hash, user_hash_key_id, write_fence_hash, status_token_hash,
       replay_retained_until, completion_deadline)
      VALUES (${request}, ${userId}, ${hash}, 'test', ${randomUUID()}, ${randomUUID()}, now(), now())`);
    await erasePostgresAccount(ctx.db, request, userId);

    expect(await decisionsFor(userId)).toEqual([]);
    expect(await decisionsFor(otherUserId)).toEqual([{ target_id: otherTarget }]);
  });

  it("applies scalar and nutrient decisions without changing raw source rows", async () => {
    const fixture = await addEffectiveFoodFixture();
    await appendFoodDecision({
      identityId: fixture.identityId,
      fields: {
        date: { operation: "set", value: "2026-09-02" },
        meal: { operation: "set", value: "dinner" },
        food_name: { operation: "set", value: "Corrected dinner" },
        food_description: { operation: "set", value: "Corrected description" },
        category: { operation: "set", value: "snacks" },
        number_of_units: { operation: "set", value: 2 },
        serving_unit: { operation: "set", value: "bowl" },
        serving_weight_grams: { operation: "set", value: 250 },
      },
      nutrient: { operation: "set", amount: 30 },
    });

    expect(await effectiveFood(fixture.identityId)).toEqual({
      record_id: fixture.identityId,
      source_entry_id: fixture.sourceEntryId,
      date: "2026-09-02",
      meal: "dinner",
      food_name: "Corrected dinner",
      food_description: "Corrected description",
      category: "snacks",
      number_of_units: 2,
      serving_unit: "bowl",
      serving_weight_grams: 250,
      protein_g: 30,
    });
    expect(await rawFood(fixture.sourceEntryId)).toEqual({ meal: "lunch", protein_g: 20 });
  });

  it("distinguishes explicit null from clearing a nutrient override", async () => {
    const fixture = await addEffectiveFoodFixture();
    const suppressed = await appendFoodDecision({
      identityId: fixture.identityId,
      nutrient: { operation: "set", amount: null },
    });
    expect((await effectiveFood(fixture.identityId))?.protein_g).toBeNull();

    await appendFoodDecision({
      identityId: fixture.identityId,
      predecessorId: suppressed,
      nutrient: { operation: "clear", amount: null },
    });
    expect((await effectiveFood(fixture.identityId))?.protein_g).toBe(20);
  });

  it("keeps decisions after replacement under the same provider external key", async () => {
    const fixture = await addEffectiveFoodFixture();
    await appendFoodDecision({
      identityId: fixture.identityId,
      fields: { meal: { operation: "set", value: "dinner" } },
    });

    await ctx.db.execute(sql`DELETE FROM fitness.food_entry WHERE id = ${fixture.sourceEntryId}`);
    const replacementId = randomUUID();
    await ctx.db.execute(sql`INSERT INTO fitness.food_entry
      (id, user_id, provider_id, external_id, date, nutrition_grain, meal, food_name)
      VALUES (${replacementId}, ${userId}, ${fixture.providerId}, ${fixture.externalId},
        '2026-09-03', 'itemized', 'breakfast', 'Replacement source row')`);
    await ctx.db.execute(sql`INSERT INTO fitness.food_entry_nutrient
      (food_entry_id, nutrient_id, amount) VALUES (${replacementId}, 'protein', 25)`);

    expect(await effectiveFood(fixture.identityId)).toEqual(
      expect.objectContaining({
        record_id: fixture.identityId,
        source_entry_id: replacementId,
        meal: "dinner",
        protein_g: 25,
      }),
    );
  });
});
