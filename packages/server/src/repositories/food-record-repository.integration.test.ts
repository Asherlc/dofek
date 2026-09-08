import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { FoodRecordRepository } from "./food-record-repository.ts";
import { FoodRecordPreconditionError } from "./food-record-types.ts";

const userId = "70000000-0000-4000-8000-000000000001";
const otherUserId = "70000000-0000-4000-8000-000000000002";
const providerId = "food-record-test";

describe.sequential("FoodRecordRepository with Postgres", () => {
  let context: TestContext;
  let repository: FoodRecordRepository;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}, 'Food Record User'), (${otherUserId}, 'Other Food Record User')
    `);
    await ensureProvider(context.db, providerId, "Food Record Test", undefined, userId);
    repository = new FoodRecordRepository(context.db, userId);
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  async function addFood(input: {
    userId?: string;
    externalId?: string | null;
    date: string;
    foodName: string;
    description?: string;
    confirmed?: boolean;
    nutrients?: Record<string, number>;
  }) {
    const id = randomUUID();
    await context.db.execute(sql`
      INSERT INTO fitness.food_entry (
        id, user_id, provider_id, external_id, date, nutrition_grain, meal,
        food_name, food_description, category, number_of_units, serving_unit,
        serving_weight_grams, confirmed
      ) VALUES (
        ${id}, ${input.userId ?? userId}, ${providerId}, ${input.externalId ?? null},
        ${input.date}::date, 'itemized', 'breakfast', ${input.foodName},
        ${input.description ?? null}, 'breads_and_cereals', 1, 'serving', 100,
        ${input.confirmed ?? true}
      )
    `);
    const nutrients = Object.entries(input.nutrients ?? {});
    if (nutrients.length > 0) {
      await context.db.execute(sql`
        INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
        VALUES ${sql.join(
          nutrients.map(([nutrientId, amount]) => sql`(${id}, ${nutrientId}, ${amount})`),
          sql`, `,
        )}
      `);
    }
    return id;
  }

  async function appendChange(input: {
    identityId: string;
    predecessorVersion?: string | null;
    kind: "update" | "clear" | "delete" | "restore";
    recordedAt: string;
    fields?: Record<string, unknown>;
    deleted?: boolean | null;
    nutrient?: { id: string; operation: "set" | "clear"; amount: number | null };
  }) {
    const changeId = randomUUID();
    const version = randomUUID();
    await context.db.execute(sql`
      INSERT INTO fitness.human_record_change (
        id, user_id, request_id, request_hash, kind, channel, client_id,
        recorded_at, schema_version
      ) VALUES (
        ${changeId}, ${userId}, ${randomUUID()}, ${"c".repeat(64)}, ${input.kind},
        'mcp', 'integration-client', ${input.recordedAt}::timestamptz, 1
      )
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.human_record_target (
        id, user_id, identity_id, change_id, predecessor_id, fields, deleted
      ) VALUES (
        ${version}, ${userId}, ${input.identityId}, ${changeId},
        ${input.predecessorVersion ?? null}, ${JSON.stringify(input.fields ?? {})}::jsonb,
        ${input.deleted ?? null}
      )
    `);
    if (input.nutrient) {
      await context.db.execute(sql`
        INSERT INTO fitness.human_food_nutrient_decision (
          target_id, identity_id, user_id, nutrient_id, operation, amount
        ) VALUES (
          ${version}, ${input.identityId}, ${userId}, ${input.nutrient.id},
          ${input.nutrient.operation}, ${input.nutrient.amount}
        )
      `);
    }
    return { changeId, version };
  }

  it("lazily assigns identities while applying user, date, text, and visibility filters", async () => {
    const externalSourceId = await addFood({
      externalId: `oats-${randomUUID()}`,
      date: "2026-09-03",
      foodName: "Rolled Oats",
      description: "Breakfast bowl",
      nutrients: { calories: 300, protein: 10 },
    });
    const rowSourceId = await addFood({
      externalId: null,
      date: "2026-09-04",
      foodName: "Oat Bar",
      nutrients: { calories: 200 },
    });
    await addFood({
      externalId: `outside-${randomUUID()}`,
      date: "2026-08-31",
      foodName: "Old Oats",
    });
    await addFood({
      userId: otherUserId,
      externalId: `other-${randomUUID()}`,
      date: "2026-09-03",
      foodName: "Other Oats",
    });
    await addFood({
      externalId: `unconfirmed-${randomUUID()}`,
      date: "2026-09-03",
      foodName: "Unconfirmed Oats",
      confirmed: false,
    });

    const first = await repository.search({
      startDate: "2026-09-01",
      endDate: "2026-09-07",
      query: "oat",
      visibility: "visible",
      cursor: null,
      limit: 20,
    });

    expect(first.items).toHaveLength(2);
    expect(first.items.map((item) => item.sourceEntryId).sort()).toEqual(
      [externalSourceId, rowSourceId].sort(),
    );
    expect(first.items.find((item) => item.sourceEntryId === externalSourceId)).toMatchObject({
      modifiable: true,
      nutrients: { calories: 300, protein: 10 },
      sourceProvider: providerId,
      provenance: {
        foodName: { origin: "source", changeId: null },
        "nutrients.protein": { origin: "source", changeId: null },
      },
    });
    expect(first.items.find((item) => item.sourceEntryId === rowSourceId)).toMatchObject({
      modifiable: false,
      modificationUnavailableReason:
        "This food entry has no stable provider external ID and cannot be modified safely.",
    });

    const second = await repository.search({
      startDate: "2026-09-01",
      endDate: "2026-09-07",
      query: "oat",
      visibility: "visible",
      cursor: null,
      limit: 20,
    });
    expect(second.items.map((item) => item.recordId).sort()).toEqual(
      first.items.map((item) => item.recordId).sort(),
    );
  });

  it("paginates equal-date records without duplicates or omissions", async () => {
    const date = "2026-09-05";
    const sourceIds = await Promise.all(
      ["Cursor Alpha", "Cursor Beta", "Cursor Gamma"].map((foodName) =>
        addFood({ externalId: `${foodName}-${randomUUID()}`, date, foodName }),
      ),
    );

    const first = await repository.search({
      startDate: date,
      endDate: date,
      query: "Cursor",
      visibility: "all",
      cursor: null,
      limit: 2,
    });
    const second = await repository.search({
      startDate: date,
      endDate: date,
      query: "Cursor",
      visibility: "all",
      cursor: first.nextCursor,
      limit: 2,
    });

    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((item) => item.sourceEntryId).sort()).toEqual(
      sourceIds.sort(),
    );
    expect(new Set([...first.items, ...second.items].map((item) => item.recordId)).size).toBe(3);
  });

  it("paginates stable identities when provider replacements move dates within the range", async () => {
    const externalBySource = new Map<string, string>();
    for (const name of ["Moving Alpha", "Moving Beta", "Moving Gamma"]) {
      const externalId = randomUUID();
      const sourceId = await addFood({ externalId, date: "2026-08-15", foodName: name });
      externalBySource.set(sourceId, externalId);
    }
    const input = {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      query: "Moving",
      visibility: "all" as const,
      cursor: null,
      limit: 1,
    };
    const all = await repository.search({ ...input, limit: 100 });
    const first = await repository.search(input);
    const seen = first.items[0];
    const unseen = all.items.find((item) => item.recordId !== seen?.recordId);
    if (!seen || !unseen) throw new Error("Expected seen and unseen records");
    for (const [item, date] of [
      [seen, "2026-08-01"],
      [unseen, "2026-08-31"],
    ] as const) {
      await context.db.execute(
        sql`DELETE FROM fitness.food_entry WHERE id = ${item.sourceEntryId}`,
      );
      await addFood({
        externalId: externalBySource.get(item.sourceEntryId),
        date,
        foodName: "Moving replacement",
      });
    }
    const remaining = await repository.search({ ...input, cursor: first.nextCursor, limit: 100 });
    expect([...first.items, ...remaining.items].map((item) => item.recordId).sort()).toEqual(
      all.items.map((item) => item.recordId).sort(),
    );
    expect(remaining.nextCursor).toBeNull();
  });

  it("paginates history at exact Postgres microsecond precision and scopes cursor ownership", async () => {
    const sourceId = await addFood({
      externalId: randomUUID(),
      date: "2026-08-20",
      foodName: "Precise history",
    });
    const { identityId } = await repository.resolveStableIdentity(sourceId);
    const changes: string[] = [];
    let predecessorVersion: string | null = null;
    for (const fraction of ["000100", "000200", "000900"]) {
      const change = await appendChange({
        identityId,
        predecessorVersion,
        kind: "update",
        recordedAt: `2026-08-20T12:00:00.${fraction}Z`,
        fields: { food_name: { operation: "set", value: fraction } },
      });
      changes.push(change.changeId);
      predecessorVersion = change.version;
    }
    const first = await repository.history(identityId, null, 1);
    const second = await repository.history(identityId, first.nextCursor, 1);
    const third = await repository.history(identityId, second.nextCursor, 1);
    expect([...first.items, ...second.items, ...third.items].map((item) => item.changeId)).toEqual(
      changes.reverse(),
    );
    expect(third.nextCursor).toBeNull();

    const otherSource = await addFood({
      externalId: randomUUID(),
      date: "2026-08-20",
      foodName: "Other history",
    });
    const otherIdentity = await repository.resolveStableIdentity(otherSource);
    await appendChange({
      identityId: otherIdentity.identityId,
      kind: "delete",
      recordedAt: "2026-08-01T00:00:00Z",
      deleted: true,
    });
    await expect(
      repository.history(otherIdentity.identityId, first.nextCursor, 1),
    ).resolves.toMatchObject({ items: [], nextCursor: null });
    await expect(
      new FoodRecordRepository(context.db, otherUserId).history(identityId, first.nextCursor, 1),
    ).resolves.toMatchObject({ items: [], nextCursor: null });
  });

  it("returns deleted detail with human provenance and ordered history", async () => {
    const sourceEntryId = await addFood({
      externalId: `history-${randomUUID()}`,
      date: "2026-09-06",
      foodName: "Provider Name",
      nutrients: { protein: 8 },
    });
    const { identityId } = await repository.resolveStableIdentity(sourceEntryId);
    const update = await appendChange({
      identityId,
      kind: "update",
      recordedAt: "2026-09-06T10:00:00.000Z",
      fields: { food_name: { operation: "set", value: "Human Name" } },
      nutrient: { id: "protein", operation: "set", amount: 15 },
    });
    const deletion = await appendChange({
      identityId,
      predecessorVersion: update.version,
      kind: "delete",
      recordedAt: "2026-09-06T11:00:00.000Z",
      deleted: true,
    });

    await expect(repository.get(identityId)).resolves.toMatchObject({
      recordId: identityId,
      sourceEntryId,
      version: deletion.version,
      deleted: true,
      foodName: "Human Name",
      nutrients: { protein: 15 },
      provenance: {
        foodName: { origin: "human", changeId: update.changeId },
        deleted: { origin: "human", changeId: deletion.changeId },
        "nutrients.protein": { origin: "human", changeId: update.changeId },
      },
    });

    const visible = await repository.search({
      startDate: "2026-09-06",
      endDate: "2026-09-06",
      query: "Human Name",
      visibility: "visible",
      cursor: null,
      limit: 20,
    });
    const deleted = await repository.search({
      startDate: "2026-09-06",
      endDate: "2026-09-06",
      query: "Human Name",
      visibility: "deleted",
      cursor: null,
      limit: 20,
    });
    const all = await repository.search({
      startDate: "2026-09-06",
      endDate: "2026-09-06",
      query: "Human Name",
      visibility: "all",
      cursor: null,
      limit: 20,
    });
    expect(visible.items).toEqual([]);
    expect(deleted.items.map((item) => item.recordId)).toContain(identityId);
    expect(all.items.map((item) => item.recordId)).toContain(identityId);

    const firstHistoryPage = await repository.history(identityId, null, 1);
    const secondHistoryPage = await repository.history(identityId, firstHistoryPage.nextCursor, 1);
    expect(firstHistoryPage.items[0]).toMatchObject({
      changeId: deletion.changeId,
      version: deletion.version,
      predecessorVersion: update.version,
      kind: "delete",
      deleted: true,
    });
    expect(secondHistoryPage.items[0]).toMatchObject({
      changeId: update.changeId,
      version: update.version,
      predecessorVersion: null,
      kind: "update",
      fields: { food_name: { operation: "set", value: "Human Name" } },
      nutrients: { protein: { operation: "set", amount: 15 } },
    });
  });

  it("attributes source values restored by scalar and nutrient clears to the clearing change", async () => {
    const sourceEntryId = await addFood({
      externalId: `clear-${randomUUID()}`,
      date: "2026-09-06",
      foodName: "Clear Provenance Food",
      description: "Provider description",
      nutrients: { protein: 8 },
    });
    const { identityId } = await repository.resolveStableIdentity(sourceEntryId);
    const update = await appendChange({
      identityId,
      kind: "update",
      recordedAt: "2026-09-06T12:00:00.000Z",
      fields: { food_description: { operation: "set", value: "Human description" } },
      nutrient: { id: "protein", operation: "set", amount: 15 },
    });
    const clear = await appendChange({
      identityId,
      predecessorVersion: update.version,
      kind: "clear",
      recordedAt: "2026-09-06T13:00:00.000Z",
      fields: { food_description: { operation: "clear" } },
      nutrient: { id: "protein", operation: "clear", amount: null },
    });

    await expect(repository.get(identityId)).resolves.toMatchObject({
      foodDescription: "Provider description",
      nutrients: { protein: 8 },
      provenance: {
        foodDescription: { origin: "human", changeId: clear.changeId },
        "nutrients.protein": { origin: "human", changeId: clear.changeId },
      },
    });

    await expect(repository.history(identityId, null, 1)).resolves.toMatchObject({
      items: [
        {
          changeId: clear.changeId,
          kind: "clear",
          fields: { food_description: { operation: "clear" } },
          nutrients: { protein: { operation: "clear", amount: null } },
        },
      ],
    });
  });

  it("resolves one stable external identity and rejects row-key modification", async () => {
    const externalSourceId = await addFood({
      externalId: `stable-${randomUUID()}`,
      date: "2026-09-07",
      foodName: "Stable Food",
    });
    const first = await repository.resolveStableIdentity(externalSourceId);
    const second = await repository.resolveStableIdentity(externalSourceId);
    expect(second).toEqual(first);

    const rowSourceId = await addFood({
      externalId: null,
      date: "2026-09-07",
      foodName: "Unstable Food",
    });
    await expect(repository.resolveStableIdentity(rowSourceId)).rejects.toEqual(
      expect.objectContaining({
        name: FoodRecordPreconditionError.name,
        sourceEntryId: rowSourceId,
      }),
    );
  });
});
