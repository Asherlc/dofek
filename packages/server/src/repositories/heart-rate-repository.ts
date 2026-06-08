import { providerLabel } from "@dofek/providers/providers";
import { z } from "zod";
import { timestampStringSchema } from "../lib/typed-sql.ts";

/**
 * Minimal ClickHouse read surface this repository needs. Satisfied by
 * `ActivitySensorStore`, but narrowed so the repository depends only on the
 * raw-query escape hatch (interface segregation).
 */
export interface MetricStreamClickHouseReader {
  query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params?: Record<string, unknown>,
  ): Promise<z.infer<TSchema>[]>;
}

const heartRateRowSchema = z.object({
  provider_id: z.string(),
  recorded_at: timestampStringSchema,
  heart_rate: z.coerce.number(),
});

export interface HeartRateSourceSeries {
  providerId: string;
  providerLabel: string;
  samples: { time: string; heartRate: number }[];
}

export class HeartRateRepository {
  readonly #clickHouse: MetricStreamClickHouseReader;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(clickHouse: MetricStreamClickHouseReader, userId: string, timezone: string) {
    this.#clickHouse = clickHouse;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /**
   * Per-minute heart rate samples for a single day, grouped by source.
   *
   * Reads the Redpanda-fed ClickHouse metric-stream mirror for
   * channel='heart_rate', downsampled to 1-minute bins (avg per bin). Rows are
   * version-deduplicated (`FINAL` + `_peerdb_is_deleted = 0`) but NOT collapsed
   * by provider priority, so every source is returned for overlay/comparison.
   */
  async dailyBySource(date: string): Promise<HeartRateSourceSeries[]> {
    const rows = await this.#clickHouse.query(
      heartRateRowSchema,
      `SELECT
          provider_id,
          formatDateTime(minute_bucket, '%Y-%m-%dT%H:%i:%SZ') AS recorded_at,
          toInt32(round(avg(scalar))) AS heart_rate
        FROM (
          SELECT
            provider_id,
            toStartOfMinute(toDateTime(recorded_at)) AS minute_bucket,
            scalar
          FROM postgres_fitness.metric_stream FINAL
          WHERE user_id = {userId:String}
            AND channel = 'heart_rate'
            AND _peerdb_is_deleted = 0
            AND scalar > 0
            AND toDate(recorded_at, {timezone:String}) = {date:Date}
        )
        GROUP BY provider_id, minute_bucket
        ORDER BY provider_id, minute_bucket`,
      { userId: this.#userId, timezone: this.#timezone, date },
    );

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
  }
}
