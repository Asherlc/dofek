import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface SmoothedWeightRow {
  date: string;
  rawWeight: number;
  smoothedWeight: number;
  weeklyChange: number | null;
}

export interface BodyRecompositionRow {
  date: string;
  weightKg: number;
  bodyFatPct: number;
  fatMassKg: number;
  leanMassKg: number;
  smoothedFatMass: number;
  smoothedLeanMass: number;
}

export interface WeightRateOfChange {
  currentWeekly: number | null;
  current4Week: number | null;
  trend: "gaining" | "losing" | "stable" | "insufficient";
}

// ── Router ───────────────────────────────────────────────────────────

export const bodyAnalyticsRouter = router({
  /**
   * Smoothed weight trend using exponentially-weighted moving average.
   * Filters out daily fluctuations (water, food timing) to show the
   * real trend. Similar to MacroFactor / Happy Scale approach.
   */
  smoothedWeight: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<SmoothedWeightRow[]> => {
      const rows = await ctx.db.execute<{ date: string; weight_kg: number }>(
        sql`SELECT DISTINCT ON (recorded_at::date)
              recorded_at::date::text AS date,
              weight_kg
            FROM fitness.v_body_measurement
            WHERE user_id = ${ctx.userId}
              AND weight_kg IS NOT NULL
              AND recorded_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            ORDER BY recorded_at::date, recorded_at DESC`,
      );

      const data = rows.map((r) => ({
        date: r.date,
        rawWeight: Number(r.weight_kg),
      }));

      if (data.length === 0) return [];

      // EWMA smoothing (alpha = 0.1 — heavy smoothing for daily weigh-ins)
      const alpha = 0.1;
      const result: SmoothedWeightRow[] = [];
      const firstDay = data[0];
      if (!firstDay) return [];
      let smoothed = firstDay.rawWeight;

      for (let i = 0; i < data.length; i++) {
        const day = data[i];
        if (!day) continue;
        if (i === 0) {
          smoothed = day.rawWeight;
        } else {
          smoothed = alpha * day.rawWeight + (1 - alpha) * smoothed;
        }

        // Weekly rate of change: compare smoothed weight to 7 days ago
        let weeklyChange: number | null = null;
        if (i >= 7) {
          const prevSmoothedEntry = result[i - 7];
          if (prevSmoothedEntry) {
            weeklyChange = Math.round((smoothed - prevSmoothedEntry.smoothedWeight) * 100) / 100;
          }
        }

        result.push({
          date: day.date,
          rawWeight: Math.round(day.rawWeight * 100) / 100,
          smoothedWeight: Math.round(smoothed * 100) / 100,
          weeklyChange,
        });
      }

      return result;
    }),

  /**
   * Body recomposition: fat mass vs lean mass trends.
   * Derives fat mass (weight * body_fat_pct) and lean mass (weight - fat mass)
   * from measurements that have both weight and body fat data.
   */
  recomposition: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }): Promise<BodyRecompositionRow[]> => {
      const rows = await ctx.db.execute<{ date: string; weight_kg: number; body_fat_pct: number }>(
        sql`SELECT DISTINCT ON (recorded_at::date)
              recorded_at::date::text AS date,
              weight_kg,
              body_fat_pct
            FROM fitness.v_body_measurement
            WHERE user_id = ${ctx.userId}
              AND weight_kg IS NOT NULL
              AND body_fat_pct IS NOT NULL
              AND recorded_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            ORDER BY recorded_at::date, recorded_at DESC`,
      );

      const data = rows.map((r) => ({
        date: r.date,
        weightKg: Number(r.weight_kg),
        bodyFatPct: Number(r.body_fat_pct),
      }));

      if (data.length === 0) return [];

      const alpha = 0.15;
      const result: BodyRecompositionRow[] = [];
      const firstRecomp = data[0];
      if (!firstRecomp) return [];
      let smoothedFat = firstRecomp.weightKg * (firstRecomp.bodyFatPct / 100);
      let smoothedLean = firstRecomp.weightKg - smoothedFat;

      for (let i = 0; i < data.length; i++) {
        const day = data[i];
        if (!day) continue;
        const fatMass = day.weightKg * (day.bodyFatPct / 100);
        const leanMass = day.weightKg - fatMass;

        if (i === 0) {
          smoothedFat = fatMass;
          smoothedLean = leanMass;
        } else {
          smoothedFat = alpha * fatMass + (1 - alpha) * smoothedFat;
          smoothedLean = alpha * leanMass + (1 - alpha) * smoothedLean;
        }

        result.push({
          date: day.date,
          weightKg: Math.round(day.weightKg * 100) / 100,
          bodyFatPct: Math.round(day.bodyFatPct * 10) / 10,
          fatMassKg: Math.round(fatMass * 100) / 100,
          leanMassKg: Math.round(leanMass * 100) / 100,
          smoothedFatMass: Math.round(smoothedFat * 100) / 100,
          smoothedLeanMass: Math.round(smoothedLean * 100) / 100,
        });
      }

      return result;
    }),

  /**
   * Weight rate of change summary.
   * Current weekly and 4-week rates, plus overall trend direction.
   */
  weightTrend: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({}).default({}))
    .query(async ({ ctx }): Promise<WeightRateOfChange> => {
      const rows = await ctx.db.execute<{ date: string; weight_kg: number }>(
        sql`SELECT DISTINCT ON (recorded_at::date)
              recorded_at::date::text AS date,
              weight_kg
            FROM fitness.v_body_measurement
            WHERE user_id = ${ctx.userId}
              AND weight_kg IS NOT NULL
              AND recorded_at > NOW() - INTERVAL '35 days'
            ORDER BY recorded_at::date, recorded_at DESC`,
      );

      const data = rows.map((r) => ({
        date: r.date,
        weight: Number(r.weight_kg),
      }));

      if (data.length < 7) {
        return {
          currentWeekly: null,
          current4Week: null,
          trend: "insufficient",
        };
      }

      // EWMA-smooth the data
      const alpha = 0.1;
      const smoothed: number[] = [];
      const firstWeight = data[0];
      if (!firstWeight) return { currentWeekly: null, current4Week: null, trend: "insufficient" };
      let s = firstWeight.weight;
      for (const d of data) {
        s = alpha * d.weight + (1 - alpha) * s;
        smoothed.push(s);
      }

      const latest = smoothed[smoothed.length - 1];
      if (latest === undefined)
        return { currentWeekly: null, current4Week: null, trend: "insufficient" };
      const oneWeekAgo = smoothed.length >= 8 ? (smoothed[smoothed.length - 8] ?? null) : null;
      const fourWeeksAgo = smoothed.length >= 29 ? (smoothed[smoothed.length - 29] ?? null) : null;

      const currentWeekly =
        oneWeekAgo != null ? Math.round((latest - oneWeekAgo) * 100) / 100 : null;
      const current4Week =
        fourWeeksAgo != null ? Math.round((latest - fourWeeksAgo) * 100) / 100 : null;

      const changeRef = currentWeekly ?? current4Week;
      let trend: WeightRateOfChange["trend"] = "stable";
      if (changeRef != null) {
        if (changeRef > 0.1) trend = "gaining";
        else if (changeRef < -0.1) trend = "losing";
      }

      return { currentWeekly, current4Week, trend };
    }),
});
