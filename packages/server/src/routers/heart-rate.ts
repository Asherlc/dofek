import { providerLabel } from "@dofek/providers/providers";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const dateInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD date"),
});

const metricStreamRowSchema = z.object({
  provider_id: z.string(),
  recorded_at: timestampStringSchema,
  heart_rate: z.coerce.number(),
});

export interface HeartRateSourceSeries {
  providerId: string;
  providerLabel: string;
  samples: { time: string; heartRate: number }[];
}

export const heartRateRouter = router({
  /**
   * Per-minute heart rate samples for a single day, grouped by source.
   *
   * Queries metric_stream for channel='heart_rate', downsampled to 1-minute
   * bins (avg per bin) to keep payload size reasonable. Returns one series
   * per provider so the client can overlay them for comparison.
   */
  dailyBySource: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(dateInputSchema)
    .query(async ({ ctx, input }): Promise<HeartRateSourceSeries[]> => {
      const rows = await executeWithSchema(
        ctx.db,
        metricStreamRowSchema,
        sql`SELECT
              provider_id,
              date_trunc('minute', recorded_at) AS recorded_at,
              ROUND(AVG(scalar))::int AS heart_rate
            FROM fitness.metric_stream
            WHERE user_id = ${ctx.userId}
              AND channel = 'heart_rate'
              AND recorded_at >= (${input.date}::date::timestamp AT TIME ZONE ${ctx.timezone})
              AND recorded_at < ((${input.date}::date + interval '1 day')::timestamp AT TIME ZONE ${ctx.timezone})
              AND scalar > 0
            GROUP BY provider_id, date_trunc('minute', recorded_at)
            ORDER BY provider_id, recorded_at`,
      );

      if (rows.length === 0) return [];

      // Group by provider
      const byProvider = new Map<string, { time: string; heartRate: number }[]>();
      for (const row of rows) {
        let samples = byProvider.get(row.provider_id);
        if (!samples) {
          samples = [];
          byProvider.set(row.provider_id, samples);
        }
        samples.push({ time: row.recorded_at, heartRate: row.heart_rate });
      }

      return Array.from(byProvider.entries()).map(([providerId, samples]) => ({
        providerId,
        providerLabel: providerLabel(providerId),
        samples,
      }));
    }),
});
