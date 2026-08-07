import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type Supplement,
  SupplementDoseConflictError,
  SupplementsRepository,
  supplementSchema,
  toApiSupplement,
} from "./supplements-repository.ts";

const ensureProvider = vi.hoisted(() => vi.fn().mockResolvedValue("dofek"));
vi.mock("dofek/db/tokens", () => ({ ensureProvider }));

const supplementDefinitionInsertValuesSchema = z.object({
  supplementId: z.string(),
  supersedesDefinitionId: z.string().optional(),
  name: z.string(),
  amount: z.number().nullable(),
  unit: z.string().nullable(),
  form: z.string().nullable(),
  description: z.string().nullable(),
  meal: z.string().nullable(),
  effectiveFrom: z.string(),
});

/** All nutrient columns set to null, matching the DB view's snake_case shape. */
const NULL_NUTRIENTS: Record<string, null> = {
  calories: null,
  protein_g: null,
  carbs_g: null,
  fat_g: null,
  saturated_fat_g: null,
  polyunsaturated_fat_g: null,
  monounsaturated_fat_g: null,
  trans_fat_g: null,
  cholesterol_mg: null,
  sodium_mg: null,
  potassium_mg: null,
  fiber_g: null,
  sugar_g: null,
  vitamin_a_mcg: null,
  vitamin_c_mg: null,
  vitamin_d_mcg: null,
  vitamin_e_mg: null,
  vitamin_k_mcg: null,
  vitamin_b1_mg: null,
  vitamin_b2_mg: null,
  vitamin_b3_mg: null,
  vitamin_b5_mg: null,
  vitamin_b6_mg: null,
  vitamin_b7_mcg: null,
  vitamin_b9_mcg: null,
  vitamin_b12_mcg: null,
  calcium_mg: null,
  iron_mg: null,
  magnesium_mg: null,
  zinc_mg: null,
  selenium_mcg: null,
  copper_mg: null,
  manganese_mg: null,
  chromium_mcg: null,
  iodine_mcg: null,
  omega3_mg: null,
  omega6_mg: null,
};

// ---------------------------------------------------------------------------
// toApiSupplement
// ---------------------------------------------------------------------------

