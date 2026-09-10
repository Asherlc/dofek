import { AccountErasureUserFencedError } from "dofek/db/account-erasure";
import { captureException } from "dofek/lib/error-reporting";
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

vi.mock("dofek/lib/error-reporting", () => ({ captureException: vi.fn() }));

const userId = "10000000-0000-4000-8000-000000000001";
const recordId = "20000000-0000-4000-8000-000000000001";
const sourceEntryId = "30000000-0000-4000-8000-000000000001";
const firstVersion = "40000000-0000-4000-8000-000000000001";
const secondVersion = "40000000-0000-4000-8000-000000000002";
const requestId = "50000000-0000-4000-8000-000000000001";
const changeId = "60000000-0000-4000-8000-000000000001";

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
    changeId,
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
    get: vi.fn(async () => record({ version: secondVersion })),
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
  it.each(["create", "delete"] as const)("sanitizes unexpected %s telemetry", async (operation) => {
    vi.mocked(captureException).mockClear();
    const secret = "private-food-value-8321";
    const databaseError = Object.assign(new Error(`Failed query: ${secret}`), {
      query: `INSERT ${secret}`,
      params: [secret],
      cause: Object.assign(new Error(`Invalid food ${secret}`), { code: "23514" }),
    });
    const fail = vi.fn(async () => {
      throw databaseError;
    });
    const { service } = setup({ createSourceAndIdentity: fail, appendChange: fail });
    const command =
      operation === "create"
        ? service.create({ requestId, date: "2026-09-07", foodName: secret, nutrients: {} })
        : service.delete({ requestId, recordId, expectedVersion: firstVersion });

    await expect(command).rejects.toMatchObject({
      name: "FoodRecordError",
      code: "INTERNAL_ERROR",
      message: "The food record request could not be completed.",
    });
    expect(captureException).toHaveBeenCalledOnce();
    const captured = vi.mocked(captureException).mock.calls;
    expect(
      JSON.stringify(captured, (_key, value: unknown) =>
        value instanceof Error
          ? Object.fromEntries(
              Object.getOwnPropertyNames(value).map((key) => [key, Reflect.get(value, key)]),
            )
          : value,
      ),
    ).not.toContain(secret);
    expect(captured[0]?.[0]).toMatchObject({
      name: "FoodRecordUnexpectedError",
      message: `Food record ${operation} failed [23514]`,
    });
    expect(captured[0]?.[0]).not.toHaveProperty("cause");
    expect(captured[0]?.[1]).toEqual({
      tags: { source: "food-record", operation, error_code: "23514" },
    });
  });

  it("creates one itemized record and invalidates its effective date after commit", async () => {
    const created = record({
      version: secondVersion,
      foodName: "Rice",
      nutrients: { calories: 220 },
    });
    const { invalidateNutritionCaches, repository, service, withUserWriteFence } = setup({
      get: vi.fn(async () => created),
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
    ).resolves.toEqual({
      operation: { changeId, resultingVersion: secondVersion, replayed: false },
      record: created,
      affectedDates: ["2026-09-07"],
    });

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

  it("changes the command hash when mutation content or operation changes", async () => {
    const hashes: string[] = [];
    const appendChange = vi.fn(async (input) => {
      hashes.push(input.requestHash);
      return head({ kind: input.kind });
    });
    const { service } = setup({ appendChange });

    await service.update({
      recordId,
      expectedVersion: firstVersion,
      requestId,
      set: { meal: "dinner" },
      clear: [],
      nutrientSet: {},
      nutrientClear: [],
    });
    await service.update({
      recordId,
      expectedVersion: firstVersion,
      requestId,
      set: { meal: "lunch" },
      clear: [],
      nutrientSet: {},
      nutrientClear: [],
    });
    await service.delete({ recordId, expectedVersion: firstVersion, requestId });

    expect(new Set(hashes).size).toBe(3);
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

  it("deduplicates and sorts repeated clear decisions", async () => {
    const { repository, service } = setup();

    await service.update({
      recordId,
      expectedVersion: firstVersion,
      requestId,
      set: {},
      clear: ["meal", "category", "meal"],
      nutrientSet: {},
      nutrientClear: ["protein", "calories", "protein"],
    });

    expect(repository.appendChange).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: {
          category: { operation: "clear" },
          meal: { operation: "clear" },
        },
        nutrients: {
          calories: { operation: "clear", amount: null },
          protein: { operation: "clear", amount: null },
        },
      }),
    );
  });

  it("returns the original receipt and current record for replay without invalidation metadata", async () => {
    const current = record({ version: secondVersion, foodName: "Current result" });
    const { invalidateNutritionCaches, repository, service } = setup({
      appendChange: vi.fn(async () =>
        head({ version: firstVersion, predecessorVersion: null, replayed: true }),
      ),
      get: vi.fn(async () => current),
    });

    await expect(service.delete({ recordId, expectedVersion: null, requestId })).resolves.toEqual({
      operation: { changeId, resultingVersion: firstVersion, replayed: true },
      record: current,
      affectedDates: [],
    });
    expect(repository.get).toHaveBeenCalledWith(recordId);
    expect(repository.getAtVersion).not.toHaveBeenCalled();
    expect(invalidateNutritionCaches).not.toHaveBeenCalled();
  });

  it("returns an empty affected-date list for a replayed create", async () => {
    const { invalidateNutritionCaches, service } = setup({
      createSourceAndIdentity: vi.fn(async () =>
        head({ kind: "create", predecessorVersion: null, replayed: true }),
      ),
    });

    await expect(
      service.create({ requestId, date: "2026-09-07", foodName: "Oats", nutrients: {} }),
    ).resolves.toMatchObject({ affectedDates: [] });
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

  it.each([
    [
      new FoodRecordNotFoundError(recordId),
      "NOT_FOUND",
      "The food record was not found.",
      { recordId },
    ],
    [
      new FoodRecordPreconditionError(sourceEntryId),
      "PRECONDITION_FAILED",
      "This food entry has no stable provider external ID and cannot be modified safely.",
      { sourceEntryId },
    ],
    [
      new FoodRecordConflictError(recordId, secondVersion),
      "CONFLICT",
      "The food record changed. Read it again and retry with the current version.",
      { recordId, currentVersion: secondVersion },
    ],
  ] as const)(
    "preserves exact domain error details for %s",
    async (cause, code, message, details) => {
      const { service } = setup({ appendChange: vi.fn(async () => Promise.reject(cause)) });
      const thrown = await service
        .delete({ recordId, expectedVersion: firstVersion, requestId })
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(FoodRecordError);
      expect(thrown).toMatchObject({ code, message, details, cause });
    },
  );

  it("passes an existing food record error through unchanged", async () => {
    const original = new FoodRecordError("INVALID_ARGUMENT", "Already mapped", { field: "meal" });
    const { service } = setup({ appendChange: vi.fn(async () => Promise.reject(original)) });

    await expect(
      service.delete({ recordId, expectedVersion: firstVersion, requestId }),
    ).rejects.toBe(original);
  });

  it("maps an active account-erasure fence to an actionable domain error", async () => {
    const cause = new AccountErasureUserFencedError();
    const { service } = setup({ appendChange: vi.fn(async () => Promise.reject(cause)) });
    const thrown = await service
      .delete({ recordId, expectedVersion: firstVersion, requestId })
      .catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      code: "ACCOUNT_ERASURE_ACTIVE",
      message:
        "Account deletion is active. Wait for deletion to complete before changing food records.",
      details: {},
      cause,
    });
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

  it("reports field, nutrient, and empty-update validation issues precisely", async () => {
    const { service, withUserWriteFence } = setup();
    const invalid = await service
      .update({
        recordId,
        expectedVersion: firstVersion,
        requestId,
        set: { meal: "dinner" },
        clear: ["meal"],
        nutrientSet: { protein: 12 },
        nutrientClear: ["protein"],
      })
      .catch((error: unknown) => error);
    expect(invalid).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "The food record command is invalid.",
      details: {
        issues: [
          { path: "clear", message: "meal cannot be both set and cleared" },
          { path: "nutrientClear", message: "protein cannot be both set and cleared" },
        ],
      },
    });

    const empty = await service
      .update({
        recordId,
        expectedVersion: firstVersion,
        requestId,
        set: {},
        clear: [],
        nutrientSet: {},
        nutrientClear: [],
      })
      .catch((error: unknown) => error);
    expect(empty).toMatchObject({
      details: { issues: [{ path: "", message: "Update must contain at least one decision" }] },
    });
    expect(withUserWriteFence).not.toHaveBeenCalled();
  });

  it("redacts missing created or current food snapshots", async () => {
    const missingCreate = setup({ get: vi.fn(async () => null) });
    await expect(
      missingCreate.service.create({
        requestId,
        date: "2026-09-07",
        foodName: "Oats",
        nutrients: {},
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "The food record request could not be completed.",
    });

    const missingCurrent = setup({ get: vi.fn(async () => null) });
    await expect(
      missingCurrent.service.delete({ recordId, expectedVersion: firstVersion, requestId }),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "The food record request could not be completed.",
    });
  });

  it("redacts a missing source predecessor snapshot", async () => {
    const { service } = setup({
      appendChange: vi.fn(async () => head({ predecessorVersion: null })),
      getAtVersion: vi.fn(async () => null),
    });

    await expect(
      service.update({
        recordId,
        expectedVersion: null,
        requestId,
        set: { date: "2026-09-08" },
        clear: [],
        nutrientSet: {},
        nutrientClear: [],
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "The food record request could not be completed.",
    });
  });

  it.each([
    ["delete", true],
    ["restore", false],
  ] as const)("writes and invalidates a %s visibility decision", async (kind, deleted) => {
    const { invalidateNutritionCaches, repository, service } = setup({
      appendChange: vi.fn(async () => head({ kind })),
    });
    const command = { recordId, expectedVersion: firstVersion, requestId };

    const result =
      kind === "delete" ? await service.delete(command) : await service.restore(command);

    expect(repository.appendChange).toHaveBeenCalledWith(
      expect.objectContaining({ kind, deleted, fields: {}, nutrients: {} }),
    );
    expect(result.affectedDates).toEqual(["2026-09-07"]);
    expect(invalidateNutritionCaches).toHaveBeenCalledWith(userId);
  });

  it("returns sorted old and new dates for a date-moving update", async () => {
    const { service } = setup({
      get: vi.fn(async () => record({ version: secondVersion, date: "2026-09-06" })),
      getAtVersion: vi.fn(async () => record({ date: "2026-09-08" })),
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
    ).resolves.toMatchObject({
      operation: { changeId, resultingVersion: secondVersion, replayed: false },
      affectedDates: ["2026-09-06", "2026-09-08"],
    });
  });
});
