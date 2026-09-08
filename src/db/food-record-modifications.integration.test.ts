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
});
