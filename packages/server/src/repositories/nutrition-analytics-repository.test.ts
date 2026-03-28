import { describe, expect, it, vi } from "vitest";
import {
  AdaptiveTdeeEstimate,
  CaloricBalanceDay,
  MacroRatioDay,
  MicronutrientAdequacy,
  NutritionAnalyticsRepository,
  estimateTdee,
  smoothWeightData,
} from "./nutrition-analytics-repository.ts";

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

describe("MicronutrientAdequacy", () => {
  it("serializes to API shape", () => {
    const model = new MicronutrientAdequacy({
      nutrient: "Vitamin C",
      unit: "mg",
      rda: 90,
      avgIntake: 72,
      percentRda: 80,
      daysTracked: 25,
    });
    expect(model.toDetail()).toEqual({
      nutrient: "Vitamin C",
      unit: "mg",
      rda: 90,
      avgIntake: 72,
      percentRda: 80,
      daysTracked: 25,
    });
  });

  it("exposes individual getters", () => {
    const model = new MicronutrientAdequacy({
      nutrient: "Iron",
      unit: "mg",
      rda: 8,
      avgIntake: 6.5,
      percentRda: 81.3,
      daysTracked: 15,
    });
    expect(model.nutrient).toBe("Iron");
    expect(model.unit).toBe("mg");
    expect(model.rda).toBe(8);
    expect(model.avgIntake).toBe(6.5);
    expect(model.percentRda).toBe(81.3);
    expect(model.daysTracked).toBe(15);
  });
});

describe("CaloricBalanceDay", () => {
  it("serializes to API shape", () => {
    const model = new CaloricBalanceDay({
      date: "2024-03-15",
      caloriesIn: 2200,
      activeEnergy: 500,
      basalEnergy: 1800,
      totalExpenditure: 2300,
      balance: -100,
      rollingAvgBalance: -50,
    });
    expect(model.toDetail()).toEqual({
      date: "2024-03-15",
      caloriesIn: 2200,
      activeEnergy: 500,
      basalEnergy: 1800,
      totalExpenditure: 2300,
      balance: -100,
      rollingAvgBalance: -50,
    });
  });

  it("handles null rolling average", () => {
    const model = new CaloricBalanceDay({
      date: "2024-03-15",
      caloriesIn: 2200,
      activeEnergy: 500,
      basalEnergy: 1800,
      totalExpenditure: 2300,
      balance: -100,
      rollingAvgBalance: null,
    });
    expect(model.toDetail().rollingAvgBalance).toBeNull();
  });

  it("exposes date and balance getters", () => {
    const model = new CaloricBalanceDay({
      date: "2024-03-15",
      caloriesIn: 2200,
      activeEnergy: 500,
      basalEnergy: 1800,
      totalExpenditure: 2300,
      balance: -100,
      rollingAvgBalance: null,
    });
    expect(model.date).toBe("2024-03-15");
    expect(model.balance).toBe(-100);
  });
});

describe("AdaptiveTdeeEstimate", () => {
  it("serializes to API shape", () => {
    const model = new AdaptiveTdeeEstimate({
      estimatedTdee: 2450,
      confidence: 0.85,
      dataPoints: 12,
      dailyData: [
        {
          date: "2024-01-01",
          caloriesIn: 2300,
          weightKg: 80.5,
          smoothedWeight: 80.5,
          estimatedTdee: null,
        },
      ],
    });
    const detail = model.toDetail();
    expect(detail.estimatedTdee).toBe(2450);
    expect(detail.confidence).toBe(0.85);
    expect(detail.dataPoints).toBe(12);
    expect(detail.dailyData).toHaveLength(1);
  });

  it("handles null estimated TDEE", () => {
    const model = new AdaptiveTdeeEstimate({
      estimatedTdee: null,
      confidence: 0,
      dataPoints: 0,
      dailyData: [],
    });
    expect(model.estimatedTdee).toBeNull();
    expect(model.confidence).toBe(0);
    expect(model.dataPoints).toBe(0);
  });

  it("exposes getters", () => {
    const model = new AdaptiveTdeeEstimate({
      estimatedTdee: 2500,
      confidence: 0.9,
      dataPoints: 15,
      dailyData: [],
    });
    expect(model.estimatedTdee).toBe(2500);
    expect(model.confidence).toBe(0.9);
    expect(model.dataPoints).toBe(15);
  });
});

