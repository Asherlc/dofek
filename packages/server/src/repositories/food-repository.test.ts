import { describe, expect, it, vi } from "vitest";
import { FoodEntry, FoodRepository } from "./food-repository.ts";
import { makeFoodEntryRow } from "./food-repository-test-helpers.ts";

describe("FoodRepository", () => {
  it("retains the established read API through the focused read repository", async () => {
    const execute = vi.fn().mockResolvedValue([makeFoodEntryRow()]);
    const repository = new FoodRepository({ execute }, "user-1", "UTC");

    const entries = await repository.byDate("2024-06-15");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toBeInstanceOf(FoodEntry);
    expect(entries[0]?.foodName).toBe("Chicken Breast");
  });

  it("retains the established create API through the focused mutation repository", async () => {
    const row = makeFoodEntryRow();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "entry-1" }])
      .mockResolvedValueOnce([row]);
    const repository = new FoodRepository({ execute }, "user-1", "UTC");

    const created = await repository.create({
      date: "2024-06-15",
      foodName: "Chicken Breast",
      nutrients: {},
    });

    expect(created.food_name).toBe("Chicken Breast");
    expect(created.nutrients).toEqual({});
  });

  it("retains the established update and delete API through the focused mutation repository", async () => {
    const row = makeFoodEntryRow({ food_name: "Updated" });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([]);
    const repository = new FoodRepository({ execute }, "user-1", "UTC");

    const updated = await repository.update({ id: "entry-1", foodName: "Updated" });
    const deleted = await repository.delete("entry-1");

    expect(updated?.food_name).toBe("Updated");
    expect(deleted).toEqual({ success: true });
  });
});