describe("toApiSupplement", () => {
  it("maps a view row to the API shape with basic fields", () => {
    const row: Record<string, unknown> = {
      id: "sup-1",
      user_id: "user-1",
      name: "Vitamin D",
      amount: 5000,
      unit: "IU",
      form: "softgel",
      description: "Daily vitamin D3",
      meal: "breakfast",
      sort_order: 0,
      nutrition_data_id: "nd-1",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };

    const result = toApiSupplement(row);
    expect(result.name).toBe("Vitamin D");
    expect(result.amount).toBe(5000);
    expect(result.unit).toBe("IU");
    expect(result.form).toBe("softgel");
    expect(result.description).toBe("Daily vitamin D3");
    expect(result.meal).toBe("breakfast");
  });

  it("omits null optional fields from the result", () => {
    const row: Record<string, unknown> = {
      name: "Magnesium",
      amount: null,
      unit: null,
      form: null,
      description: null,
      meal: null,
    };

    const result = toApiSupplement(row);
    expect(result.name).toBe("Magnesium");
    expect(result.amount).toBeUndefined();
    expect(result.unit).toBeUndefined();
    expect(result.form).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.meal).toBeUndefined();
  });

  it("converts snake_case nutrient columns to camelCase", () => {
    const row: Record<string, unknown> = {
      name: "Fish Oil",
      amount: 1000,
      unit: "mg",
      ...NULL_NUTRIENTS,
      omega3_mg: 500,
    };

    const result = toApiSupplement(row);
    expect(result.name).toBe("Fish Oil");
    expect(result.omega3Mg).toBe(500);
    expect(result.omega6Mg).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SupplementsRepository
// ---------------------------------------------------------------------------

describe("SupplementsRepository", () => {
  const NO_TRANSACTION_ERROR = Symbol("no transaction error");

  interface InsertCall {
    table: unknown;
    values: unknown;
    returning: unknown;
  }

  function makeRepository(
    rows: Record<string, unknown>[] = [],
    options: {
      returningRows?: Array<{ id?: string }>;
      returningResults?: Array<Array<{ id?: string }>>;
    } = {},
  ) {
    const execute = vi.fn().mockResolvedValue(rows);
    const selectReturn = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    };
    const deleteReturn = {
      where: vi.fn().mockResolvedValue(undefined),
    };
    const insertCalls: InsertCall[] = [];
    const returningRows = options.returningRows ?? [{ id: "nd-1" }];
    const returningResults = [...(options.returningResults ?? [])];
    const transactionExecute = vi.fn().mockResolvedValue(rows);
    const mockTransaction = vi
      .fn()
      .mockImplementation(async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const transactionContext = {
          select: vi.fn().mockReturnValue(selectReturn),
          insert: vi.fn().mockImplementation((table: unknown) => ({
            values: vi.fn().mockImplementation((values: unknown) => {
              const insertCall: InsertCall = { table, values, returning: undefined };
              insertCalls.push(insertCall);
              return {
                returning: vi.fn().mockImplementation((returning: unknown) => {
                  insertCall.returning = returning;
                  return Promise.resolve(returningResults.shift() ?? returningRows);
                }),
              };
            }),
          })),
          delete: vi.fn().mockReturnValue(deleteReturn),
          execute: transactionExecute,
        };
        return callback(transactionContext);
      });
    const db: Pick<import("dofek/db").Database, "execute" | "transaction"> = {
      execute,
      transaction: mockTransaction,
    };
    const repo = new SupplementsRepository(db, "user-1");
    return { repo, execute, transaction: mockTransaction, transactionExecute, insertCalls };
  }

  function makeRecordDoseRepository(
    executeResults: unknown[][],
    transactionError: unknown = NO_TRANSACTION_ERROR,
  ): {
    repo: SupplementsRepository;
    execute: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  } {
    const execute = vi.fn();
    for (const result of executeResults) execute.mockResolvedValueOnce(result);
    const transaction =
      transactionError === NO_TRANSACTION_ERROR
        ? vi
            .fn()
            .mockImplementation(async (callback: (tx: { execute: typeof execute }) => unknown) =>
              callback({ execute }),
            )
        : vi.fn().mockRejectedValue(transactionError);
    const db: Pick<import("dofek/db").Database, "execute" | "transaction"> = {
      execute: vi.fn(),
      transaction,
    };
    return {
      repo: new SupplementsRepository(db, "user-1", "UTC"),
      execute,
      transaction,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("list returns empty array when no data", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.list();
    expect(result).toEqual([]);
  });

  it("list returns parsed supplements", async () => {
    const { repo } = makeRepository([
      {
        definition_id: "sup-1",
        supplement_id: "schedule-1",
        user_id: "user-1",
        schedule_id: "schedule-1",
        supersedes_definition_id: null,
        name: "Vitamin D",
        amount: 5000,
        unit: "IU",
        form: "softgel",
        description: null,
        meal: "breakfast",
        sort_order: 0,
        effective_from: "2024-01-01",
        effective_to: null,
        nutrition_data_id: "nd-1",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        ...NULL_NUTRIENTS,
      },
    ]);

    const result = await repo.list();
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Vitamin D");
    expect(result[0]?.amount).toBe(5000);
    expect(result[0]?.unit).toBe("IU");
    expect(result[0]?.meal).toBe("breakfast");
    expect(result[0]).toEqual({
      name: "Vitamin D",
      amount: 5000,
      unit: "IU",
      form: "softgel",
      meal: "breakfast",
    });
  });

  it("save with empty array returns zero count", async () => {
    const { repo, transaction } = makeRepository();
    const result = await repo.save([]);
    expect(result).toEqual({ success: true, count: 0 });
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("save with supplements returns correct count", async () => {
    const { repo, transaction } = makeRepository();
    const supplements: Supplement[] = [
      { name: "Vitamin D", amount: 5000, unit: "IU" },
      { name: "Magnesium", amount: 400, unit: "mg" },
    ];
    const result = await repo.save(supplements);
    expect(result).toEqual({ success: true, count: 2 });
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("save passes optional supplement fields through to insert when provided", async () => {
    const { repo, insertCalls } = makeRepository();
    await repo.save([
      {
        name: "Vitamin D",
        amount: 5000,
        unit: "IU",
        form: "softgel",
        description: "Daily vitamin D3",
        meal: "breakfast",
      },
    ]);
    const parsedInserts = insertCalls
      .map((call) => supplementDefinitionInsertValuesSchema.safeParse(call.values))
      .filter((result) => result.success)
      .map((result) => result.data);
    const supplementInsert = parsedInserts.find((values) => values.name === "Vitamin D");
    expect(supplementInsert).toBeDefined();
    expect(supplementInsert?.amount).toBe(5000);
    expect(supplementInsert?.unit).toBe("IU");
    expect(supplementInsert?.form).toBe("softgel");
    expect(supplementInsert?.description).toBe("Daily vitamin D3");
    expect(supplementInsert?.meal).toBe("breakfast");
    expect(supplementInsert?.supplementId).toBe("nd-1");
  });

  it("save throws when supplement insert returns no id, before any nutrient insert", async () => {
    const { repo, insertCalls } = makeRepository(undefined, { returningRows: [] });
    await expect(repo.save([{ name: "Fish Oil", omega3Mg: 500 }])).rejects.toThrow(
      /Supplement schedule insert did not return an id.*Fish Oil/,
    );
    expect(insertCalls).toHaveLength(1);
  });

  it("save does not insert nutrients when supplement has no nutrient fields", async () => {
    const { repo, insertCalls } = makeRepository();
    await repo.save([{ name: "Vitamin D", amount: 5000, unit: "IU" }]);
    expect(insertCalls).toHaveLength(2);
  });

  it("treats a new leading V1 definition as new after matching existing names globally", async () => {
    const currentRows = [
      makeSupplementViewRow("supplement-a", "schedule-a", "Vitamin A", 0),
      makeSupplementViewRow("supplement-b", "schedule-b", "Vitamin B", 1),
    ];
    const { repo, insertCalls } = makeRepository(currentRows);

    await repo.save([{ name: "Vitamin C" }, { name: "Vitamin A" }, { name: "Vitamin B" }]);

    const parsed = insertCalls
      .map((call) => supplementDefinitionInsertValuesSchema.safeParse(call.values))
      .filter((result) => result.success)
      .map((result) => result.data);
    expect(parsed).toEqual([
      {
        supplementId: "nd-1",
        name: "Vitamin C",
        amount: null,
        unit: null,
        form: null,
        description: null,
        meal: null,
        effectiveFrom: expect.any(String),
      },
    ]);
  });

  it("creates an immutable successor with the same schedule for a V1 rename", async () => {
    const currentRows = [
      makeSupplementViewRow("supplement-a", "schedule-a", "Vitamin A", 0),
      makeSupplementViewRow("supplement-b", "schedule-b", "Vitamin B", 1),
    ];
    const { repo, insertCalls } = makeRepository(currentRows);

    await repo.save([{ name: "Vitamin C" }, { name: "Vitamin B" }]);

    const parsed = insertCalls
      .map((call) => supplementDefinitionInsertValuesSchema.safeParse(call.values))
      .filter((result) => result.success)
      .map((result) => result.data);
    expect(parsed).toEqual([
      {
        supplementId: "schedule-a",
        supersedesDefinitionId: "supplement-a",
        name: "Vitamin C",
        amount: null,
        unit: null,
        form: null,
        description: null,
        meal: null,
        effectiveFrom: expect.any(String),
      },
    ]);
  });

  it("creates a new schedule and definition with exact ownership, order, and identity", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-27T12:00:00.000Z") });
    const { repo, insertCalls } = makeRepository([], {
      returningResults: [[{ id: "schedule-new" }], [{ id: "definition-new" }]],
    });

    await expect(repo.save([{ name: "Vitamin D" }])).resolves.toEqual({
      success: true,
      count: 1,
    });

    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0]?.values).toEqual({ userId: "user-1", sortOrder: 0 });
    expect(insertCalls[1]?.values).toEqual({
      supplementId: "schedule-new",
      supersedesDefinitionId: undefined,
      name: "Vitamin D",
      amount: null,
      unit: null,
      form: null,
      description: null,
      meal: null,
      effectiveFrom: "2026-07-27",
    });
    expect(insertCalls[0]?.returning).toEqual({ id: expect.anything() });
    expect(insertCalls[1]?.returning).toEqual({ id: expect.anything() });
  });

  it("fails when a new definition insert returns no id", async () => {
    const { repo, insertCalls } = makeRepository([], {
      returningResults: [[{ id: "schedule-new" }], []],
    });

    await expect(repo.save([{ name: "Vitamin D" }])).rejects.toThrow(
      'Supplement definition insert did not return an id (name="Vitamin D", index=0)',
    );
    expect(insertCalls).toHaveLength(2);
  });

  it("uses the same-position unused schedule before the first unused fallback", async () => {
    const currentRows = [
      makeSupplementViewRow("supplement-a", "schedule-a", "Vitamin A", 0),
      makeSupplementViewRow("supplement-b", "schedule-b", "Vitamin B", 1),
      makeSupplementViewRow("supplement-c", "schedule-c", "Vitamin C", 2),
      makeSupplementViewRow("supplement-d", "schedule-d", "Vitamin D", 3),
    ];
    const { repo, insertCalls } = makeRepository(currentRows);

    await repo.save([{ name: "Vitamin C" }, { name: "Vitamin X" }]);

    const definitionInsert = insertCalls
      .map((call) => supplementDefinitionInsertValuesSchema.safeParse(call.values))
      .find((result) => result.success)?.data;
    expect(definitionInsert).toMatchObject({
      supplementId: "schedule-b",
      supersedesDefinitionId: "supplement-b",
      name: "Vitamin X",
    });
  });

  it("falls back to the first unused schedule when the same-position schedule is used", async () => {
    const currentRows = [
      makeSupplementViewRow("supplement-a", "schedule-a", "Vitamin A", 0),
      makeSupplementViewRow("supplement-b", "schedule-b", "Vitamin B", 1),
      makeSupplementViewRow("supplement-c", "schedule-c", "Vitamin C", 2),
    ];
    const { repo, insertCalls } = makeRepository(currentRows);

    await repo.save([{ name: "Vitamin B" }, { name: "Vitamin X" }]);

    const definitionInsert = insertCalls
      .map((call) => supplementDefinitionInsertValuesSchema.safeParse(call.values))
      .find((result) => result.success)?.data;
    expect(definitionInsert).toMatchObject({
      supplementId: "schedule-a",
      supersedesDefinitionId: "supplement-a",
      name: "Vitamin X",
    });
  });

  it("archives removed definitions without archiving unchanged definitions", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-27T12:00:00.000Z") });
    const currentRows = [
      makeSupplementViewRow("supplement-a", "schedule-a", "Vitamin A", 0),
      makeSupplementViewRow("supplement-b", "schedule-b", "Vitamin B", 1),
    ];
    const { repo, transactionExecute } = makeRepository(currentRows);

    await repo.save([{ name: "Vitamin B" }]);

    const calls = transactionExecute.mock.calls.map((call) => JSON.stringify(call));
    const archiveCalls = calls.filter((call) => call.includes("SET effective_to"));
    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]).toContain("supplement-a");
    expect(archiveCalls[0]).not.toContain("supplement-b");
  });

  it("treats reordered fields as the same immutable definition", async () => {
    const current = makeSupplementViewRow("supplement-a", "schedule-a", "Vitamin D", 0);
    current.amount = 25;
    current.unit = "mcg";
    const { repo, insertCalls } = makeRepository([current]);

    await repo.save([{ unit: "mcg", amount: 25, name: "Vitamin D" }]);

    expect(insertCalls).toEqual([]);
  });

  it("treats omitted and explicit undefined optional fields as the same definition", async () => {
    const current = makeSupplementViewRow("supplement-a", "schedule-a", "Vitamin D", 0);
    const { repo, insertCalls } = makeRepository([current]);

    await repo.save([{ name: "Vitamin D", unit: undefined }]);

    expect(insertCalls).toEqual([]);
  });

  it("computes an inclusive occurrence window and selects only the current leaf", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-27T12:00:00.000Z") });
    const rows = [
      makeDoseEventRow({ id: "old-event", status: "taken", is_current: false }),
      makeDoseEventRow({
        id: "current-event",
        status: "skipped",
        supersedes_event_id: "old-event",
        is_current: true,
      }),
      makeDoseEventRow({
        id: "orphan-history",
        schedule_id: "schedule-2",
        supplement_id: "definition-2",
        supplement_name: "Magnesium",
        scheduled_date: "2026-07-26",
        is_current: false,
      }),
    ];
    const { repo, execute } = makeRepository(rows);

    await expect(repo.occurrences(7)).resolves.toEqual({
      counts: { planned: 0, taken: 0, skipped: 1, unknown: 0 },
      occurrences: [
        {
          currentEventId: "current-event",
          scheduleId: "schedule-1",
          supplementId: "definition-1",
          supplementName: "Vitamin D",
          scheduledDate: "2026-07-27",
          status: "skipped",
          history: [
            {
              id: "old-event",
              providerId: "dofek",
              status: "taken",
              recordedAt: "2026-07-27T08:00:00.000Z",
              sourceName: "Dofek App",
            },
            {
              id: "current-event",
              providerId: "dofek",
              status: "skipped",
              recordedAt: "2026-07-27T08:00:00.000Z",
              sourceName: "Dofek App",
            },
          ],
        },
      ],
    });
    const query = JSON.stringify(execute.mock.calls[0]);
    expect(query).toContain("2026-07-21");
    expect(query).toContain("2026-07-27");
    expect(query).not.toContain("2026-07-21T00:00:00.000Z");
  });

  it("records a dose successor with exact stable and version identities", async () => {
    const { repo, execute } = makeRecordDoseRepository([
      [
        {
          id: "current-event",
          user_id: "user-1",
          schedule_id: "schedule-1",
          supplement_id: "definition-1",
          scheduled_date: "2026-07-27",
        },
      ],
      [{ id: "new-event" }],
    ]);

    await expect(repo.recordDose("current-event", "taken")).resolves.toEqual({
      id: "new-event",
      scheduledDate: "2026-07-27",
      status: "taken",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(execute.mock.calls[0])).toContain("current-event");
    expect(JSON.stringify(execute.mock.calls[1])).toContain("schedule-1");
    expect(JSON.stringify(execute.mock.calls[1])).toContain("definition-1");
    expect(JSON.stringify(execute.mock.calls[1])).toContain("2026-07-27");
    expect(JSON.stringify(execute.mock.calls[1])).toContain("taken");
    expect(ensureProvider).toHaveBeenCalledWith(
      expect.anything(),
      "dofek",
      "Dofek App",
      undefined,
      "user-1",
    );
  });

  it("maps a missing current leaf to the domain conflict", async () => {
    const { repo, execute } = makeRecordDoseRepository([[]]);

    await expect(repo.recordDose("stale-event", "skipped")).rejects.toEqual(
      new SupplementDoseConflictError(),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(ensureProvider).not.toHaveBeenCalled();
  });

  it("fails when the dose successor insert returns no id", async () => {
    const { repo } = makeRecordDoseRepository([
      [
        {
          id: "current-event",
          user_id: "user-1",
          schedule_id: "schedule-1",
          supplement_id: "definition-1",
          scheduled_date: "2026-07-27",
        },
      ],
      [],
    ]);

    await expect(repo.recordDose("current-event", "taken")).rejects.toThrow(
      "Supplement dose event insert did not return an id",
    );
  });

  it("maps unique violations and existing domain conflicts to a fresh domain conflict", async () => {
    const uniqueViolation = { code: "23505" };
    const unique = makeRecordDoseRepository([], uniqueViolation);
    const existing = makeRecordDoseRepository([], new SupplementDoseConflictError());

    await expect(unique.repo.recordDose("event-1", "taken")).rejects.toEqual(
      new SupplementDoseConflictError(),
    );
    await expect(existing.repo.recordDose("event-1", "taken")).rejects.toEqual(
      new SupplementDoseConflictError(),
    );
  });

  it.each([
    null,
    "23505",
    {},
    { code: "other" },
    new Error("database unavailable"),
  ])("preserves unexpected record-dose failures: %o", async (failure) => {
    const { repo } = makeRecordDoseRepository([], failure);

    await expect(repo.recordDose("event-1", "taken")).rejects.toBe(failure);
  });

  it.each([
    { name: "" },
    { name: "x".repeat(201) },
    { name: "Vitamin D", amount: 0 },
    { name: "Vitamin D", unit: "micrograms+" },
    { name: "Vitamin D", meal: "midnight" },
  ])("rejects invalid supplement input at the schema boundary: %o", (invalid) => {
    expect(supplementSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects an invalid supplement view row at the database boundary", async () => {
    const invalidViewRow = makeSupplementViewRow("definition-1", "schedule-1", "Vitamin D", 0);
    invalidViewRow.definition_id = undefined;
    const invalidListDb: Pick<import("dofek/db").Database, "execute" | "transaction"> = {
      execute: vi.fn().mockResolvedValue([invalidViewRow]),
      transaction: vi.fn(),
    };
    const invalidListRepository = new SupplementsRepository(invalidListDb, "user-1", "UTC");
    await expect(invalidListRepository.list()).rejects.toThrow();
  });
});

function makeSupplementViewRow(
  id: string,
  scheduleId: string,
  name: string,
  sortOrder: number,
): Record<string, unknown> {
  return {
    definition_id: id,
    supplement_id: scheduleId,
    user_id: "user-1",
    schedule_id: scheduleId,
    supersedes_definition_id: null,
    name,
    amount: null,
    unit: null,
    form: null,
    description: null,
    meal: null,
    sort_order: sortOrder,
    effective_from: "2026-01-01",
    effective_to: null,
    nutrition_data_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...NULL_NUTRIENTS,
  };
}

function makeDoseEventRow(
  overrides: Partial<{
    id: string;
    schedule_id: string;
    supplement_id: string;
    supplement_name: string;
    scheduled_date: string;
    status: "planned" | "taken" | "skipped" | "unknown";
    supersedes_event_id: string | null;
    provider_id: string;
    source_name: string | null;
    recorded_at: string;
    created_at: string;
    is_current: boolean;
  }> = {},
): Record<string, unknown> {
  return {
    id: "event-1",
    schedule_id: "schedule-1",
    supplement_id: "definition-1",
    supplement_name: "Vitamin D",
    scheduled_date: "2026-07-27",
    status: "planned",
    supersedes_event_id: null,
    provider_id: "dofek",
    source_name: "Dofek App",
    recorded_at: "2026-07-27T08:00:00.000Z",
    created_at: "2026-07-27T08:00:00.000Z",
    is_current: true,
    ...overrides,
  };
}
