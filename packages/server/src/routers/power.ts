import { sql } from "drizzle-orm";
import { z } from "zod";
import { DURATION_LABELS } from "../lib/duration-labels.ts";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import { type CriticalPowerModel, fitCriticalPower } from "../lib/math.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { CriticalPowerModel };

// ── Zod schemas for DB results ───────────────────────────────

const powerCurveSampleSchema = z.object({
  activity_id: z.string(),
  activity_date: z.string(),
  power: z.coerce.number(),
  interval_s: z.coerce.number(),
});

const normalizedPowerSampleSchema = z.object({
  activity_id: z.string(),
  activity_date: z.string(),
  activity_name: z.string().nullable(),
  power: z.coerce.number(),
  interval_s: z.coerce.number(),
});

// ── Standard durations for power curve ───────────────────────

const DURATIONS = [5, 15, 30, 60, 120, 180, 300, 420, 600, 1200, 1800, 3600, 5400, 7200];

// ── Data fetchers (simple indexed queries) ───────────────────

/**
 * Fetch per-sample power data for power curve computation.
 * Includes zero-power (coasting) samples. Returns samples ordered
 * by activity then time, with the per-activity recording interval.
 */
function powerCurveSamplesQuery(days: number, userId: string) {
  return sql`
    WITH activity_info AS (
      SELECT a.id AS activity_id,
             a.started_at::date::text AS activity_date,
             GREATEST(ROUND(
               EXTRACT(EPOCH FROM MAX(ms.recorded_at) - MIN(ms.recorded_at))::numeric
               / NULLIF(COUNT(*) - 1, 0)
             )::int, 1) AS interval_s
      FROM fitness.metric_stream ms
      JOIN fitness.v_activity a ON a.id = ms.activity_id
      WHERE a.user_id = ${userId}
        AND ms.power IS NOT NULL
        AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
        AND ms.recorded_at > NOW() - (${days} + 1)::int * INTERVAL '1 day'
        AND ${enduranceTypeFilter("a")}
      GROUP BY a.id, a.started_at
      HAVING COUNT(*) > 1
    )
    SELECT ms.activity_id,
           ai.activity_date,
           COALESCE(ms.power, 0) AS power,
           ai.interval_s
    FROM fitness.metric_stream ms
    JOIN activity_info ai ON ai.activity_id = ms.activity_id
    WHERE ms.power IS NOT NULL
      AND ms.recorded_at > NOW() - (${days} + 1)::int * INTERVAL '1 day'
    ORDER BY ms.activity_id, ms.recorded_at
  `;
}

/**
 * Fetch per-sample power data for Normalized Power computation.
 * Excludes zero-power samples (coasting) since they'd artificially
 * lower Normalized Power. Only includes activities with >= 240 power-positive samples
 * (~20 min at any sample rate).
 */
function normalizedPowerSamplesQuery(days: number, userId: string) {
  return sql`
    WITH activity_info AS (
      SELECT a.id AS activity_id,
             a.started_at::date::text AS activity_date,
             a.name AS activity_name,
             GREATEST(ROUND(
               EXTRACT(EPOCH FROM MAX(ms.recorded_at) - MIN(ms.recorded_at))::numeric
               / NULLIF(COUNT(*) - 1, 0)
             )::int, 1) AS interval_s
      FROM fitness.metric_stream ms
      JOIN fitness.v_activity a ON a.id = ms.activity_id
      WHERE a.user_id = ${userId}
        AND ms.power > 0
        AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
        AND ms.recorded_at > NOW() - (${days} + 1)::int * INTERVAL '1 day'
        AND ${enduranceTypeFilter("a")}
      GROUP BY a.id, a.started_at, a.name
      HAVING COUNT(*) >= 240
    )
    SELECT ms.activity_id,
           ai.activity_date,
           ai.activity_name,
           ms.power,
           ai.interval_s
    FROM fitness.metric_stream ms
    JOIN activity_info ai ON ai.activity_id = ms.activity_id
    WHERE ms.power > 0
      AND ms.recorded_at > NOW() - (${days} + 1)::int * INTERVAL '1 day'
    ORDER BY ms.activity_id, ms.recorded_at
  `;
}

// ── App-side computation ─────────────────────────────────────

interface ActivityGroup<T> {
  rows: T[];
  activityDate: string;
  intervalSeconds: number;
}

/** Group pre-sorted samples by activity_id in a single pass. */
function groupByActivity<
  T extends { activity_id: string; activity_date: string; interval_s: number },
>(samples: T[]): ActivityGroup<T>[] {
  const groups: ActivityGroup<T>[] = [];
  let current: ActivityGroup<T> | null = null;

  for (const sample of samples) {
    if (!current || current.rows.at(0)?.activity_id !== sample.activity_id) {
      current = {
        rows: [],
        activityDate: sample.activity_date,
        intervalSeconds: sample.interval_s,
      };
      groups.push(current);
    }
    current.rows.push(sample);
  }

  return groups;
}

/**
 * Compute best average power for each standard duration across all activities.
 * Uses prefix sums for O(N × D) performance where N = total samples, D = 14 durations.
 */
