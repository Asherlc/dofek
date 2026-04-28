import { describe, expect, it, vi } from "vitest";
import { NutritionDay, type NutritionDayRow, NutritionRepository } from "./nutrition-repository.ts";

describe("NutritionDay", () => {
  function makeRow(overrides: Partial<NutritionDayRow> = {}): NutritionDayRow {
    return {
      date: "2024-03-15",
      providerId: "cronometer",
      userId: "user-1",
      calories: 2100,
      proteinGrams: 150,
      carbsGrams: 220,
      fatGrams: 70,
      fiberGrams: 30,
      waterMl: 2500,
      createdAt: "2024-03-15T12:00:00Z",
      ...overrides,
    };
  }

  it("exposes date and providerId", () => {
    const day = new NutritionDay(makeRow());
    expect(day.date).toBe("2024-03-15");
    expect(day.providerId).toBe("cronometer");
  });

  it("exposes calories with null handling", () => {
    expect(new NutritionDay(makeRow({ calories: 1800 })).calories).toBe(1800);
    expect(new NutritionDay(makeRow({ calories: null })).calories).toBeNull();
  });

  it("serializes to snake_case API shape via toDetail()", () => {
    const detail = new NutritionDay(makeRow()).toDetail();
    expect(detail).toEqual({
      date: "2024-03-15",
      provider_id: "cronometer",
      user_id: "user-1",
      calories: 2100,
      protein_g: 150,
      carbs_g: 220,
      fat_g: 70,
      fiber_g: 30,
      water_ml: 2500,
      created_at: "2024-03-15T12:00:00Z",
    });
  });

  it("preserves null macro fields in snake_case", () => {
    const detail = new NutritionDay(
      makeRow({ proteinGrams: null, carbsGrams: null, fatGrams: null }),
    ).toDetail();
    expect(detail.protein_g).toBeNull();
    expect(detail.carbs_g).toBeNull();
    expect(detail.fat_g).toBeNull();
  });
});

describe("NutritionRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new NutritionRepository({ execute }, "user-1", "UTC");
    return { repo, execute };
  }

  it("returns empty array when no data", async () => {
    const { repo } = makeRepository([]);
    expect(await repo.getDailyNutrition("2024-02-14")).toEqual([]);
  });

  it("returns NutritionDay instances", async () => {
    const { repo } = makeRepository([
      {
        date: "2024-03-15",
        provider_id: "cronometer",
        user_id: "user-1",
        calories: 2100,
        protein_g: 150,
        carbs_g: 220,
        fat_g: 70,
        fiber_g: 30,
        water_ml: 2500,
        created_at: "2024-03-15T12:00:00Z",
      },
    ]);
    const result = await repo.getDailyNutrition("2024-02-14");
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(NutritionDay);
    expect(result[0]?.date).toBe("2024-03-15");
  });

  it("calls execute once", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.getDailyNutrition("2024-01-01");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("queries the derived daily nutrition view", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.getDailyNutrition("2024-01-01");

    const query = execute.mock.calls[0]?.[0];
    const chunks = JSON.stringify(query?.queryChunks);
    expect(chunks).toContain("fitness.v_nutrition_daily");
  });
});
