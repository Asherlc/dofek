import { selectedChartRangeInput } from "../lib/date-window.ts";
import { NutritionAnalyticsRepository } from "../repositories/nutrition-analytics-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

// ── Types (kept here for backward compatibility with web/mobile imports) ─

export interface MicronutrientAdequacyRow {
  nutrient: string;
  unit: string;
  rda: number;
  avgIntake: number;
  percentRda: number;
  daysTracked: number;
}

export interface CaloricBalanceRow {
  date: string;
  caloriesIn: number;
  activeEnergy: number;
  basalEnergy: number;
  totalExpenditure: number;
  balance: number;
  rollingAvgBalance: number | null;
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
  micronutrientAdequacy: cachedProtectedQuery(CacheTTL.LONG)
    .input(selectedChartRangeInput("nutritionAnalytics.micronutrientAdequacy"))
    .query(async ({ ctx, input }): Promise<MicronutrientAdequacyRow[]> => {
      const repo = new NutritionAnalyticsRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      const models = await repo.getMicronutrientAdequacy(input.days);
      return models.map((model) => model.toDetail());
    }),

  caloricBalance: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(selectedChartRangeInput("nutritionAnalytics.caloricBalance"))
    .query(async ({ ctx, input }): Promise<CaloricBalanceRow[]> => {
      const repo = new NutritionAnalyticsRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      const models = await repo.getCaloricBalance(input.days);
      return models.map((model) => model.toDetail());
    }),

  adaptiveTdee: cachedProtectedQuery(CacheTTL.LONG)
    .input(selectedChartRangeInput("nutritionAnalytics.adaptiveTdee"))
    .query(async ({ ctx, input }): Promise<AdaptiveTdeeResult> => {
      const repo = new NutritionAnalyticsRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      const estimate = await repo.getAdaptiveTdee(input.days);
      return estimate.toDetail();
    }),

  macroRatios: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(selectedChartRangeInput("nutritionAnalytics.macroRatios"))
    .query(async ({ ctx, input }): Promise<MacroRatioRow[]> => {
      const repo = new NutritionAnalyticsRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      const models = await repo.getMacroRatios(input.days);
      return models.map((model) => model.toDetail());
    }),
});
