import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { FoodRecordRepository } from "../repositories/food-record-repository.ts";
import type { FoodRecordSearchInput } from "../repositories/food-record-types.ts";
import { FoodRepository } from "../repositories/food-repository.ts";
import { FoodRecordService } from "./food-record-service.ts";

const userId = "81000000-0000-4000-8000-000000000001";
const otherUserId = "81000000-0000-4000-8000-000000000002";
const providerId = "food-command-test";
const hash = "a".repeat(64);
const explainPlanRowSchema = z.object({ "QUERY PLAN": z.string() });
const changeCountRowSchema = z.object({ count: z.coerce.number().int().nonnegative() });

describe.sequential("FoodRecordService with Postgres", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}, 'Food Command User'), (${otherUserId}, 'Other Food Command User')
    `);
    await ensureProvider(context.db, providerId, "Food Command Test", undefined, userId);
    await ensureProvider(context.db, providerId, "Food Command Test", undefined, otherUserId);
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  function service(
    forUser = userId,
    clientId = "token:integration-client",
    invalidateNutritionCaches: (userId: string) => Promise<void> = async () => undefined,
  ) {
    return new FoodRecordService({
      database: context.db,
      userId: forUser,
      actor: { channel: "mcp", clientId },
      invalidateNutritionCaches,
    });
  }

  async function addProviderFood(
    input: {
      userId?: string;
      externalId?: string | null;
      date?: string;
      name?: string;
      nutrients?: Record<string, number>;
      providerId?: string;
    } = {},
  ) {
    const sourceEntryId = randomUUID();
    await context.db.execute(sql`
      INSERT INTO fitness.food_entry (
        id, user_id, provider_id, external_id, date, nutrition_grain, meal,
        food_name, food_description, category, number_of_units, serving_unit,
        serving_weight_grams, confirmed
      ) VALUES (
        ${sourceEntryId}, ${input.userId ?? userId}, ${input.providerId ?? providerId},
        ${input.externalId === undefined ? randomUUID() : input.externalId},
        ${input.date ?? "2026-09-07"}::date, 'itemized', 'breakfast',
        ${input.name ?? "Provider oats"}, 'Provider description', 'breads_and_cereals',
        1, 'bowl', 80, true
      )
    `);
    const nutrients = Object.entries(input.nutrients ?? { calories: 300, protein: 10 });
    if (nutrients.length > 0) {
      await context.db.execute(sql`
        INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
        VALUES ${sql.join(
          nutrients.map(
            ([nutrientId, amount]) => sql`(${sourceEntryId}, ${nutrientId}, ${amount})`,
          ),
          sql`, `,
        )}
      `);
    }
    return sourceEntryId;
  }

  async function assertProductionLikeSourceLookupPlan(recordId: string): Promise<void> {
    const plan = await executeWithSchema(
      context.db,
      explainPlanRowSchema,
      sql`
        EXPLAIN (COSTS OFF)
        SELECT identity.id
        FROM fitness.human_record_identity AS identity
        INNER JOIN LATERAL (
          SELECT entry.id
          FROM fitness.food_entry AS entry
          WHERE entry.user_id = identity.user_id
            AND entry.provider_id = identity.namespace
            AND entry.confirmed = TRUE
            AND (
              (identity.source_key LIKE 'external:%'
                AND entry.external_id = SUBSTRING(identity.source_key FROM 10))
              OR (identity.source_key LIKE 'row:%'
                AND entry.id = SUBSTRING(identity.source_key FROM 5)::uuid)
            )
          ORDER BY entry.created_at DESC, entry.id DESC
          LIMIT 1
        ) AS source ON TRUE
        WHERE identity.user_id = ${userId}
          AND identity.id = ${recordId}::uuid
          AND identity.domain = 'nutrition.food'
        FOR UPDATE OF identity
      `,
    );
    const planText = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(planText).toContain("BitmapOr");
    expect(planText).toContain("food_entry_pkey");
  }

  it("creates, updates, clears, deletes, restores, replays, and preserves raw rows", async () => {
    const commands = service();
    const createRequest = randomUUID();
    const created = await commands.create({
      requestId: createRequest,
      date: "2026-09-07",
      meal: "breakfast",
      foodName: "Human oats",
      foodDescription: "Initial description",
      category: "breads_and_cereals",
      numberOfUnits: 1,
      servingUnit: "bowl",
      servingWeightGrams: 80,
      nutrients: { calories: 300, protein: 10, sodium: 100 },
    });
    expect(created).toMatchObject({
      affectedDates: ["2026-09-07"],
      record: {
        version: expect.any(String),
        foodName: "Human oats",
        servingUnit: "bowl",
        servingWeightGrams: 80,
        nutrients: { calories: 300, protein: 10, sodium: 100 },
      },
    });

    const updateRequest = randomUUID();
    const updated = await commands.update({
      recordId: created.record.recordId,
      expectedVersion: created.record.version,
      requestId: updateRequest,
      set: { date: "2026-09-08", foodDescription: null },
      clear: ["meal"],
      nutrientSet: { protein: 15, sodium: null },
      nutrientClear: ["calories"],
    });
    expect(updated).toMatchObject({
      affectedDates: ["2026-09-07", "2026-09-08"],
      record: {
        date: "2026-09-08",
        meal: "breakfast",
        foodDescription: null,
        nutrients: { calories: 300, protein: 15, sodium: null },
      },
    });

    const deleted = await commands.delete({
      recordId: created.record.recordId,
      expectedVersion: updated.record.version,
      requestId: randomUUID(),
    });
    expect(deleted.record.deleted).toBe(true);
    const totalsWhileDeleted = await context.db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM fitness.v_nutrition_canonical_nutrient
      WHERE user_id = ${userId} AND date = '2026-09-08'::date
    `);
    expect(totalsWhileDeleted).toEqual([{ count: 0 }]);

    const restored = await commands.restore({
      recordId: created.record.recordId,
      expectedVersion: deleted.record.version,
      requestId: randomUUID(),
    });
    expect(restored.record).toMatchObject({ deleted: false, nutrients: { protein: 15 } });

    const replay = await commands.update({
      recordId: created.record.recordId,
      expectedVersion: created.record.version,
      requestId: updateRequest,
      set: { date: "2026-09-08", foodDescription: null },
      clear: ["meal"],
      nutrientSet: { sodium: null, protein: 15 },
      nutrientClear: ["calories"],
    });
    expect(replay).toEqual({
      operation: { ...updated.operation, replayed: true },
      record: restored.record,
      affectedDates: [],
    });

    const history = await new FoodRecordRepository(context.db, userId).history(
      created.record.recordId,
      null,
      20,
    );
    expect(history.items.map((item) => item.kind)).toEqual([
      "restore",
      "delete",
      "update",
      "create",
    ]);
    const raw = await context.db.execute(sql`
      SELECT date::text AS date, meal, food_description, serving_unit,
             serving_weight_grams::real AS serving_weight_grams
      FROM fitness.food_entry WHERE id = ${created.record.sourceEntryId}
    `);
    expect(raw).toEqual([
      {
        date: "2026-09-07",
        meal: "breakfast",
        food_description: "Initial description",
        serving_unit: "bowl",
        serving_weight_grams: 80,
      },
    ]);
  });

  it("deletes a root-version external record once and hides it from visible search", async () => {
    const date = "2026-09-04";
    const dofekProviderId = "dofek";
    await new FoodRepository(context.db, userId, "UTC").ensureDofekProvider();
    const sourceEntryId = await addProviderFood({
      date,
      name: "Banana",
      externalId: `entry:${randomUUID()}`,
      providerId: dofekProviderId,
    });
    const repository = new FoodRecordRepository(context.db, userId);
    const search = {
      startDate: date,
      endDate: date,
      query: "Banana",
      visibility: "visible",
      cursor: null,
      limit: 100,
    } satisfies FoodRecordSearchInput;
    const before = await repository.search(search);
    const banana = before.items.find((item) => item.sourceEntryId === sourceEntryId);

    expect(before.nextCursor).toBeNull();
    expect(banana).toMatchObject({
      sourceEntryId,
      version: null,
      deleted: false,
      modifiable: true,
      date,
      foodName: "Banana",
      sourceProvider: dofekProviderId,
    });
    if (!banana) throw new Error("Expected the provider banana in the visible search results");

    await context.db.execute(sql`
      INSERT INTO fitness.food_entry (
        id, user_id, provider_id, external_id, date, nutrition_grain, meal,
        food_name, food_description, category, number_of_units, serving_unit,
        serving_weight_grams, confirmed
      )
      SELECT
        gen_random_uuid(), ${userId}, ${dofekProviderId},
        ${`history:${randomUUID()}:`} || sequence::text,
        ${date}::date, 'itemized', 'breakfast', 'Other food', 'Provider description',
        'breads_and_cereals', 1, 'bowl', 80, TRUE
      FROM generate_series(1, 500) AS sequence
    `);
    await context.db.execute(sql`ANALYZE fitness.food_entry`);
    await assertProductionLikeSourceLookupPlan(banana.recordId);

    const command = {
      recordId: banana.recordId,
      expectedVersion: null,
      requestId: randomUUID(),
    };
    const deleted = await service().delete(command);

    expect(deleted).toMatchObject({
      operation: { replayed: false, resultingVersion: expect.any(String) },
      record: { recordId: banana.recordId, sourceEntryId, deleted: true },
      affectedDates: [date],
    });
    expect((await repository.search(search)).items).not.toContainEqual(
      expect.objectContaining({ recordId: banana.recordId }),
    );

    const replay = await service().delete(command);
    expect(replay).toEqual({
      operation: { ...deleted.operation, replayed: true },
      record: deleted.record,
      affectedDates: [],
    });
    expect(
      await executeWithSchema(
        context.db,
        changeCountRowSchema,
        sql`
          SELECT COUNT(*)::int AS count
          FROM fitness.human_record_change
          WHERE user_id = ${userId} AND request_id = ${command.requestId}::uuid
        `,
      ),
    ).toEqual([{ count: 1 }]);

    const restored = await service().restore({
      recordId: banana.recordId,
      expectedVersion: deleted.record.version,
      requestId: randomUUID(),
    });
    expect(restored.record).toMatchObject({ recordId: banana.recordId, deleted: false });
    expect((await repository.search(search)).items).toContainEqual(
      expect.objectContaining({ recordId: banana.recordId, deleted: false }),
    );

    const updated = await service().update({
      recordId: banana.recordId,
      expectedVersion: restored.record.version,
      requestId: randomUUID(),
      set: { foodName: "Banana, updated" },
      clear: [],
      nutrientSet: {},
      nutrientClear: [],
    });
    expect(updated.record).toMatchObject({
      recordId: banana.recordId,
      foodName: "Banana, updated",
    });
  });

  it("keeps absent nutrient clears from changing legacy daily aggregate classification", async () => {
    const date = "2026-07-01";
    const sourceId = await addProviderFood({ date, nutrients: { calories: 300 } });
    const proteinSourceId = await addProviderFood({ date, nutrients: { protein: 10 } });
    await context.db.execute(sql`UPDATE fitness.food_entry SET nutrition_grain = NULL,
      meal = NULL, food_name = NULL WHERE id IN (${sourceId}, ${proteinSourceId})`);
    const { identityId } = await new FoodRecordRepository(context.db, userId).resolveStableIdentity(
      sourceId,
    );
    const before = await context.db.execute(sql`SELECT calories, resolution_status
      FROM fitness.v_nutrition_daily WHERE user_id = ${userId} AND date = ${date}::date`);
    expect(before).toEqual([{ calories: 300, resolution_status: "available" }]);
    for (const nutrientSet of [{}, { sodium: null }]) {
      const current = await new FoodRecordRepository(context.db, userId).get(identityId);
      await service().update({
        recordId: identityId,
        expectedVersion: current?.version ?? null,
        requestId: randomUUID(),
        set: {},
        clear: [],
        nutrientSet,
        nutrientClear: Object.keys(nutrientSet).length === 0 ? ["sodium"] : [],
      });
      expect(
        await context.db.execute(sql`SELECT calories, resolution_status
        FROM fitness.v_nutrition_daily WHERE user_id = ${userId} AND date = ${date}::date`),
      ).toEqual(before);
      expect(
        await context.db.execute(sql`SELECT nutrient_count, effective_grain
        FROM fitness.v_nutrition_entry_classification WHERE id = ${sourceId}`),
      ).toEqual([{ nutrient_count: 1, effective_grain: "daily_aggregate" }]);
    }
  });

  it("keeps HealthKit write-back on raw facts after effective food corrections", async () => {
    const date = "2026-07-02";
    const commands = service();
    const created = await commands.create({
      requestId: randomUUID(),
      date,
      foodName: "Raw food",
      nutrients: { calories: 300, protein: 10, carbohydrate: 20, fat: 5 },
    });
    const food = new FoodRepository(context.db, userId, "UTC");
    const rawExport = await food.healthKitWriteBackEntries(date, date);
    expect(rawExport).toEqual([
      {
        id: created.record.sourceEntryId,
        date,
        food_name: "Raw food",
        calories: 300,
        protein_g: 10,
        carbs_g: 20,
        fat_g: 5,
      },
    ]);
    const corrected = await commands.update({
      recordId: created.record.recordId,
      expectedVersion: created.record.version,
      requestId: randomUUID(),
      set: { foodName: "Corrected food", date: "2026-07-03" },
      clear: [],
      nutrientSet: { calories: 450, protein: null, carbohydrate: 30, fat: 8 },
      nutrientClear: [],
    });
    expect(corrected.record).toMatchObject({
      foodName: "Corrected food",
      date: "2026-07-03",
      nutrients: { calories: 450, protein: null, carbohydrate: 30, fat: 8 },
    });
    expect(
      await context.db.execute(sql`SELECT calories FROM fitness.v_nutrition_daily
      WHERE user_id = ${userId} AND date = '2026-07-03'::date`),
    ).toEqual([{ calories: 450 }]);
    expect(await food.healthKitWriteBackEntries(date, date)).toEqual(rawExport);
    expect(await food.healthKitWriteBackEntries("2026-07-03", "2026-07-03")).toEqual([]);
    expect(
      await new FoodRepository(context.db, otherUserId, "UTC").healthKitWriteBackEntries(
        date,
        date,
      ),
    ).toEqual([]);
    await commands.delete({
      recordId: created.record.recordId,
      expectedVersion: corrected.record.version,
      requestId: randomUUID(),
    });
    expect(await food.healthKitWriteBackEntries(date, date)).toEqual(rawExport);
  });

  it("replays creates inside a read-only transaction without provider setup or other writes", async () => {
    const command = {
      requestId: randomUUID(),
      date: "2026-07-04",
      foodName: "Replay food",
      nutrients: { calories: 200 },
    };
    const created = await service().create(command);
    const replay = await context.db.transaction(async (transaction) => {
      await transaction.execute(sql`SET TRANSACTION READ ONLY`);
      return new FoodRecordService({
        database: transaction,
        userId,
        actor: { channel: "mcp", clientId: "token:integration-client" },
        invalidateNutritionCaches: async () => undefined,
      }).create(command);
    });
    expect(replay).toEqual({
      operation: { ...created.operation, replayed: true },
      record: created.record,
      affectedDates: [],
    });
  });

  it("conflicts on changed request bodies and concurrent writes from one version", async () => {
    const sourceEntryId = await addProviderFood();
    const repository = new FoodRecordRepository(context.db, userId);
    const { identityId } = await repository.resolveStableIdentity(sourceEntryId);
    const commands = service();
    const reusedRequest = randomUUID();
    const first = await commands.update({
      recordId: identityId,
      expectedVersion: null,
      requestId: reusedRequest,
      set: { meal: "dinner" },
      clear: [],
      nutrientSet: {},
      nutrientClear: [],
    });
    await expect(
      commands.update({
        recordId: identityId,
        expectedVersion: null,
        requestId: reusedRequest,
        set: { meal: "lunch" },
        clear: [],
        nutrientSet: {},
        nutrientClear: [],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const concurrent = await Promise.allSettled([
      commands.update({
        recordId: identityId,
        expectedVersion: first.record.version,
        requestId: randomUUID(),
        set: { meal: "lunch" },
        clear: [],
        nutrientSet: {},
        nutrientClear: [],
      }),
      commands.update({
        recordId: identityId,
        expectedVersion: first.record.version,
        requestId: randomUUID(),
        set: { meal: "breakfast" },
        clear: [],
        nutrientSet: {},
        nutrientClear: [],
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(concurrent.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "CONFLICT" },
    });
  });

  it("keeps decisions across provider row replacement while rejecting row and cross-user IDs", async () => {
    const externalId = randomUUID();
    const sourceEntryId = await addProviderFood({ externalId });
    const repository = new FoodRecordRepository(context.db, userId);
    const { identityId } = await repository.resolveStableIdentity(sourceEntryId);
    const updated = await service().update({
      recordId: identityId,
      expectedVersion: null,
      requestId: randomUUID(),
      set: { foodName: "Human name" },
      clear: [],
      nutrientSet: { protein: 20 },
      nutrientClear: [],
    });

    await context.db.execute(sql`DELETE FROM fitness.food_entry WHERE id = ${sourceEntryId}`);
    await addProviderFood({ externalId, name: "Replacement name", nutrients: { protein: 12 } });
    await expect(repository.get(identityId)).resolves.toMatchObject({
      version: updated.record.version,
      foodName: "Human name",
      nutrients: { protein: 20 },
    });

    const rowSourceId = await addProviderFood({ externalId: null });
    const rowRecord = await repository.search({
      startDate: "2026-09-07",
      endDate: "2026-09-07",
      query: null,
      visibility: "all",
      cursor: null,
      limit: 100,
    });
    const rowIdentity = rowRecord.items.find((item) => item.sourceEntryId === rowSourceId);
    await expect(
      service().delete({
        recordId: rowIdentity?.recordId ?? randomUUID(),
        expectedVersion: null,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      service(otherUserId).delete({
        recordId: identityId,
        expectedVersion: updated.record.version,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("replays a stable receipt with current replacement facts and no new side effects", async () => {
    const externalId = randomUUID();
    const sourceEntryId = await addProviderFood({
      externalId,
      date: "2026-09-04",
      name: "Original source",
      nutrients: { calories: 300, protein: 10 },
    });
    const repository = new FoodRecordRepository(context.db, userId);
    const { identityId } = await repository.resolveStableIdentity(sourceEntryId);
    const invalidator = vi.fn(async () => undefined);
    const commands = service(userId, "token:replacement-replay", invalidator);
    const updateRequest = randomUUID();
    const updated = await commands.update({
      recordId: identityId,
      expectedVersion: null,
      requestId: updateRequest,
      set: { meal: "dinner" },
      clear: [],
      nutrientSet: { protein: 20 },
      nutrientClear: [],
    });
    expect(updated).toMatchObject({
      operation: { replayed: false },
      record: {
        sourceEntryId,
        date: "2026-09-04",
        foodName: "Original source",
        nutrients: { calories: 300, protein: 20 },
      },
      affectedDates: ["2026-09-04"],
    });

    await context.db.execute(sql`DELETE FROM fitness.food_entry WHERE id = ${sourceEntryId}`);
    const replacementId = await addProviderFood({
      externalId,
      date: "2026-09-09",
      name: "Replacement source",
      nutrients: { calories: 450, protein: 12 },
    });
    const beforeReplay = await context.db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM fitness.human_record_change
      WHERE user_id = ${userId} AND request_id = ${updateRequest}
    `);

    const replay = await commands.update({
      recordId: identityId,
      expectedVersion: null,
      requestId: updateRequest,
      set: { meal: "dinner" },
      clear: [],
      nutrientSet: { protein: 20 },
      nutrientClear: [],
    });

    expect(replay.operation).toEqual({ ...updated.operation, replayed: true });
    expect(replay.affectedDates).toEqual([]);
    expect(replay.record).toMatchObject({
      sourceEntryId: replacementId,
      date: "2026-09-09",
      meal: "dinner",
      foodName: "Replacement source",
      nutrients: { calories: 450, protein: 20 },
    });
    expect(
      await context.db.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM fitness.human_record_change
        WHERE user_id = ${userId} AND request_id = ${updateRequest}
      `),
    ).toEqual(beforeReplay);
    expect(invalidator).toHaveBeenCalledOnce();
  });

  it("reports the stored identity's current head for changed create request reuse", async () => {
    const commands = service(userId, "token:create-conflict");
    const createRequest = randomUUID();
    const created = await commands.create({
      requestId: createRequest,
      date: "2026-09-05",
      foodName: "Create conflict source",
      nutrients: {},
    });
    const deleted = await commands.delete({
      recordId: created.record.recordId,
      expectedVersion: created.record.version,
      requestId: randomUUID(),
    });

    await expect(
      commands.create({
        requestId: createRequest,
        date: "2026-09-05",
        foodName: "Changed create body",
        nutrients: {},
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        recordId: created.record.recordId,
        currentVersion: deleted.record.version,
      },
    });
  });

  it("reports the current head when create reuses a non-create request ID", async () => {
    const sourceEntryId = await addProviderFood({ name: "Cross operation source" });
    const { identityId } = await new FoodRecordRepository(context.db, userId).resolveStableIdentity(
      sourceEntryId,
    );
    const commands = service(userId, "token:cross-operation-conflict");
    const updateRequest = randomUUID();
    const updated = await commands.update({
      recordId: identityId,
      expectedVersion: null,
      requestId: updateRequest,
      set: { meal: "dinner" },
      clear: [],
      nutrientSet: {},
      nutrientClear: [],
    });
    const deleted = await commands.delete({
      recordId: identityId,
      expectedVersion: updated.record.version,
      requestId: randomUUID(),
    });

    await expect(
      commands.create({
        requestId: updateRequest,
        date: "2026-09-05",
        foodName: "Cross operation create",
        nutrients: {},
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { recordId: identityId, currentVersion: deleted.record.version },
    });
  });

  it("rejects commands while account erasure is active", async () => {
    const fencedUserId = randomUUID();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${fencedUserId}, 'Fenced User')`,
    );
    const erasureRequest = randomUUID();
    await context.db.execute(sql`INSERT INTO fitness.account_erasure_request
      (id, user_id, user_hash, user_hash_key_id, write_fence_hash, status_token_hash,
       replay_retained_until, completion_deadline)
      VALUES (${erasureRequest}, ${fencedUserId}, ${hash}, 'test', ${randomUUID()},
              ${randomUUID()}, now() + interval '1 day', now() + interval '2 days')`);

    await expect(
      service(fencedUserId).create({
        requestId: randomUUID(),
        date: "2026-09-07",
        foodName: "Blocked food",
        nutrients: {},
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_ERASURE_ACTIVE" });
  });
});
