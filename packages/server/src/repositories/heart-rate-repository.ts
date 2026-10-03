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
  sample_count: z.coerce.number().int().positive(),
  min_heart_rate: z.coerce.number().int().positive(),
  avg_heart_rate: z.coerce.number().int().positive(),
  max_heart_rate: z.coerce.number().int().positive(),
});

export interface HeartRateSourceSeries {
  providerId: string;
  providerLabel: string;
  sampleCount: number;
  minHeartRate: number;
  avgHeartRate: number;
  maxHeartRate: number;
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
   * version-deduplicated by native FINAL, including insertion-order ties, but NOT collapsed
   * by provider priority, so every source is returned for overlay/comparison.
   * The day projection identifies raw keys using only identity-safe bounds;
   * deleted and invalid revisions must remain eligible until FINAL picks a winner.
   * Nullable activity keys use a separate IN set because SQL NULL is not an IN match.
   */
  async dailyBySource(date: string): Promise<HeartRateSourceSeries[]> {
    const rows = await this.#clickHouse.query(
      heartRateRowSchema,
      `WITH candidate_keys AS (
        SELECT user_id, activity_id, channel, recorded_at, id
        FROM ingest.metric_stream
        WHERE user_id = {userId:UUID}
          AND channel = 'heart_rate'
          AND recorded_at >= toDateTime({date:Date}, {timezone:String})
          AND recorded_at < toDateTime({date:Date}, {timezone:String}) + INTERVAL 1 DAY
      ), winning_rows AS (
        SELECT provider_id, recorded_at, scalar, is_deleted
        FROM ingest.metric_stream FINAL
        WHERE user_id = {userId:UUID}
          AND (
            (user_id, activity_id, channel, recorded_at, id) IN (
              SELECT user_id, activity_id, channel, recorded_at, id
              FROM candidate_keys WHERE activity_id IS NOT NULL
            )
            OR (
              activity_id IS NULL
              AND (user_id, channel, recorded_at, id) IN (
                SELECT user_id, channel, recorded_at, id
                FROM candidate_keys WHERE activity_id IS NULL
              )
            )
          )
      ), minute_samples AS (
        SELECT
          provider_id,
          toStartOfMinute(toDateTime(recorded_at)) AS minute_bucket,
          toInt32(round(avg(scalar))) AS heart_rate
        FROM winning_rows
        WHERE is_deleted = 0
          AND scalar > 0
        GROUP BY provider_id, minute_bucket
      )
      SELECT
          provider_id,
          -- minute buckets always have zero sub-seconds; hardcode .000 so the
          -- ISO-8601 string matches the existing client contract regardless of
          -- ClickHouse's formatDateTime second-precision behavior.
          formatDateTime(minute_bucket, '%Y-%m-%dT%H:%i:%S.000Z') AS recorded_at,
          heart_rate,
          count() OVER (PARTITION BY provider_id) AS sample_count,
          min(heart_rate) OVER (PARTITION BY provider_id) AS min_heart_rate,
          toInt32(round(avg(heart_rate) OVER (PARTITION BY provider_id))) AS avg_heart_rate,
          max(heart_rate) OVER (PARTITION BY provider_id) AS max_heart_rate
        FROM minute_samples
        ORDER BY provider_id, minute_bucket`,
      { userId: this.#userId, timezone: this.#timezone, date },
    );

    const byProvider = new Map<
      string,
      Pick<
        HeartRateSourceSeries,
        "sampleCount" | "minHeartRate" | "avgHeartRate" | "maxHeartRate" | "samples"
      >
    >();
    for (const row of rows) {
      let source = byProvider.get(row.provider_id);
      if (!source) {
        source = {
          sampleCount: row.sample_count,
          minHeartRate: row.min_heart_rate,
          avgHeartRate: row.avg_heart_rate,
          maxHeartRate: row.max_heart_rate,
          samples: [],
        };
        byProvider.set(row.provider_id, source);
      }
      source.samples.push({ time: row.recorded_at, heartRate: row.heart_rate });
    }

    return Array.from(byProvider.entries()).map(([providerId, source]) => ({
      providerId,
      providerLabel: providerLabel(providerId),
      ...source,
    }));
  }
}
