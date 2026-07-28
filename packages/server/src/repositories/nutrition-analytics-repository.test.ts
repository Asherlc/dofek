import { describe, expect, it, vi } from "vitest";
import {
  AdaptiveTdeeEstimate,
  estimateTdee,
  MacroRatioDay,
  MicronutrientAdequacy,
  MicronutrientSafetyReview,
  NutritionAnalyticsRepository,
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
    const result = smoothWeightData([{ date: "2024-01-01", caloriesIn: 2000, weightKg: 80 }]);
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
    const result = smoothWeightData([{ date: "2024-01-01", caloriesIn: 2000, weightKg: null }]);
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
    if (result.estimatedTdee == null) throw new Error("estimatedTdee should not be null");
    expect(result.estimatedTdee).toBeLessThan(3000);
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
  function makeRepository(
    rows: Record<string, unknown>[] = [],
    bodyRows: Record<string, unknown>[] = [],
  ) {
    const execute = vi.fn().mockResolvedValue(rows);
    const query = vi.fn().mockResolvedValue(bodyRows);
    const db = { execute };
    const repo = new NutritionAnalyticsRepository(db, "user-1", "UTC", undefined, { query });
    return { repo, execute, query };
  }

  describe("getMicronutrientAdequacy", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getMicronutrientAdequacy(30);
      expect(result).toEqual([]);
    });

    it("returns MicronutrientAdequacy instances for tracked nutrients", async () => {
      const { repo } = makeRepository([
        {
          nutrient: "Vitamin C",
          unit: "mg",
          rda: 90,
          avg_intake: 72,
          days_tracked: 25,
        },
      ]);
      const result = await repo.getMicronutrientAdequacy(30);
      // Should filter out nutrients with 0 days tracked
      const vitaminC = result.find((model) => model.nutrient === "Vitamin C");
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

    it("reads micronutrients from the canonical contribution set", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getMicronutrientAdequacy(30);
      expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain(
        "fitness.v_nutrition_canonical_nutrient",
      );
    });
  });

  describe("getMicronutrientSafetyReview", () => {
    it("returns server-owned FDA adequacy and NIH upper-limit statuses", async () => {
      const { repo } = makeRepository([
        {
          nutrient_id: "vitamin_d",
          nutrient: "Vitamin D",
          unit: "mcg",
          avg_total_intake: 120,
          avg_food_intake: 20,
          avg_supplement_intake: 100,
          days_tracked: 10,
        },
      ]);

      const result = await repo.getMicronutrientSafetyReview(30);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(MicronutrientSafetyReview);
      expect(result[0]?.toDetail()).toMatchObject({
        nutrientId: "vitamin_d",
        nutrient: "Vitamin D",
        intake: {
          totalDailyAverage: 120,
          foodDailyAverage: 20,
          supplementDailyAverage: 100,
          daysTracked: 10,
        },
        adequacy: {
          status: "at_or_above_daily_value",
          percentDailyValue: 600,
          reference: {
            type: "daily_value",
            amount: 20,
            population: "Adults and children age 4+",
          },
        },
        upperLimit: {
          status: "at_or_above_limit",
          amount: 100,
          intakeAmount: 120,
          intakeScope: "total",
        },
        safetyStatus: "at_or_above_upper_limit",
      });
    });

    it("does not present a generic below-Daily-Value result as a deficiency assessment", async () => {
      const { repo } = makeRepository([
        {
          nutrient_id: "vitamin_c",
          nutrient: "Vitamin C",
          unit: "mg",
          avg_total_intake: 45,
          avg_food_intake: 45,
          avg_supplement_intake: 0,
          days_tracked: 5,
        },
      ]);

      const result = await repo.getMicronutrientSafetyReview(30);

      expect(result[0]?.toDetail().adequacy).toMatchObject({
        status: "below_daily_value",
        message:
          "Average intake over recorded days is below the FDA Daily Value. This generic label reference is not a personalized deficiency assessment.",
      });
      expect(result[0]?.toDetail().intake.daysTracked).toBe(5);
    });

    it("uses supplemental intake for a supplemental-only upper limit", async () => {
      const { repo } = makeRepository([
        {
          nutrient_id: "magnesium",
          nutrient: "Magnesium",
          unit: "mg",
          avg_total_intake: 700,
          avg_food_intake: 400,
          avg_supplement_intake: 300,
          days_tracked: 7,
        },
      ]);

      const result = await repo.getMicronutrientSafetyReview(30);

      expect(result[0]?.toDetail()).toMatchObject({
        upperLimit: {
          status: "within_limit",
          intakeAmount: 300,
          amount: 350,
          intakeScope: "supplemental_only",
        },
        safetyStatus: "within_upper_limit",
      });
    });

    it("compares the unrounded intake with an upper-limit boundary", async () => {
      const { repo } = makeRepository([
        {
          nutrient_id: "zinc",
          nutrient: "Zinc",
          unit: "mg",
          avg_total_intake: 39.96,
          avg_food_intake: 19.96,
          avg_supplement_intake: 20,
          days_tracked: 7,
        },
      ]);

      const result = await repo.getMicronutrientSafetyReview(30);

      expect(result[0]?.toDetail()).toMatchObject({
        intake: {
          totalDailyAverage: 40,
        },
        upperLimit: {
          status: "within_limit",
          intakeAmount: 39.96,
          amount: 40,
        },
        safetyStatus: "within_upper_limit",
      });
    });

    it("reads food and taken-supplement contributions separately", async () => {
      const { repo, execute } = makeRepository([]);

      await repo.getMicronutrientSafetyReview(30);

      const query = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(query).toContain("fitness.v_nutrition_canonical_nutrient");
      expect(query).toContain("food_entry_id IS NOT NULL");
      expect(query).toContain("supplement_dose_event_id IS NOT NULL");
    });
  });

  describe("getSupplementMedicationReview", () => {
    it("recommends professional review without inferring a specific interaction", async () => {
      const { repo } = makeRepository([
        {
          has_medication_records: true,
          has_supplements: true,
        },
      ]);

      await expect(repo.getSupplementMedicationReview()).resolves.toMatchObject({
        status: "professional_review_recommended",
        message:
          "Review your complete medication and supplement list with a doctor or pharmacist because supplements can interact with medications.",
        limitation:
          "Dofek does not determine whether a specific medication and supplement interact.",
        source: {
          agency: "FDA",
          url: "https://www.fda.gov/consumers/consumer-updates/mixing-medications-and-dietary-supplements-can-endanger-your-health",
        },
      });
    });

    it("reports when no medication records are available", async () => {
      const { repo } = makeRepository([
        {
          has_medication_records: false,
          has_supplements: true,
        },
      ]);

      await expect(repo.getSupplementMedicationReview()).resolves.toMatchObject({
        status: "no_medication_records",
      });
    });
  });

  describe("getAdaptiveTdeeData", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getAdaptiveTdeeData(90);
      expect(result).toEqual([]);
    });

    it("returns data points with weight", async () => {
      const { repo } = makeRepository(
        [{ date: "2024-01-01", calories_in: 2300 }],
        [{ date: "2024-01-01", weight_kg: 80.5 }],
      );
      const result = await repo.getAdaptiveTdeeData(90);
      expect(result).toHaveLength(1);
      expect(result[0]?.caloriesIn).toBe(2300);
      expect(result[0]?.weightKg).toBe(80.5);
    });

    it("handles null weight", async () => {
      const { repo } = makeRepository([{ date: "2024-01-01", calories_in: 2300 }], []);
      const result = await repo.getAdaptiveTdeeData(90);
      expect(result[0]?.weightKg).toBeNull();
    });

    it("reads calories from canonical available days", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getAdaptiveTdeeData(90);
      const query = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(query).toContain("fitness.v_nutrition_daily");
      expect(query).toContain("resolution_status = 'available'");
    });
  });

  describe("getAdaptiveTdee", () => {
    it("returns AdaptiveTdeeEstimate", async () => {
      const { repo } = makeRepository(
        [{ date: "2024-01-01", calories_in: 2000 }],
        [{ date: "2024-01-01", weight_kg: 80 }],
      );
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
      const { repo } = makeRepository(
        [
          {
            date: "2024-03-15",
            protein_g: 150,
            carbs_g: 250,
            fat_g: 70,
            calories: 2230,
          },
        ],
        [{ weight_kg: 80, body_fat_pct: null }],
      );
      const result = await repo.getMacroRatios(30);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(MacroRatioDay);
      const firstResult = result[0];
      if (firstResult == null) throw new Error("result[0] should not be null");
      const detail = firstResult.toDetail();
      // protein: 150*4=600, carbs: 250*4=1000, fat: 70*9=630, total=2230
      expect(detail.proteinPct).toBeCloseTo(26.9, 1);
      expect(detail.carbsPct).toBeCloseTo(44.8, 1);
      expect(detail.fatPct).toBeCloseTo(28.3, 1);
      expect(detail.proteinPerKg).toBeCloseTo(1.88, 2);
    });

    it("handles null weight for proteinPerKg", async () => {
      const { repo } = makeRepository(
        [
          {
            date: "2024-03-15",
            protein_g: 150,
            carbs_g: 250,
            fat_g: 70,
            calories: 2230,
          },
        ],
        [],
      );
      const result = await repo.getMacroRatios(30);
      expect(result[0]?.toDetail().proteinPerKg).toBeNull();
    });

    it("reads macro ratios from canonical available days", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getMacroRatios(30);
      const query = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(query).toContain("fitness.v_nutrition_daily");
      expect(query).toContain("resolution_status = 'available'");
    });
  });
});