describe("MacroRatioDay", () => {
  it("serializes to API shape", () => {
    const model = new MacroRatioDay({
      date: "2024-03-15",
      proteinPct: 30,
      carbsPct: 45,
      fatPct: 25,
      proteinPerKg: 2.1,
    });
    expect(model.toDetail()).toEqual({
      date: "2024-03-15",
      proteinPct: 30,
      carbsPct: 45,
      fatPct: 25,
      proteinPerKg: 2.1,
    });
  });

  it("handles null proteinPerKg", () => {
    const model = new MacroRatioDay({
      date: "2024-03-15",
      proteinPct: 30,
      carbsPct: 45,
      fatPct: 25,
      proteinPerKg: null,
    });
    expect(model.toDetail().proteinPerKg).toBeNull();
  });

  it("exposes date and proteinPct getters", () => {
    const model = new MacroRatioDay({
      date: "2024-03-15",
      proteinPct: 30,
      carbsPct: 45,
      fatPct: 25,
      proteinPerKg: 2.1,
    });
    expect(model.date).toBe("2024-03-15");
    expect(model.proteinPct).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// TDEE computation helpers
// ---------------------------------------------------------------------------

describe("smoothWeightData", () => {
  it("returns first weight as initial smoothed value", () => {
    const result = smoothWeightData([
      { date: "2024-01-01", caloriesIn: 2000, weightKg: 80 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.smoothedWeight).toBe(80);
  });

  it("applies EWMA smoothing with alpha=0.1", () => {
    const result = smoothWeightData([
      { date: "2024-01-01", caloriesIn: 2000, weightKg: 80 },
      { date: "2024-01-02", caloriesIn: 2100, weightKg: 81 },
    ]);
    // EWMA: 0.1 * 81 + 0.9 * 80 = 80.1
    expect(result[1]?.smoothedWeight).toBeCloseTo(80.1, 2);
  });

  it("carries forward smoothed weight through null days", () => {
    const result = smoothWeightData([
      { date: "2024-01-01", caloriesIn: 2000, weightKg: 80 },
      { date: "2024-01-02", caloriesIn: 2100, weightKg: null },
    ]);
    expect(result[1]?.smoothedWeight).toBe(80);
    expect(result[1]?.weightKg).toBeNull();
  });

  it("returns null smoothed weight when no weight data exists", () => {
    const result = smoothWeightData([
      { date: "2024-01-01", caloriesIn: 2000, weightKg: null },
    ]);
    expect(result[0]?.smoothedWeight).toBeNull();
  });
});

describe("estimateTdee", () => {
  it("returns null TDEE with insufficient data", () => {
    const smoothedData = Array.from({ length: 10 }, (_, index) => ({
      date: `2024-01-${String(index + 1).padStart(2, "0")}`,
      caloriesIn: 2000,
      weightKg: 80,
      smoothedWeight: 80,
      estimatedTdee: null,
    }));
    const result = estimateTdee(smoothedData);
    expect(result.estimatedTdee).toBeNull();
    expect(result.dataPoints).toBe(0);
  });

  it("computes TDEE when stable weight and enough data", () => {
    // 35 days of stable weight at 80kg eating 2500 cal/day
    const smoothedData = Array.from({ length: 35 }, (_, index) => ({
      date: `2024-01-${String(index + 1).padStart(2, "0")}`,
      caloriesIn: 2500,
      weightKg: 80,
      smoothedWeight: 80,
      estimatedTdee: null,
    }));
    const result = estimateTdee(smoothedData);
    // Stable weight => TDEE should equal calorie intake
    expect(result.estimatedTdee).toBe(2500);
    expect(result.dataPoints).toBeGreaterThan(0);
  });

  it("adjusts TDEE for weight gain", () => {
    // Weight increasing from 80 to 81 over 35 days eating 3000 cal/day
    const smoothedData = Array.from({ length: 35 }, (_, index) => ({
      date: `2024-01-${String(index + 1).padStart(2, "0")}`,
      caloriesIn: 3000,
      weightKg: 80 + index / 35,
      smoothedWeight: 80 + index / 35,
      estimatedTdee: null,
    }));
    const result = estimateTdee(smoothedData);
    // Gaining weight => TDEE < intake
    expect(result.estimatedTdee).not.toBeNull();
    expect(result.estimatedTdee!).toBeLessThan(3000);
  });

  it("sets confidence to 0 when fewer than 28 days", () => {
    const smoothedData = Array.from({ length: 20 }, (_, index) => ({
      date: `2024-01-${String(index + 1).padStart(2, "0")}`,
      caloriesIn: 2000,
      weightKg: 80,
      smoothedWeight: 80,
      estimatedTdee: null,
    }));
    const result = estimateTdee(smoothedData);
    expect(result.confidence).toBe(0);
  });

  it("computes positive confidence with sufficient weight data", () => {
    const smoothedData = Array.from({ length: 35 }, (_, index) => ({
      date: `2024-01-${String(index + 1).padStart(2, "0")}`,
      caloriesIn: 2500,
      weightKg: 80,
      smoothedWeight: 80,
      estimatedTdee: null,
    }));
    const result = estimateTdee(smoothedData);
    expect(result.confidence).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("NutritionAnalyticsRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const db = { execute };
    const repo = new NutritionAnalyticsRepository(db, "user-1", "UTC");
    return { repo, execute };
  }

  describe("getMicronutrientAdequacy", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getMicronutrientAdequacy(30);
      expect(result).toEqual([]);
    });

    it("returns MicronutrientAdequacy instances for tracked nutrients", async () => {
      const row: Record<string, unknown> = {};
      // Simulate DB row with one tracked nutrient (vitamin_c_mg)
      row.avg_vitamin_c_mg = 72;
      row.days_vitamin_c_mg = 25;
      // All others are null/0
      row.avg_vitamin_a_mcg = null;
      row.days_vitamin_a_mcg = 0;
      const { repo } = makeRepository([row]);
      const result = await repo.getMicronutrientAdequacy(30);
      // Should filter out nutrients with 0 days tracked
      const vitaminC = result.find(
        (model) => model.nutrient === "Vitamin C",
      );
      expect(vitaminC).toBeDefined();
      expect(vitaminC).toBeInstanceOf(MicronutrientAdequacy);
      expect(vitaminC?.avgIntake).toBe(72);
      expect(vitaminC?.daysTracked).toBe(25);
    });

    it("calls db.execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getMicronutrientAdequacy(30);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getCaloricBalance", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getCaloricBalance(30);
      expect(result).toEqual([]);
    });

    it("returns CaloricBalanceDay instances", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          calories_in: 2200,
          active_energy: 500,
          basal_energy: 1800,
          total_expenditure: 2300,
          balance: -100,
          rolling_avg_balance: -50,
        },
      ]);
      const result = await repo.getCaloricBalance(30);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(CaloricBalanceDay);
      expect(result[0]?.toDetail().caloriesIn).toBe(2200);
      expect(result[0]?.toDetail().balance).toBe(-100);
    });

    it("handles null rolling average", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          calories_in: 2200,
          active_energy: 500,
          basal_energy: 1800,
          total_expenditure: 2300,
          balance: -100,
          rolling_avg_balance: null,
        },
      ]);
      const result = await repo.getCaloricBalance(30);
      expect(result[0]?.toDetail().rollingAvgBalance).toBeNull();
    });
  });

  describe("getAdaptiveTdeeData", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getAdaptiveTdeeData(90);
      expect(result).toEqual([]);
    });

    it("returns data points with weight", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", calories_in: 2300, weight_kg: 80.5 },
      ]);
      const result = await repo.getAdaptiveTdeeData(90);
      expect(result).toHaveLength(1);
      expect(result[0]?.caloriesIn).toBe(2300);
      expect(result[0]?.weightKg).toBe(80.5);
    });

    it("handles null weight", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", calories_in: 2300, weight_kg: null },
      ]);
      const result = await repo.getAdaptiveTdeeData(90);
      expect(result[0]?.weightKg).toBeNull();
    });
  });

  describe("getAdaptiveTdee", () => {
    it("returns AdaptiveTdeeEstimate", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", calories_in: 2000, weight_kg: 80 },
      ]);
      const result = await repo.getAdaptiveTdee(90);
      expect(result).toBeInstanceOf(AdaptiveTdeeEstimate);
    });
  });

  describe("getMacroRatios", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getMacroRatios(30);
      expect(result).toEqual([]);
    });

    it("returns MacroRatioDay instances with computed percentages", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          protein_g: 150,
          carbs_g: 250,
          fat_g: 70,
          calories: 2230,
          weight_kg: 80,
        },
      ]);
      const result = await repo.getMacroRatios(30);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(MacroRatioDay);
      const detail = result[0]!.toDetail();
      // protein: 150*4=600, carbs: 250*4=1000, fat: 70*9=630, total=2230
      expect(detail.proteinPct).toBeCloseTo(26.9, 1);
      expect(detail.carbsPct).toBeCloseTo(44.8, 1);
      expect(detail.fatPct).toBeCloseTo(28.3, 1);
      expect(detail.proteinPerKg).toBeCloseTo(1.88, 2);
    });

    it("handles null weight for proteinPerKg", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          protein_g: 150,
          carbs_g: 250,
          fat_g: 70,
          calories: 2230,
          weight_kg: null,
        },
      ]);
      const result = await repo.getMacroRatios(30);
      expect(result[0]?.toDetail().proteinPerKg).toBeNull();
    });
  });
});
