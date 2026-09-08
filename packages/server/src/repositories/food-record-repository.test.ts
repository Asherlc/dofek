import type { Database } from "dofek/db";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AppendFoodRecordChangeInput,
  FoodRecordConflictError,
  FoodRecordNotFoundError,
  FoodRecordRepository,
} from "./food-record-repository.ts";
import { type EffectiveFoodRecord, FoodRecordPreconditionError } from "./food-record-types.ts";

const foodRepositoryMocks = vi.hoisted(() => ({
  create: vi.fn(),
  ensureDofekProvider: vi.fn(),
}));

vi.mock("./food-repository.ts", () => ({
  FoodRepository: class {
    create = foodRepositoryMocks.create;
    ensureDofekProvider = foodRepositoryMocks.ensureDofekProvider;
  },
}));

const userId = "10000000-0000-4000-8000-000000000001";
const recordId = "20000000-0000-4000-8000-000000000001";
const sourceEntryId = "30000000-0000-4000-8000-000000000001";
const version = "40000000-0000-4000-8000-000000000001";
const changeId = "50000000-0000-4000-8000-000000000001";
const dialect = new PgDialect();

function recordRow(overrides: Record<string, unknown> = {}) {
  return {
    record_id: recordId,
    source_entry_id: sourceEntryId,
    version,
    deleted: false,
    modifiable: true,
    modification_unavailable_reason: null,
    date: "2026-09-03",
    source_date: "2026-09-02",
    meal: "breakfast",
    food_name: "Oats",
    food_description: "Rolled oats",
    category: "grain",
    number_of_units: 1,
    serving_unit: "bowl",
    serving_weight_grams: 80,
    nutrients: { calories: 310, protein: 12, sodium: null },
    nutrient_provenance: {
      calories: { origin: "source", changeId: null },
      protein: { origin: "human", changeId },
      sodium: { origin: "human", changeId },
    },
    source_provider: "cronometer",
    date_operation: "set",
    date_change_id: changeId,
    meal_operation: null,
    meal_change_id: null,
    food_name_operation: null,
    food_name_change_id: null,
    food_description_operation: null,
    food_description_change_id: null,
    category_operation: null,
    category_change_id: null,
    number_of_units_operation: null,
    number_of_units_change_id: null,
    serving_unit_operation: null,
    serving_unit_change_id: null,
    serving_weight_grams_operation: null,
    serving_weight_grams_change_id: null,
    visibility_change_id: null,
    ...overrides,
  };
}

const expectedRecord: EffectiveFoodRecord = {
  recordId,
  sourceEntryId,
  version,
  deleted: false,
  modifiable: true,
  modificationUnavailableReason: null,
  date: "2026-09-03",
  meal: "breakfast",
  foodName: "Oats",
  foodDescription: "Rolled oats",
  category: "grain",
  numberOfUnits: 1,
  servingUnit: "bowl",
  servingWeightGrams: 80,
  nutrients: { calories: 310, protein: 12, sodium: null },
  sourceProvider: "cronometer",
  provenance: {
    date: { origin: "human", changeId },
    meal: { origin: "source", changeId: null },
    foodName: { origin: "source", changeId: null },
    foodDescription: { origin: "source", changeId: null },
    category: { origin: "source", changeId: null },
    numberOfUnits: { origin: "source", changeId: null },
    servingUnit: { origin: "source", changeId: null },
    servingWeightGrams: { origin: "source", changeId: null },
    deleted: { origin: "source", changeId: null },
    "nutrients.calories": { origin: "source", changeId: null },
    "nutrients.protein": { origin: "human", changeId },
    "nutrients.sodium": { origin: "human", changeId },
  },
};

function queryDetails(query: Parameters<Database["execute"]>[0]) {
  if (!(query instanceof SQL)) throw new Error("Expected a Drizzle SQL query");
  return dialect.sqlToQuery(query);
}

