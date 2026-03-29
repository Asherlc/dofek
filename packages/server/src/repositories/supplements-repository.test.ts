import { describe, expect, it, vi } from "vitest";
import {
  type Supplement,
  SupplementsRepository,
  toApiSupplement,
} from "./supplements-repository.ts";

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
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const selectReturn = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    };
    const insertReturn = {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "nd-1" }]),
      }),
    };
    const deleteReturn = {
      where: vi.fn().mockResolvedValue(undefined),
    };
    const mockTransaction = vi
      .fn()
      .mockImplementation(async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const transactionContext = {
          select: vi.fn().mockReturnValue(selectReturn),
          insert: vi.fn().mockReturnValue(insertReturn),
          delete: vi.fn().mockReturnValue(deleteReturn),
          execute: vi.fn().mockResolvedValue([]),
        };
        return callback(transactionContext);
      });
    const db: Pick<import("dofek/db").Database, "execute" | "transaction"> = {
      execute,
      transaction: mockTransaction,
    };
    const repo = new SupplementsRepository(db, "user-1");
    return { repo, execute, transaction: mockTransaction };
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
        name: "Vitamin D",
        amount: 5000,
        unit: "IU",
        form: "softgel",
        description: null,
        meal: "breakfast",
        sort_order: 0,
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
});
