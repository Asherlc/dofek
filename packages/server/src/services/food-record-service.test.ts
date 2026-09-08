import { describe, expect, it, vi } from "vitest";
import {
  FoodRecordConflictError,
  type FoodRecordHead,
  FoodRecordNotFoundError,
  type FoodRecordRepositoryCommands,
} from "../repositories/food-record-repository.ts";
import {
  type EffectiveFoodRecord,
  FoodRecordPreconditionError,
} from "../repositories/food-record-types.ts";
import { FoodRecordError, FoodRecordService } from "./food-record-service.ts";

const userId = "10000000-0000-4000-8000-000000000001";
const recordId = "20000000-0000-4000-8000-000000000001";
const sourceEntryId = "30000000-0000-4000-8000-000000000001";
const firstVersion = "40000000-0000-4000-8000-000000000001";
const secondVersion = "40000000-0000-4000-8000-000000000002";
const requestId = "50000000-0000-4000-8000-000000000001";

function record(overrides: Partial<EffectiveFoodRecord> = {}): EffectiveFoodRecord {
  return {
    recordId,
    sourceEntryId,
    version: firstVersion,
    deleted: false,
    modifiable: true,
    modificationUnavailableReason: null,
    date: "2026-09-07",
    meal: "breakfast",
    foodName: "Oats",
    foodDescription: null,
    category: "breads_and_cereals",
    numberOfUnits: 1,
    servingUnit: "bowl",
    servingWeightGrams: 80,
    nutrients: { calories: 300, protein: 10 },
    sourceProvider: "dofek",
    provenance: {},
    ...overrides,
  };
}

function head(overrides: Partial<FoodRecordHead> = {}): FoodRecordHead {
  return {
    identityId: recordId,
    sourceEntryId,
    version: secondVersion,
    predecessorVersion: firstVersion,
    requestHash: "a".repeat(64),
    kind: "update",
    actor: { channel: "mcp", clientId: "token:token-id" },
    replayed: false,
    ...overrides,
  };
}

function setup(overrides: Partial<FoodRecordRepositoryCommands> = {}) {
  const snapshots = new Map<string, EffectiveFoodRecord>([
    [firstVersion, record()],
    [secondVersion, record({ version: secondVersion })],
  ]);
  const repository: FoodRecordRepositoryCommands = {
    createSourceAndIdentity: vi.fn(async () => head({ kind: "create", predecessorVersion: null })),
    appendChange: vi.fn(async () => head()),
    findRequest: vi.fn(async () => null),
    getAtVersion: vi.fn(async (_identityId, version) => {
      if (version === null) return record({ version: null });
      return snapshots.get(version) ?? null;
    }),
    ...overrides,
  };
  const transaction = {};
  const database = {
    transaction: vi.fn(async (operation: (tx: object) => Promise<unknown>) =>
      operation(transaction),
    ),
  };
  const withUserWriteFence = vi.fn(
    async (_database: object, _userId: string, operation: (tx: object) => Promise<unknown>) =>
      operation(transaction),
  );
  const invalidateNutritionCaches = vi.fn(async () => undefined);
  const service = new FoodRecordService({
    database,
    userId,
    actor: { channel: "mcp", clientId: "token:token-id" },
    invalidateNutritionCaches,
    repositoryFactory: () => repository,
    withUserWriteFence,
  });
  return { invalidateNutritionCaches, repository, service, withUserWriteFence };
}

