import type {
  ActivitySensorStore,
  ActivitySensorWindow,
  StreamPointRow,
} from "./activity-repository.ts";

interface ClickHouseJsonResult<TRow> {
  json(): Promise<TRow[]>;
}

export interface ClickHouseQueryClient {
  query<TRow extends object>(options: {
    query: string;
    format: "JSONEachRow";
    query_params: Record<string, unknown>;
  }): Promise<ClickHouseJsonResult<TRow>>;
}

interface PowerZoneSecondRow {
  zone: number;
  seconds: number;
}

function queryParams(window: ActivitySensorWindow, extra: Record<string, unknown>) {
  return {
    userId: window.userId,
    memberActivityIds: window.memberActivityIds,
    startedAt: window.startedAt,
    endedAt: window.endedAt ?? new Date().toISOString(),
    ...extra,
  };
}

function normalizeClickHouseTimestamp(value: string): string {
  const timestamp = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return new Date(timestamp).toISOString();
}

function dedupedSamplesSql(channelPredicate = "1 = 1"): string {
  return `
    WITH
    linked_best_source AS (
      SELECT channel, provider_id
      FROM (
        SELECT
          channel,
          provider_id,
          count() AS sample_count,
          row_number() OVER (
            PARTITION BY channel
            ORDER BY count() DESC, provider_id ASC
          ) AS row_number
        FROM fitness.metric_stream AS metric_stream FINAL
        WHERE metric_stream.user_id = {userId:UUID}
          AND metric_stream.activity_id IN {memberActivityIds:Array(UUID)}
          AND metric_stream.scalar IS NOT NULL
          AND ${channelPredicate}
        GROUP BY metric_stream.channel, metric_stream.provider_id
      )
      WHERE row_number = 1
    ),
    ambient_best_source AS (
      SELECT channel, provider_id
      FROM (
        SELECT
          channel,
          provider_id,
          count() AS sample_count,
          row_number() OVER (
            PARTITION BY channel
            ORDER BY count() DESC, provider_id ASC
          ) AS row_number
        FROM fitness.metric_stream AS metric_stream FINAL
        WHERE metric_stream.user_id = {userId:UUID}
          AND metric_stream.activity_id IS NULL
          AND metric_stream.recorded_at >= parseDateTime64BestEffort({startedAt:String})
          AND metric_stream.recorded_at <= parseDateTime64BestEffort({endedAt:String})
          AND metric_stream.scalar IS NOT NULL
          AND ${channelPredicate}
          AND metric_stream.channel NOT IN (SELECT channel FROM linked_best_source)
        GROUP BY metric_stream.channel, metric_stream.provider_id
      )
      WHERE row_number = 1
    ),
    linked_samples AS (
      SELECT
        recorded_at,
        channel,
        max(metric_stream.scalar) AS scalar
      FROM fitness.metric_stream AS metric_stream FINAL
      INNER JOIN linked_best_source USING (channel, provider_id)
      WHERE metric_stream.user_id = {userId:UUID}
        AND metric_stream.activity_id IN {memberActivityIds:Array(UUID)}
        AND metric_stream.scalar IS NOT NULL
        AND ${channelPredicate}
      GROUP BY recorded_at, channel
    ),
    ambient_samples AS (
      SELECT
        recorded_at,
        channel,
        max(metric_stream.scalar) AS scalar
      FROM fitness.metric_stream AS metric_stream FINAL
      INNER JOIN ambient_best_source USING (channel, provider_id)
      WHERE metric_stream.user_id = {userId:UUID}
        AND metric_stream.activity_id IS NULL
        AND metric_stream.recorded_at >= parseDateTime64BestEffort({startedAt:String})
        AND metric_stream.recorded_at <= parseDateTime64BestEffort({endedAt:String})
        AND metric_stream.scalar IS NOT NULL
        AND ${channelPredicate}
      GROUP BY recorded_at, channel
    ),
    deduped_samples AS (
      SELECT recorded_at, channel, scalar FROM linked_samples
      UNION ALL
      SELECT recorded_at, channel, scalar FROM ambient_samples
    )
  `;
}

export class ClickHouseActivitySensorStore implements ActivitySensorStore {
  readonly #client: ClickHouseQueryClient;

  constructor(client: ClickHouseQueryClient) {
    this.#client = client;
  }

  async getStream(window: ActivitySensorWindow, maxPoints: number): Promise<StreamPointRow[]> {
    const result = await this.#client.query<StreamPointRow>({
      query: `
        ${dedupedSamplesSql(
          "metric_stream.channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude', 'lat', 'lng')",
        )}
        SELECT
          toString(recorded_at) AS recorded_at,
          heart_rate,
          power,
          speed,
          cadence,
          altitude,
          lat,
          lng
        FROM (
          SELECT
            *,
            row_number() OVER (ORDER BY recorded_at) AS row_number,
            count() OVER () AS total
          FROM (
            SELECT
              recorded_at,
              maxIf(scalar, channel = 'heart_rate') AS heart_rate,
              maxIf(scalar, channel = 'power') AS power,
              maxIf(scalar, channel = 'speed') AS speed,
              maxIf(scalar, channel = 'cadence') AS cadence,
              maxIf(scalar, channel = 'altitude') AS altitude,
              maxIf(scalar, channel = 'lat') AS lat,
              maxIf(scalar, channel = 'lng') AS lng
            FROM deduped_samples
            GROUP BY recorded_at
          )
        )
        WHERE row_number % greatest(1, intDiv(total, {maxPoints:UInt32})) = 0
        ORDER BY recorded_at
      `,
      format: "JSONEachRow",
      query_params: queryParams(window, { maxPoints }),
    });
    const rows = await result.json();
    return rows.map((row) => ({
      ...row,
      recorded_at: normalizeClickHouseTimestamp(row.recorded_at),
    }));
  }

  async getPowerZoneSeconds(
    window: ActivitySensorWindow,
    ftp: number,
  ): Promise<PowerZoneSecondRow[]> {
    const result = await this.#client.query<PowerZoneSecondRow>({
      query: `
        ${dedupedSamplesSql("metric_stream.channel = 'power'")}
        SELECT
          zone,
          countIf(
            CASE zone
              WHEN 1 THEN scalar < {ftp:Float64} * 0.55
              WHEN 2 THEN scalar >= {ftp:Float64} * 0.55 AND scalar < {ftp:Float64} * 0.75
              WHEN 3 THEN scalar >= {ftp:Float64} * 0.75 AND scalar < {ftp:Float64} * 0.9
              WHEN 4 THEN scalar >= {ftp:Float64} * 0.9 AND scalar < {ftp:Float64} * 1.05
              WHEN 5 THEN scalar >= {ftp:Float64} * 1.05 AND scalar < {ftp:Float64} * 1.2
              WHEN 6 THEN scalar >= {ftp:Float64} * 1.2 AND scalar < {ftp:Float64} * 1.5
              WHEN 7 THEN scalar >= {ftp:Float64} * 1.5
              ELSE false
            END
          ) AS seconds
        FROM (SELECT number + 1 AS zone FROM numbers(7)) AS zones
        LEFT JOIN (SELECT scalar FROM deduped_samples) AS power_samples ON true
        GROUP BY zone
        ORDER BY zone
      `,
      format: "JSONEachRow",
      query_params: queryParams(window, { ftp }),
    });
    return result.json();
  }
}
