import { selectedChartRangeQuery } from "../lib/chart-range.ts";
import { NutritionAnalyticsRepository } from "../repositories/nutrition-analytics-repository.ts";
import { CacheTTL, router } from "../trpc.ts";

// ── Types (kept here for backward compatibility with web/mobile imports) ─

export interface MicronutrientAdequacyRow {
  nutrient: string;
  unit: string;
  rda: number;
  avgIntake: number;
  percentRda: number;
  daysTracked: number;
}

export interface AdaptiveTdeeResult {
  estimatedTdee: number | null;
  confidence: number;
  dataPoints: number;
  dailyData: AdaptiveTdeeRow[];
}

export interface AdaptiveTdeeRow {
  date: string;
  caloriesIn: number;
  weightKg: number | null;
  smoothedWeight: number | null;
  estimatedTdee: number | null;
}

export interface MacroRatioRow {
  date: string;
  proteinPct: number;
  carbsPct: number;
  fatPct: number;
  proteinPerKg: number | null;
}

// ── Router ───────────────────────────────────────────────────────────

export const nutritionAnalyticsRouter = router({
  micronutrientAdequacy: selectedChartRangeQuery(
    "nutritionAnalytics.micronutrientAdequacy",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<MicronutrientAdequacyRow[]> => {
      const repo = new NutritionAnalyticsRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      const models = await repo.getMicronutrientAdequacy(range.days);
      return models.map((model) => model.toDetail());
    },
  ),

  adaptiveTdee: selectedChartRangeQuery(
    "nutritionAnalytics.adaptiveTdee",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<AdaptiveTdeeResult> => {
      const repo = new NutritionAnalyticsRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      const estimate = await repo.getAdaptiveTdee(range.days);
      return estimate.toDetail();
    },
  ),

  macroRatios: selectedChartRangeQuery(
    "nutritionAnalytics.macroRatios",
    CacheTTL.MEDIUM,
    async ({ ctx, range }): Promise<MacroRatioRow[]> => {
      const repo = new NutritionAnalyticsRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      const models = await repo.getMacroRatios(range.days);
      return models.map((model) => model.toDetail());
    },
  ),
});