describe("FoodRecordService", () => {
  it("creates one itemized record and invalidates its effective date after commit", async () => {
    const created = record({
      version: secondVersion,
      foodName: "Rice",
      nutrients: { calories: 220 },
    });
    const { invalidateNutritionCaches, repository, service, withUserWriteFence } = setup({
      getAtVersion: vi.fn(async () => created),
    });

    await expect(
      service.create({
        requestId,
        date: "2026-09-07",
        meal: "dinner",
        foodName: " Rice ",
        foodDescription: null,
        category: "breads_and_cereals",
        numberOfUnits: 1,
        servingUnit: "plate",
        servingWeightGrams: 180,
        nutrients: { calories: 220 },
      }),
    ).resolves.toEqual({ record: created, affectedDates: ["2026-09-07"] });

    expect(withUserWriteFence).toHaveBeenCalledOnce();
    expect(repository.createSourceAndIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId,
        externalId: `mcp:${requestId}`,
        foodName: "Rice",
        actor: { channel: "mcp", clientId: "token:token-id" },
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(invalidateNutritionCaches).toHaveBeenCalledWith(userId);
  });

  it("canonicalizes object and nutrient key order and excludes request ID from the hash", async () => {
    const hashes: string[] = [];
    const appendChange = vi.fn(async (input) => {
      hashes.push(input.requestHash);
      return head();
    });
    const { service } = setup({ appendChange });

    await service.update({
      recordId,
      expectedVersion: firstVersion,
      requestId,
      set: { foodName: "Oats", meal: "dinner" },
      clear: [],
      nutrientSet: { protein: 14, calories: 320 },
      nutrientClear: [],
    });
    await service.update({
      recordId,
      expectedVersion: firstVersion,
      requestId: "50000000-0000-4000-8000-000000000002",
      set: { meal: "dinner", foodName: "Oats" },
      clear: [],
      nutrientSet: { calories: 320, protein: 14 },
      nutrientClear: [],
    });

    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("excludes the create request ID from the canonical command hash", async () => {
    const hashes: string[] = [];
    const createSourceAndIdentity = vi.fn(async (input) => {
      hashes.push(input.requestHash);
      return head({ kind: "create", predecessorVersion: null });
    });
    const { service } = setup({ createSourceAndIdentity });
    const facts = {
      date: "2026-09-07",
      foodName: "Oats",
      nutrients: { protein: 10 },
    };

    await service.create({ requestId, ...facts });
    await service.create({ requestId: "50000000-0000-4000-8000-000000000002", ...facts });

    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("preserves explicit null values while translating clear lists to clear decisions", async () => {
    const { repository, service } = setup();

    await service.update({
      recordId,
      expectedVersion: firstVersion,
      requestId,
      set: { foodDescription: null },
      clear: ["meal"],
      nutrientSet: { sodium: null },
      nutrientClear: ["protein"],
    });

    expect(repository.appendChange).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: {
          food_description: { operation: "set", value: null },
          meal: { operation: "clear" },
        },
        nutrients: {
          protein: { operation: "clear", amount: null },
          sodium: { operation: "set", amount: null },
        },
      }),
    );
  });

  it("returns the original target snapshot for an exact replay without invalidating caches", async () => {
    const replayed = record({ version: firstVersion, foodName: "Original result" });
    const { invalidateNutritionCaches, repository, service } = setup({
      appendChange: vi.fn(async () =>
        head({ version: firstVersion, predecessorVersion: null, replayed: true }),
      ),
      getAtVersion: vi.fn(async () => replayed),
    });

    await expect(service.delete({ recordId, expectedVersion: null, requestId })).resolves.toEqual({
      record: replayed,
      affectedDates: ["2026-09-07"],
    });
    expect(repository.getAtVersion).toHaveBeenCalledWith(recordId, firstVersion);
    expect(invalidateNutritionCaches).not.toHaveBeenCalled();
  });

  it("returns actionable conflicts for changed request bodies and stale nullable versions", async () => {
    const conflict = new FoodRecordConflictError(recordId, secondVersion, "Request ID was reused");
    const { service } = setup({ appendChange: vi.fn(async () => Promise.reject(conflict)) });

    await expect(service.restore({ recordId, expectedVersion: null, requestId })).rejects.toEqual(
      expect.objectContaining({
        name: FoodRecordError.name,
        code: "CONFLICT",
        details: { recordId, currentVersion: secondVersion },
      }),
    );
  });

  it("reports source ownership and row-fallback failures as domain errors", async () => {
    const notFound = setup({
      appendChange: vi.fn(async () => Promise.reject(new FoodRecordNotFoundError(recordId))),
    });
    await expect(
      notFound.service.delete({ recordId, expectedVersion: null, requestId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const unmodifiable = setup({
      appendChange: vi.fn(async () =>
        Promise.reject(new FoodRecordPreconditionError(sourceEntryId)),
      ),
    });
    await expect(
      unmodifiable.service.delete({ recordId, expectedVersion: null, requestId }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("rejects invalid and ambiguous commands before opening a transaction", async () => {
    const { service, withUserWriteFence } = setup();

    await expect(
      service.update({
        recordId,
        expectedVersion: firstVersion,
        requestId,
        set: { meal: "dinner" },
        clear: ["meal"],
        nutrientSet: {},
        nutrientClear: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      service.create({
        requestId,
        date: "2026-09-07",
        foodName: " ",
        nutrients: { protein: -1 },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(withUserWriteFence).not.toHaveBeenCalled();
  });

  it("returns sorted old and new dates for a date-moving update", async () => {
    const { service } = setup({
      getAtVersion: vi.fn(async (_identityId, version) =>
        version === firstVersion
          ? record({ date: "2026-09-08" })
          : record({ version: secondVersion, date: "2026-09-06" }),
      ),
    });

    await expect(
      service.update({
        recordId,
        expectedVersion: firstVersion,
        requestId,
        set: { date: "2026-09-06" },
        clear: [],
        nutrientSet: {},
        nutrientClear: [],
      }),
    ).resolves.toMatchObject({ affectedDates: ["2026-09-06", "2026-09-08"] });
  });
});