function makeRepository(responses: Record<string, unknown>[][]) {
  const execute = vi.fn<Database["execute"]>(async () => responses.shift() ?? []);
  const transaction = vi.fn<Database["transaction"]>(async (operation) =>
    operation(Object.assign(Object.create(null), { execute })),
  );
  const database = { execute, transaction } satisfies Pick<Database, "execute" | "transaction">;
  return { execute, repository: new FoodRecordRepository(database, userId), transaction };
}

function storedRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    change_id: changeId,
    request_id: "60000000-0000-4000-8000-000000000020",
    request_hash: "d".repeat(64),
    kind: "update",
    client_id: "token:client-1",
    identity_id: recordId,
    target_version: version,
    predecessor_version: null,
    ...overrides,
  };
}

function lockedHead(overrides: Record<string, unknown> = {}) {
  return {
    identity_id: recordId,
    source_entry_id: sourceEntryId,
    current_version: version,
    modifiable: true,
    ...overrides,
  };
}

function appendInput(
  overrides: Partial<AppendFoodRecordChangeInput> = {},
): AppendFoodRecordChangeInput {
  return {
    identityId: recordId,
    expectedVersion: version,
    requestId: "60000000-0000-4000-8000-000000000020",
    requestHash: "d".repeat(64),
    kind: "update",
    actor: { channel: "mcp", clientId: "token:client-1" },
    fields: {},
    nutrients: {},
    deleted: null,
    ...overrides,
  };
}