function computePowerCurve(samples: z.infer<typeof powerCurveSampleSchema>[]) {
  const activities = groupByActivity(samples);
  const bestPerDuration = new Map<number, { power: number; date: string }>();

  for (const { rows, activityDate, intervalSeconds } of activities) {
    const n = rows.length;

    // Build prefix sums (indices are always in bounds due to loop constraints)
    const cumsum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      cumsum[i + 1] = (cumsum[i] ?? 0) + (rows[i]?.power ?? 0);
    }

    for (const duration of DURATIONS) {
      const windowSize = Math.round(duration / intervalSeconds);
      if (windowSize > n || windowSize < 1) continue;

      let maxAvg = 0;
      for (let i = windowSize; i <= n; i++) {
        const avg = ((cumsum[i] ?? 0) - (cumsum[i - windowSize] ?? 0)) / windowSize;
        if (avg > maxAvg) maxAvg = avg;
      }

      if (maxAvg > 0) {
        const prev = bestPerDuration.get(duration);
        if (!prev || maxAvg > prev.power) {
          bestPerDuration.set(duration, { power: Math.round(maxAvg), date: activityDate });
        }
      }
    }
  }

  return DURATIONS.flatMap((d) => {
    const best = bestPerDuration.get(d);
    if (!best) return [];
    return [{ durationSeconds: d, bestPower: best.power, activityDate: best.date }];
  });
}

/**
 * Compute Normalized Power per activity using 30-second rolling averages.
 * NP = (mean(rolling_30s_avg^4))^0.25 — accounts for the metabolic cost
 * of variable-intensity efforts.
 */
function computeNormalizedPower(samples: z.infer<typeof normalizedPowerSampleSchema>[]) {
  const activities = groupByActivity(samples);
  const results: { activityDate: string; activityName: string | null; normalizedPower: number }[] =
    [];

  for (const { rows, activityDate, intervalSeconds } of activities) {
    const windowSize = Math.max(1, Math.round(30 / intervalSeconds));
    const n = rows.length;

    // Build prefix sums (indices are always in bounds due to loop constraints)
    const cumsum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      cumsum[i + 1] = (cumsum[i] ?? 0) + (rows[i]?.power ?? 0);
    }

    // 4th power of rolling averages
    let sum4thPower = 0;
    let count = 0;
    for (let i = windowSize; i <= n; i++) {
      const avg = ((cumsum[i] ?? 0) - (cumsum[i - windowSize] ?? 0)) / windowSize;
      sum4thPower += avg ** 4;
      count++;
    }

    if (count === 0) continue;
    const normalizedPower = Math.round((sum4thPower / count) ** 0.25 * 10) / 10;

    results.push({
      activityDate,
      activityName: rows[0]?.activity_name ?? null,
      normalizedPower,
    });
  }

  results.sort((a, b) => a.activityDate.localeCompare(b.activityDate));
  return results;
}

// ── Router ───────────────────────────────────────────────────

export const powerRouter = router({
  /**
   * Power Duration Curve: best average power for standard durations.
   * Fetches raw samples then computes via prefix sums in app code.
   */
  powerCurve: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const samples = await executeWithSchema(
        ctx.db,
        powerCurveSampleSchema,
        powerCurveSamplesQuery(input.days, ctx.userId),
      );

      const results = computePowerCurve(samples);

      return {
        points: results.map((r) => ({
          durationSeconds: r.durationSeconds,
          label: DURATION_LABELS[r.durationSeconds] ?? `${r.durationSeconds}s`,
          bestPower: r.bestPower,
          activityDate: r.activityDate,
        })),
        model: fitCriticalPower(results),
      };
    }),

  /**
   * eFTP trend: estimated Functional Threshold Power over time.
   * Uses per-activity Normalized Power (NP) × 0.95.
   *
   * NP accounts for the metabolic cost of interval efforts via the
   * fourth-power of 30s rolling averages. For interval-heavy training,
   * NP is significantly higher than average power and better reflects
   * the athlete's actual sustainable output.
   */
  eftpTrend: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }) => {
      const normalizedPowerSamples = await executeWithSchema(
        ctx.db,
        normalizedPowerSampleSchema,
        normalizedPowerSamplesQuery(input.days, ctx.userId),
      );

      const normalizedPowerResults = computeNormalizedPower(normalizedPowerSamples);

      const trend = normalizedPowerResults.map((r) => ({
        date: r.activityDate,
        eftp: Math.round(r.normalizedPower * 0.95),
        activityName: r.activityName,
      }));

      // Compute current eFTP via CP model from last 90 days' power curve
      const pcSamples = await executeWithSchema(
        ctx.db,
        powerCurveSampleSchema,
        powerCurveSamplesQuery(90, ctx.userId),
      );

      const pcResults = computePowerCurve(pcSamples);
      const model = fitCriticalPower(pcResults);

      // Fall back to 95% of best recent 20-min power if CP model can't fit
      let currentEftp: number | null = model?.cp ?? null;
      if (currentEftp == null) {
        const recent = trend.filter((t) => {
          const date = new Date(t.date);
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - 90);
          return date >= cutoff;
        });
        currentEftp = recent.length > 0 ? Math.max(...recent.map((t) => t.eftp)) : null;
      }

      return { trend, currentEftp, model };
    }),
});
