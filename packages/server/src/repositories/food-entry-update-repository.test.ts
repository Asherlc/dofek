import { describe, expect, it, vi } from "vitest";
import { FoodEntryUpdateRepository } from "./food-entry-update-repository.ts";
import {
  makeFoodEntryRow,
  makeRepository as makeTestRepository,
} from "./food-repository-test-helpers.ts";

function makeRepository(rows: Record<string, unknown>[] = []) {
  return makeTestRepository(FoodEntryUpdateRepository, rows);
}

describe("update", () => {
  it("returns null when no fields to update", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.update({ id: "entry-1" });
    expect(result).toBeNull();
  });

  it("returns null when only undefined fields are passed (no actual changes)", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.update({ id: "entry-1", foodName: undefined });
    expect(result).toBeNull();
  });

  it("processes nutrient updates in food_entry_nutrient rows", async () => {
    const foodRow = makeFoodEntryRow({ calories: 500 });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPSERT food_entry_nutrient
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", calories: 500 });
    expect(result).not.toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("creates a food_entry_nutrient row when updating a nutrient", async () => {
    const foodRow = makeFoodEntryRow({ calories: 300 });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPSERT food_entry_nutrient
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", calories: 300 });
    expect(result).not.toBeNull();
  });

  it("handles nutrients replacement in junction table", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // DELETE from junction table
      .mockResolvedValueOnce([]) // INSERT into junction table
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", nutrients: { "vitamin-c": 30 } });
    expect(result).not.toBeNull();
  });

  it("handles nutrients with empty object (deletes but no inserts)", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // DELETE from junction table
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", nutrients: {} });
    expect(result).not.toBeNull();
  });

  it("handles date field with null value", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", date: null });
    expect(result).not.toBeNull();
  });

  it("handles date field with a value", async () => {
    const foodRow = makeFoodEntryRow({ date: "2024-07-01" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", date: "2024-07-01" });
    expect(result?.date).toBe("2024-07-01");
  });

  it("handles non-date food field with null value", async () => {
    const foodRow = makeFoodEntryRow({ meal: null });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", meal: null });
    expect(result).not.toBeNull();
  });

  it("returns updated row when food fields change", async () => {
    const foodRow = makeFoodEntryRow({ food_name: "Updated Chicken" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", foodName: "Updated Chicken" });
    expect(result?.food_name).toBe("Updated Chicken");
  });

  it("returns null when all three conditions are falsy (foodEntryClauses=0, nutrientClauses=0, no nutrients)", async () => {
    // This tests the complex && condition:
    // if (foodEntryClauses.length === 0 && nutrientClauses.length === 0 && !nutrients) return null
    const { repo } = makeRepository([]);
    // No recognized fields, no nutrients => all three conditions are true => null
    const result = await repo.update({ id: "entry-1" });
    expect(result).toBeNull();
  });

  it("does NOT return null when nutrients is provided even if clauses are empty", async () => {
    // nutrients is truthy => the && check fails => does NOT return null early
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // DELETE from junction table
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", nutrients: {} });
    expect(result).not.toBeNull();
  });

  it("does NOT return null when foodEntryClauses > 0 even if nutrientClauses=0 and no nutrients", async () => {
    // foodEntryClauses.length > 0 => first condition is false => does NOT return null
    const foodRow = makeFoodEntryRow({ meal: "dinner" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", meal: "dinner" });
    expect(result).not.toBeNull();
  });

  it("handles non-null non-date food field value", async () => {
    const foodRow = makeFoodEntryRow({ food_description: "Spicy" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", foodDescription: "Spicy" });
    expect(result).not.toBeNull();
  });

  it("returns null from SELECT when row no longer exists", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([]); // SELECT returns nothing
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", foodName: "Gone" });
    expect(result).toBeNull();
  });
});

describe("delete", () => {
  it("returns success", async () => {
    const { repo, execute } = makeRepository([]);
    const result = await repo.delete("entry-1");
    expect(result).toEqual({ success: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("delete — return value", () => {
  it("always returns { success: true } regardless of whether a row was deleted", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.delete("nonexistent-id");
    expect(result).toStrictEqual({ success: true });
    expect(result.success).toBe(true);
  });

  it("calls execute exactly once", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.delete("entry-1");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("update — nutrient field handling", () => {
  it("handles nutrient column with null value (sets NULL)", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // DELETE food_entry_nutrient
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", calories: null });
    expect(result).not.toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does NOT return null when nutrientClauses > 0 even if foodEntryClauses=0 and no nutrients", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPSERT food_entry_nutrient
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", calories: 500 });
    expect(result).not.toBeNull();
  });
});

describe("delete — object shape", () => {
  it("returns object with exactly one key 'success'", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.delete("entry-1");
    expect(Object.keys(result)).toStrictEqual(["success"]);
  });

  it("success value is boolean true, not truthy", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.delete("entry-1");
    expect(result.success).toBe(true);
    expect(result.success).not.toBe(1);
    expect(result.success).not.toBe("true");
  });
});

describe("update — early return null condition boundary", () => {
  it("returns null only when ALL three conditions are met: no food clauses, no nutrient clauses, no nutrients", async () => {
    // Pass an unrecognized field name that is not in fieldColumnMap or NUTRIENT_COLUMN_MAP
    const { repo } = makeRepository([]);
    const result = await repo.update({ id: "entry-1", unknownField: "value" });
    // unknownField is not in fieldColumnMap or NUTRIENT_COLUMN_MAP, and no nutrients key
    // => foodEntryClauses.length === 0 && nutrientClauses.length === 0 && !nutrients => null
    expect(result).toBeNull();
  });
});

describe("update — nutrient fields use food_entry_nutrient rows", () => {
  it("upserts food_entry_nutrient when updating a nutrient", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPSERT food_entry_nutrient
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", calories: 200 });
    expect(result).not.toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("returns null when the final view select is empty", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPSERT food_entry_nutrient targets no owned row
      .mockResolvedValueOnce([]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", calories: 200 });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });

  it("returns null when update path runs but final select is empty", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPSERT food_entry_nutrient
      .mockResolvedValueOnce([]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", calories: 200 });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });
});

describe("update — combined food + nutrient + nutrients updates", () => {
  it("handles food entry fields + nutrient fields + junction table nutrients all at once", async () => {
    const foodRow = makeFoodEntryRow({ food_name: "Updated", calories: 500 });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPSERT food_entry_nutrient
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([]) // DELETE from junction table
      .mockResolvedValueOnce([]) // INSERT into junction table
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({
      id: "entry-1",
      foodName: "Updated",
      calories: 500,
      nutrients: { zinc: 5 },
    });
    expect(result).not.toBeNull();
    expect(result?.food_name).toBe("Updated");
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it("handles nutrient column with non-null value (sets value)", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPSERT food_entry_nutrient
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", proteinG: 42 });
    expect(result).not.toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe("update — fieldColumnMap entries other than date, meal, foodName", () => {
  it("handles foodDescription field (non-date, non-null)", async () => {
    const foodRow = makeFoodEntryRow({ food_description: "New desc" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", foodDescription: "New desc" });
    expect(result).not.toBeNull();
  });

  it("handles category field (non-date, non-null)", async () => {
    const foodRow = makeFoodEntryRow({ category: "fruit" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", category: "fruit" });
    expect(result).not.toBeNull();
  });

  it("handles numberOfUnits field (non-date, non-null)", async () => {
    const foodRow = makeFoodEntryRow({ number_of_units: 3 });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", numberOfUnits: 3 });
    expect(result).not.toBeNull();
  });

  it("handles category field set to null", async () => {
    const foodRow = makeFoodEntryRow({ category: null });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", category: null });
    expect(result).not.toBeNull();
  });

  it("handles foodDescription set to null", async () => {
    const foodRow = makeFoodEntryRow({ food_description: null });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", foodDescription: null });
    expect(result).not.toBeNull();
  });

  it("handles numberOfUnits set to null", async () => {
    const foodRow = makeFoodEntryRow({ number_of_units: null });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", numberOfUnits: null });
    expect(result).not.toBeNull();
  });
});

describe("update — nutrient null coalescing in junction table", () => {
  it("deletes junction rows but does not insert when nutrients is empty object", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // DELETE from junction table
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", nutrients: {} });
    expect(result).not.toBeNull();
    // Only 2 calls: DELETE + SELECT (no INSERT because nutrients is empty)
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("deletes junction rows and inserts new ones when nutrients has entries", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // DELETE from junction table
      .mockResolvedValueOnce([]) // INSERT into junction table
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({
      id: "entry-1",
      nutrients: { "vitamin-a": 100, "vitamin-d": 50 },
    });
    expect(result).not.toBeNull();
    // 3 calls: DELETE + INSERT + SELECT
    expect(execute).toHaveBeenCalledTimes(3);
  });
});

describe("update — rows[0] ?? null return value", () => {
  it("returns the first row when multiple rows returned from view", async () => {
    const foodRow1 = makeFoodEntryRow({ id: "entry-1", food_name: "First" });
    const foodRow2 = makeFoodEntryRow({ id: "entry-2", food_name: "Second" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([foodRow1, foodRow2]); // SELECT from view returns 2
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", meal: "dinner" });
    expect(result).not.toBeNull();
    expect(result?.food_name).toBe("First");
  });
});

describe("delete — always returns success true", () => {
  it("returns { success: true } with boolean true value", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.delete("any-id");
    expect(result.success).toStrictEqual(true);
    expect(typeof result.success).toBe("boolean");
  });

  it("passes userId and id to the delete query", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.delete("target-id");
    const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(queryJson).toContain("user-1");
    expect(queryJson).toContain("target-id");
  });
});

describe("update — multiple food entry fields at once", () => {
  it("builds multiple SET clauses for food entry when multiple fields change", async () => {
    const foodRow = makeFoodEntryRow({
      meal: "dinner",
      food_name: "New Name",
      food_description: "New Desc",
    });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPDATE food_entry
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({
      id: "entry-1",
      meal: "dinner",
      foodName: "New Name",
      foodDescription: "New Desc",
    });
    expect(result).not.toBeNull();
    expect(result?.meal).toBe("dinner");
    expect(result?.food_name).toBe("New Name");
    expect(result?.food_description).toBe("New Desc");
  });
});

describe("update — multiple nutrient fields at once", () => {
  it("upserts multiple food_entry_nutrient rows when multiple nutrient fields change", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // UPSERT food_entry_nutrient
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({
      id: "entry-1",
      calories: 600,
      proteinG: 50,
      fatG: 20,
    });
    expect(result).not.toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe("update — nutrient null value handling", () => {
  it("handles nutrient field set to null (null branch in NUTRIENT_COLUMN_MAP)", async () => {
    const foodRow = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // DELETE food_entry_nutrient
      .mockResolvedValueOnce([foodRow]); // SELECT from view
    const db = { execute };
    const repo = new FoodEntryUpdateRepository(db, "user-1", "UTC");

    const result = await repo.update({ id: "entry-1", proteinG: null });
    expect(result).not.toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