describe("FoodRecordRepository", () => {
  beforeEach(() => {
    foodRepositoryMocks.create.mockReset();
    foodRepositoryMocks.ensureDofekProvider.mockReset();
    foodRepositoryMocks.ensureDofekProvider.mockResolvedValue(undefined);
  });

  it("searches user-owned effective records and maps nutrients and provenance", async () => {
    const { execute, repository, transaction } = makeRepository([[], [recordRow()]]);

    await expect(
      repository.search({
        startDate: "2026-09-01",
        endDate: "2026-09-07",
        query: "oats",
        visibility: "visible",
        cursor: null,
        limit: 20,
      }),
    ).resolves.toEqual({ items: [expectedRecord], nextCursor: null });

    expect(transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
    const identityQuery = queryDetails(execute.mock.calls[0]?.[0]);
    const searchQuery = queryDetails(execute.mock.calls[1]?.[0]);
    expect(identityQuery.sql).toContain("INSERT INTO fitness.human_record_identity");
    expect(identityQuery.sql).toContain("ON CONFLICT");
    expect(identityQuery.params).toEqual(
      expect.arrayContaining([userId, "2026-09-01", "2026-09-07", "%oats%"]),
    );
    expect(searchQuery.sql).toContain("effective.user_id =");
    expect(searchQuery.sql).toContain("effective.deleted = FALSE");
    expect(searchQuery.params).toEqual(
      expect.arrayContaining([userId, "2026-09-01", "2026-09-07", "%oats%", 21]),
    );
  });

  it("uses only the stable record ID for cursor pagination", async () => {
    const secondRecordId = "20000000-0000-4000-8000-000000000002";
    const { execute, repository } = makeRepository([
      [],
      [recordRow(), recordRow({ record_id: secondRecordId })],
    ]);

    const result = await repository.search({
      startDate: "2026-09-01",
      endDate: "2026-09-07",
      query: null,
      visibility: "all",
      cursor: { recordId: "20000000-0000-4000-8000-000000000099" },
      limit: 1,
    });

    expect(result).toEqual({
      items: [expectedRecord],
      nextCursor: { recordId },
    });
    const searchQuery = queryDetails(execute.mock.calls[1]?.[0]);
    expect(searchQuery.sql).toContain("effective.source_date");
    expect(searchQuery.sql).toContain("effective.record_id");
    expect(searchQuery.params).toEqual(
      expect.arrayContaining(["20000000-0000-4000-8000-000000000099", 2]),
    );
  });

  it("does not emit a search cursor when the result count exactly equals the limit", async () => {
    const { repository } = makeRepository([[], [recordRow()]]);

    await expect(
      repository.search({
        startDate: "2026-09-01",
        endDate: "2026-09-07",
        query: null,
        visibility: "all",
        cursor: null,
        limit: 1,
      }),
    ).resolves.toEqual({ items: [expectedRecord], nextCursor: null });
  });

  it("uses explicit deleted and all visibility predicates", async () => {
    const deleted = makeRepository([[], []]);
    await deleted.repository.search({
      startDate: "2026-09-01",
      endDate: "2026-09-07",
      query: null,
      visibility: "deleted",
      cursor: null,
      limit: 20,
    });
    expect(queryDetails(deleted.execute.mock.calls[1]?.[0]).sql).toContain(
      "effective.deleted = TRUE",
    );

    const all = makeRepository([[], []]);
    await all.repository.search({
      startDate: "2026-09-01",
      endDate: "2026-09-07",
      query: null,
      visibility: "all",
      cursor: null,
      limit: 20,
    });
    const allSql = queryDetails(all.execute.mock.calls[1]?.[0]).sql;
    expect(allSql).not.toContain("effective.deleted = TRUE");
    expect(allSql).not.toContain("effective.deleted = FALSE");
  });

  it("returns deleted record detail scoped by user and stable record ID", async () => {
    const { execute, repository } = makeRepository([
      [recordRow({ deleted: true, visibility_change_id: changeId })],
    ]);

    await expect(repository.get(recordId)).resolves.toEqual({
      ...expectedRecord,
      deleted: true,
      provenance: {
        ...expectedRecord.provenance,
        deleted: { origin: "human", changeId },
      },
    });
    const detailQuery = queryDetails(execute.mock.calls[0]?.[0]);
    expect(detailQuery.params).toEqual(expect.arrayContaining([userId, recordId]));
    expect(detailQuery.sql).not.toContain("deleted = FALSE");
  });

  it("returns null for missing detail and supports source and explicit version snapshots", async () => {
    const missing = makeRepository([[]]);
    await expect(missing.repository.get(recordId)).resolves.toBeNull();

    const source = makeRepository([[recordRow({ version: null })]]);
    await expect(source.repository.getAtVersion(recordId, null)).resolves.toEqual({
      ...expectedRecord,
      version: null,
    });
    expect(queryDetails(source.execute.mock.calls[0]?.[0]).params).toEqual(
      expect.arrayContaining([userId, recordId, null]),
    );

    const snapshot = makeRepository([[recordRow()]]);
    await expect(snapshot.repository.getAtVersion(recordId, version)).resolves.toEqual(
      expectedRecord,
    );
    expect(queryDetails(snapshot.execute.mock.calls[0]?.[0]).params).toEqual(
      expect.arrayContaining([recordId, version]),
    );
  });

  it("maps history newest-first and emits an opaque continuation cursor", async () => {
    const firstChangeId = "50000000-0000-4000-8000-000000000010";
    const secondChangeId = "50000000-0000-4000-8000-000000000011";
    const firstVersion = "40000000-0000-4000-8000-000000000010";
    const { repository } = makeRepository([
      [
        {
          change_id: firstChangeId,
          request_id: "60000000-0000-4000-8000-000000000010",
          version: firstVersion,
          predecessor_version: null,
          kind: "update",
          channel: "mcp",
          client_id: "client-1",
          recorded_at: "2026-09-07T12:00:00.000Z",
          effective_at: null,
          schema_version: "1",
          undo_change_id: null,
          deleted: null,
          fields: { food_name: { operation: "set", value: "Oats" } },
          nutrients: { protein: { operation: "set", amount: 12 } },
        },
        {
          change_id: secondChangeId,
          request_id: "60000000-0000-4000-8000-000000000011",
          version: "40000000-0000-4000-8000-000000000011",
          predecessor_version: firstVersion,
          kind: "delete",
          channel: "mcp",
          client_id: "client-1",
          recorded_at: "2026-09-06T12:00:00.000Z",
          effective_at: null,
          schema_version: 1,
          undo_change_id: null,
          deleted: true,
          fields: {},
          nutrients: {},
        },
      ],
    ]);

    const result = await repository.history(recordId, null, 1);

    expect(result.items).toEqual([
      {
        changeId: firstChangeId,
        requestId: "60000000-0000-4000-8000-000000000010",
        version: firstVersion,
        predecessorVersion: null,
        kind: "update",
        channel: "mcp",
        clientId: "client-1",
        recordedAt: "2026-09-07T12:00:00.000Z",
        effectiveAt: null,
        schemaVersion: 1,
        undoChangeId: null,
        deleted: null,
        fields: { food_name: { operation: "set", value: "Oats" } },
        nutrients: { protein: { operation: "set", amount: 12 } },
      },
    ]);
    expect(result.recordId).toBe(recordId);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(JSON.parse(Buffer.from(result.nextCursor ?? "", "base64url").toString("utf8"))).toEqual({
      changeId: firstChangeId,
    });

    const nextPage = makeRepository([[]]);
    await nextPage.repository.history(recordId, result.nextCursor, 1);
    const historyQuery = queryDetails(nextPage.execute.mock.calls[0]?.[0]);
    expect(historyQuery.params).toEqual(
      expect.arrayContaining([userId, recordId, firstChangeId, 2]),
    );
  });

  it("returns no history cursor at the exact page size and validates the page limit", async () => {
    const oneRow = {
      change_id: changeId,
      request_id: "60000000-0000-4000-8000-000000000010",
      version,
      predecessor_version: null,
      kind: "update",
      channel: "mcp",
      client_id: null,
      recorded_at: "2026-09-07T12:00:00.000Z",
      effective_at: null,
      schema_version: 1,
      undo_change_id: null,
      deleted: null,
      fields: {},
      nutrients: {},
    };
    const exact = makeRepository([[oneRow]]);
    await expect(exact.repository.history(recordId, null, 1)).resolves.toMatchObject({
      nextCursor: null,
    });

    await expect(makeRepository([]).repository.history(recordId, null, 0)).rejects.toThrow();
    await expect(makeRepository([]).repository.history(recordId, null, 101)).rejects.toThrow();
  });

  it("resolves an external identity idempotently and rejects row-key sources", async () => {
    const { execute, repository } = makeRepository([
      [{ source_entry_id: sourceEntryId, provider_id: "cronometer", external_id: "meal-1" }],
      [],
      [{ identity_id: recordId, source_entry_id: sourceEntryId }],
    ]);

    await expect(repository.resolveStableIdentity(sourceEntryId)).resolves.toEqual({
      identityId: recordId,
      sourceEntryId,
    });
    const insertQuery = queryDetails(execute.mock.calls[1]?.[0]);
    expect(insertQuery.sql).toContain("ON CONFLICT");
    expect(insertQuery.params).toEqual(
      expect.arrayContaining([userId, "cronometer", "external:meal-1"]),
    );
    const resolveQuery = queryDetails(execute.mock.calls[2]?.[0]);
    expect(resolveQuery.params).toEqual(
      expect.arrayContaining([userId, "cronometer", "external:meal-1", sourceEntryId]),
    );

    const unstable = makeRepository([
      [{ source_entry_id: sourceEntryId, provider_id: "manual", external_id: null }],
    ]);
    await expect(unstable.repository.resolveStableIdentity(sourceEntryId)).rejects.toEqual(
      expect.objectContaining({
        name: FoodRecordPreconditionError.name,
        sourceEntryId,
      }),
    );
    expect(unstable.execute).toHaveBeenCalledOnce();
  });

  it("fails explicitly when a stable identity cannot be resolved", async () => {
    await expect(
      makeRepository([[]]).repository.resolveStableIdentity(sourceEntryId),
    ).rejects.toThrow("User-owned confirmed food source entry was not found");

    const whitespace = makeRepository([
      [{ source_entry_id: sourceEntryId, provider_id: "manual", external_id: "   " }],
    ]);
    await expect(whitespace.repository.resolveStableIdentity(sourceEntryId)).rejects.toBeInstanceOf(
      FoodRecordPreconditionError,
    );

    const missingIdentity = makeRepository([
      [{ source_entry_id: sourceEntryId, provider_id: "cronometer", external_id: "meal-1" }],
      [],
      [],
    ]);
    await expect(missingIdentity.repository.resolveStableIdentity(sourceEntryId)).rejects.toThrow(
      "Stable food record identity could not be resolved",
    );
  });

  it("loads stored request attribution and target metadata for replay", async () => {
    const requestId = "60000000-0000-4000-8000-000000000020";
    const { execute, repository } = makeRepository([
      [
        {
          change_id: changeId,
          request_id: requestId,
          request_hash: "d".repeat(64),
          kind: "delete",
          client_id: "token:client-1",
          identity_id: recordId,
          target_version: version,
          predecessor_version: null,
        },
      ],
    ]);

    await expect(repository.findRequest(requestId)).resolves.toEqual({
      changeId,
      requestId,
      requestHash: "d".repeat(64),
      kind: "delete",
      actor: { channel: "mcp", clientId: "token:client-1" },
      identityId: recordId,
      version,
      predecessorVersion: null,
    });
    expect(queryDetails(execute.mock.calls[0]?.[0]).params).toEqual(
      expect.arrayContaining([userId, requestId]),
    );
  });

  it("returns null when a request ID has not been stored", async () => {
    await expect(
      makeRepository([[]]).repository.findRequest("60000000-0000-4000-8000-000000000020"),
    ).resolves.toBeNull();
  });

  it("creates a source and identity before appending the initial version", async () => {
    const requestId = "60000000-0000-4000-8000-000000000023";
    const nextVersion = "40000000-0000-4000-8000-000000000023";
    foodRepositoryMocks.create.mockResolvedValue({ id: sourceEntryId });
    const { execute, repository } = makeRepository([
      [],
      [],
      [{ identity_id: recordId }],
      [lockedHead({ current_version: null })],
      [],
      [{ change_id: changeId }],
      [{ version: nextVersion }],
    ]);

    await expect(
      repository.createSourceAndIdentity({
        requestId,
        requestHash: "c".repeat(64),
        actor: { channel: "mcp", clientId: "token:client-1" },
        externalId: "mcp:request-1",
        date: "2026-09-07",
        foodName: "Oats",
        nutrients: { protein: 12 },
      }),
    ).resolves.toMatchObject({
      identityId: recordId,
      sourceEntryId,
      version: nextVersion,
      replayed: false,
    });

    expect(foodRepositoryMocks.ensureDofekProvider).toHaveBeenCalledOnce();
    expect(foodRepositoryMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "mcp:request-1", nutrients: { protein: 12 } }),
    );
    expect(execute.mock.calls.map((call) => queryDetails(call[0]).sql).join("\n")).toContain(
      "INSERT INTO fitness.human_record_identity",
    );
  });

  it("returns the original create receipt when the request is replayed", async () => {
    const requestId = "60000000-0000-4000-8000-000000000020";
    const { repository } = makeRepository([
      [storedRequestRow({ request_id: requestId, kind: "create" })],
      [recordRow()],
    ]);

    await expect(
      repository.createSourceAndIdentity({
        requestId,
        requestHash: "d".repeat(64),
        actor: { channel: "mcp", clientId: "token:client-1" },
        externalId: "mcp:request-1",
        date: "2026-09-07",
        foodName: "Oats",
        nutrients: {},
      }),
    ).resolves.toEqual({
      changeId,
      identityId: recordId,
      sourceEntryId,
      version,
      predecessorVersion: null,
      requestHash: "d".repeat(64),
      kind: "create",
      actor: { channel: "mcp", clientId: "token:client-1" },
      replayed: true,
    });
    expect(foodRepositoryMocks.create).not.toHaveBeenCalled();
  });

  it("rejects a changed create replay and a replay whose source disappeared", async () => {
    const requestId = "60000000-0000-4000-8000-000000000020";
    const changed = makeRepository([
      [storedRequestRow({ request_id: requestId, kind: "create" })],
      [{ current_version: version }],
    ]);
    await expect(
      changed.repository.createSourceAndIdentity({
        requestId,
        requestHash: "e".repeat(64),
        actor: { channel: "mcp", clientId: "token:client-1" },
        externalId: "mcp:request-1",
        date: "2026-09-07",
        foodName: "Oats",
        nutrients: {},
      }),
    ).rejects.toMatchObject({ name: FoodRecordConflictError.name, currentVersion: version });

    const disappeared = makeRepository([
      [storedRequestRow({ request_id: requestId, kind: "create" })],
      [],
    ]);
    await expect(
      disappeared.repository.createSourceAndIdentity({
        requestId,
        requestHash: "d".repeat(64),
        actor: { channel: "mcp", clientId: "token:client-1" },
        externalId: "mcp:request-1",
        date: "2026-09-07",
        foodName: "Oats",
        nutrients: {},
      }),
    ).rejects.toThrow("Replayed food record source could not be resolved");
  });

  it("fails explicitly when a newly created identity cannot be locked", async () => {
    const repository = makeRepository([[], [], []]).repository;
    await expect(
      repository.createSourceAndIdentity({
        requestId: "60000000-0000-4000-8000-000000000023",
        requestHash: "c".repeat(64),
        actor: { channel: "mcp", clientId: "token:client-1" },
        externalId: "mcp:request-1",
        date: "2026-09-07",
        foodName: "Oats",
        nutrients: {},
      }),
    ).rejects.toThrow("Created food record identity could not be locked");
  });

  it("locks the identity before checking request reuse and appends decisions", async () => {
    const requestId = "60000000-0000-4000-8000-000000000021";
    const nextVersion = "40000000-0000-4000-8000-000000000021";
    const { execute, repository } = makeRepository([
      [
        {
          identity_id: recordId,
          source_entry_id: sourceEntryId,
          current_version: null,
          modifiable: true,
        },
      ],
      [],
      [{ change_id: changeId }],
      [{ version: nextVersion }],
      [],
    ]);

    await expect(
      repository.appendChange({
        identityId: recordId,
        expectedVersion: null,
        requestId,
        requestHash: "e".repeat(64),
        kind: "update",
        actor: { channel: "mcp", clientId: "token:client-1" },
        fields: { meal: { operation: "set", value: "dinner" } },
        nutrients: { protein: { operation: "set", amount: 14 } },
        deleted: null,
      }),
    ).resolves.toEqual({
      changeId,
      identityId: recordId,
      sourceEntryId,
      version: nextVersion,
      predecessorVersion: null,
      requestHash: "e".repeat(64),
      kind: "update",
      actor: { channel: "mcp", clientId: "token:client-1" },
      replayed: false,
    });

    const queries = execute.mock.calls.map((call) => queryDetails(call[0]));
    expect(queries[0]?.sql).toContain("FOR UPDATE");
    expect(queries[1]?.sql).toContain("human_record_change");
    expect(queries[2]?.sql).toContain("INSERT INTO fitness.human_record_change");
    expect(queries[2]?.params).toEqual(
      expect.arrayContaining([userId, requestId, "e".repeat(64), "update", "token:client-1"]),
    );
    expect(queries[3]?.sql).toContain("INSERT INTO fitness.human_record_target");
    expect(queries[4]?.sql).toContain("INSERT INTO fitness.human_food_nutrient_decision");
  });

  it("rejects stale nullable expected versions with the locked current version", async () => {
    const { repository } = makeRepository([
      [
        {
          identity_id: recordId,
          source_entry_id: sourceEntryId,
          current_version: version,
          modifiable: true,
        },
      ],
      [],
    ]);

    await expect(
      repository.appendChange({
        identityId: recordId,
        expectedVersion: null,
        requestId: "60000000-0000-4000-8000-000000000022",
        requestHash: "f".repeat(64),
        kind: "delete",
        actor: { channel: "mcp", clientId: "token:client-1" },
        fields: {},
        nutrients: {},
        deleted: true,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: FoodRecordConflictError.name,
        recordId,
        currentVersion: version,
      }),
    );
  });

  it("rejects missing and unmodifiable record identities before writing", async () => {
    await expect(
      makeRepository([[]]).repository.appendChange(appendInput()),
    ).rejects.toBeInstanceOf(FoodRecordNotFoundError);
    await expect(
      makeRepository([[lockedHead({ modifiable: false })]]).repository.appendChange(appendInput()),
    ).rejects.toMatchObject({
      name: FoodRecordPreconditionError.name,
      sourceEntryId,
    });
  });

  it("returns a matching stored append receipt without inserting another change", async () => {
    const { execute, repository } = makeRepository([[lockedHead()], [storedRequestRow()]]);
    await expect(repository.appendChange(appendInput())).resolves.toEqual({
      changeId,
      identityId: recordId,
      sourceEntryId,
      version,
      predecessorVersion: null,
      requestHash: "d".repeat(64),
      kind: "update",
      actor: { channel: "mcp", clientId: "token:client-1" },
      replayed: true,
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["hash", { request_hash: "e".repeat(64) }],
    ["kind", { kind: "delete" }],
    ["identity", { identity_id: "20000000-0000-4000-8000-000000000099" }],
    ["client", { client_id: "token:another-client" }],
  ] as const)("rejects a replay with changed %s attribution", async (_label, row) => {
    const repository = makeRepository([[lockedHead()], [storedRequestRow(row)]]).repository;
    await expect(repository.appendChange(appendInput())).rejects.toBeInstanceOf(
      FoodRecordConflictError,
    );
  });

  it("skips nutrient insertion for an empty decision set", async () => {
    const nextVersion = "40000000-0000-4000-8000-000000000023";
    const { execute, repository } = makeRepository([
      [lockedHead()],
      [],
      [{ change_id: changeId }],
      [{ version: nextVersion }],
    ]);
    await expect(repository.appendChange(appendInput())).resolves.toMatchObject({
      version: nextVersion,
      replayed: false,
    });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["change", [[lockedHead()], [], []], "Food record change insert returned no ID"],
    [
      "target",
      [[lockedHead()], [], [{ change_id: changeId }], []],
      "Food record target insert returned no ID",
    ],
  ] as const)("fails when the %s insert returns no ID", async (_name, responses, message) => {
    await expect(
      makeRepository(responses.map((response) => [...response])).repository.appendChange(
        appendInput(),
      ),
    ).rejects.toThrow(message);
  });

  it.each(["human_record_target_successor_key", "human_record_change_request_key"])(
    "maps the %s unique violation to a version conflict",
    async (constraint) => {
      let callCount = 0;
      const execute = vi.fn<Database["execute"]>(async () => {
        callCount += 1;
        if (callCount === 1) return [lockedHead()];
        if (callCount === 2) return [];
        throw Object.assign(new Error("insert failed"), {
          cause: { code: "23505", constraint },
        });
      });
      const database = {
        execute,
        transaction: vi.fn<Database["transaction"]>(),
      } satisfies Pick<Database, "execute" | "transaction">;
      const repository = new FoodRecordRepository(database, userId);

      await expect(repository.appendChange(appendInput())).rejects.toMatchObject({
        name: FoodRecordConflictError.name,
        currentVersion: version,
      });
    },
  );

  it("rethrows non-unique database failures", async () => {
    const databaseError = Object.assign(new Error("check failed"), { code: "23514" });
    let callCount = 0;
    const execute = vi.fn<Database["execute"]>(async () => {
      callCount += 1;
      if (callCount === 1) return [lockedHead()];
      if (callCount === 2) return [];
      throw databaseError;
    });
    const database = {
      execute,
      transaction: vi.fn<Database["transaction"]>(),
    } satisfies Pick<Database, "execute" | "transaction">;

    await expect(
      new FoodRecordRepository(database, userId).appendChange(appendInput()),
    ).rejects.toBe(databaseError);
  });
});
