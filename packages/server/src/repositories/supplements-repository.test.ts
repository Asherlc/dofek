import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type Supplement,
  SupplementsRepository,
  toApiSupplement,
} from "./supplements-repository.ts";

const supplementInsertValuesSchema = z.object({
  userId: z.string(),
  name: z.string(),
  amount: z.number().nullable(),
  unit: z.string().nullable(),
  form: z.string().nullable(),
  description: z.string().nullable(),
  meal: z.string().nullable(),
  sortOrder: z.number(),
  scheduleId: z.string().optional(),
  supersedesSupplementId: z.string().optional(),
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
  interface InsertCall {
    table: unknown;
    values: unknown;
  }

  function makeRepository(
    rows: Record<string, unknown>[] = [],
    options: { returningRows?: Array<{ id?: string }> } = {},
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
    const mockTransaction = vi
      .fn()
      .mockImplementation(async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const transactionContext = {
          select: vi.fn().mockReturnValue(selectReturn),
          insert: vi.fn().mockImplementation((table: unknown) => ({
            values: vi.fn().mockImplementation((values: unknown) => {
              insertCalls.push({ table, values });
              return {
                returning: vi.fn().mockResolvedValue(returningRows),
              };
            }),
          })),
          delete: vi.fn().mockReturnValue(deleteReturn),
          execute: vi.fn().mockResolvedValue(rows),
        };
        return callback(transactionContext);
      });
    const db: Pick<import("dofek/db").Database, "execute" | "transaction"> = {
      execute,
      transaction: mockTransaction,
    };
    const repo = new SupplementsRepository(db, "user-1");
    return { repo, execute, transaction: mockTransaction, insertCalls };
  }

  it("list returns empty array when no data", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.list();
    expect(result).toEqual([]);
  });

  it("list returns parsed supplements", async () => {
    const { repo } = makeRepository([
      {
        id: "sup-1",
        user_id: "user-1",
        schedule_id: "schedule-1",
        supersedes_supplement_id: null,
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
      .map((call) => supplementInsertValuesSchema.safeParse(call.values))
      .filter((result) => result.success)
      .map((result) => result.data);
    const supplementInsert = parsedInserts.find((values) => values.name === "Vitamin D");
    expect(supplementInsert).toBeDefined();
    expect(supplementInsert?.amount).toBe(5000);
    expect(supplementInsert?.unit).toBe("IU");
    expect(supplementInsert?.form).toBe("softgel");
    expect(supplementInsert?.description).toBe("Daily vitamin D3");
    expect(supplementInsert?.meal).toBe("breakfast");
    expect(supplementInsert?.sortOrder).toBe(0);
  });

  it("save throws when supplement insert returns no id, before any nutrient insert", async () => {
    const { repo, insertCalls } = makeRepository(undefined, { returningRows: [] });
    await expect(repo.save([{ name: "Fish Oil", omega3Mg: 500 }])).rejects.toThrow(
      /Supplement insert did not return an id.*Fish Oil/,
    );
    expect(insertCalls).toHaveLength(1);
  });

  it("save does not insert nutrients when supplement has no nutrient fields", async () => {
    const { repo, insertCalls } = makeRepository();
    await repo.save([{ name: "Vitamin D", amount: 5000, unit: "IU" }]);
    expect(insertCalls).toHaveLength(1);
  });

  it("treats a new leading V1 definition as new after matching existing names globally", async () => {
    const currentRows = [
      makeSupplementViewRow("supplement-a", "schedule-a", "Vitamin A", 0),
      makeSupplementViewRow("supplement-b", "schedule-b", "Vitamin B", 1),
    ];
    const { repo, insertCalls } = makeRepository(currentRows);

    await repo.save([{ name: "Vitamin C" }, { name: "Vitamin A" }, { name: "Vitamin B" }]);

    const parsed = insertCalls
      .map((call) => supplementInsertValuesSchema.safeParse(call.values))
      .filter((result) => result.success)
      .map((result) => result.data);
    expect(parsed).toEqual([
      {
        userId: "user-1",
        name: "Vitamin C",
        amount: null,
        unit: null,
        form: null,
        description: null,
        meal: null,
        sortOrder: 0,
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
      .map((call) => supplementInsertValuesSchema.safeParse(call.values))
      .filter((result) => result.success)
      .map((result) => result.data);
    expect(parsed).toEqual([
      {
        userId: "user-1",
        scheduleId: "schedule-a",
        supersedesSupplementId: "supplement-a",
        name: "Vitamin C",
        amount: null,
        unit: null,
        form: null,
        description: null,
        meal: null,
        sortOrder: 0,
      },
    ]);
  });
});

function makeSupplementViewRow(
  id: string,
  scheduleId: string,
  name: string,
  sortOrder: number,
): Record<string, unknown> {
  return {
    id,
    user_id: "user-1",
    schedule_id: scheduleId,
    supersedes_supplement_id: null,
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
