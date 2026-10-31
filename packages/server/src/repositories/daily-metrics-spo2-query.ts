import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
  dateWindowStartPredicate,
  dateWindowStartString,
  type RangeDays,
} from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  dailyMetricsTemperatureClickHouseCte,
  dailyMetricsTemperaturePostgresCte,
} from "./daily-metrics-temperature-query.ts";
import { whoopTemperatureDailyCte } from "./whoop-sensor-repository.ts";

const sampleDailySchema = z.object({
  date: dateStringSchema,
  provider_id: z.string(),
  source_name: z.string().nullable(),
  spo2_avg: z.coerce.number().nullable(),
  skin_temp_c: z.coerce.number().nullable(),
});

interface DailyMetricsSourceInput {
  sensorStore: Pick<ActivitySensorStore, "query">;
  userId: string;
  timezone: string;
  endDate: string;
  days: RangeDays;
}

function sampleDailyClickHouseCte(includeWindowStart: boolean): string {
  // Native HealthKit and Apple Health XML retain fractions; their existing
  // aggregateSpO2ToDailyMetrics path also converts those raw fractions to percent.
  return `spo2_current_samples AS (
    SELECT id, recorded_at, provider_id, device_id AS source_name,
      if(provider_id = 'apple_health', scalar * 100, scalar) AS spo2_percent
    FROM ingest.metric_stream FINAL
    WHERE user_id = {userId:UUID} AND channel = 'spo2'
      ${includeWindowStart ? "AND recorded_at >= toDateTime64({spo2WindowStart:String}, 6, {timezone:String})" : ""}
      AND recorded_at < toDateTime64(addDays(toDate({spo2EndDate:String}), 1), 6, {timezone:String})
      AND is_deleted = 0 AND spo2_percent > 0 AND spo2_percent <= 100 AND isFinite(spo2_percent)
  ),
  spo2_timestamp_samples AS (
    SELECT recorded_at, provider_id, source_name, argMin(spo2_percent, id) AS scalar
    FROM spo2_current_samples
    GROUP BY recorded_at, provider_id, source_name
  ),
  spo2_sample_daily AS (
    SELECT toDate(toTimeZone(recorded_at, {timezone:String})) AS date,
      provider_id, source_name, avg(scalar) AS spo2_avg
    FROM spo2_timestamp_samples
    GROUP BY date, provider_id, source_name
  )`;
}

/** Read-only overlay: current sensor samples never become PostgreSQL daily state. */
export async function fetchDailyMetricsWithSpo2Cte(input: DailyMetricsSourceInput): Promise<SQL> {
  const rows = await input.sensorStore.query(
    sampleDailySchema,
    `WITH ${sampleDailyClickHouseCte(input.days !== null)}, ${whoopTemperatureDailyCte(input.days !== null)}
     SELECT toString(date) AS date, provider_id, source_name, spo2_avg, CAST(NULL AS Nullable(Float64)) AS skin_temp_c FROM spo2_sample_daily
     UNION ALL SELECT toString(date), provider_id, source_name, CAST(NULL AS Nullable(Float64)), skin_temp_c FROM temperature_sample_daily`,
    dailyMetricsSpo2QueryParams(input),
  );
  const oxygen = rows.filter((row) => row.spo2_avg != null);
  const temperatures = rows.flatMap((row) =>
    row.skin_temp_c != null
      ? [
          {
            date: row.date,
            provider_id: row.provider_id,
            source_name: row.source_name,
            skin_temp_c: row.skin_temp_c,
          },
        ]
      : [],
  );
  const sampleValues =
    oxygen.length > 0
      ? sql`VALUES ${sql.join(
          oxygen.map(
            (row) =>
              sql`(${row.date}::date, ${row.provider_id}::text, ${row.source_name}::text, ${row.spo2_avg}::real)`,
          ),
          sql`, `,
        )}`
      : sql`SELECT NULL::date, NULL::text, NULL::text, NULL::real WHERE false`;
  return sql`spo2_sample_daily(date, provider_id, source_name, spo2_avg) AS (${sampleValues}),
    spo2_candidates AS (
      SELECT date, provider_id, source_name, spo2_avg, 0 AS sample_kind
      FROM fitness.daily_metrics
      WHERE user_id = ${input.userId} AND spo2_avg > 0 AND spo2_avg <= 100
        ${dateWindowStartPredicate(sql`date`, input.endDate, input.days)}
        AND date <= ${input.endDate}::date
      UNION ALL SELECT *, 1 AS sample_kind FROM spo2_sample_daily
    ),
    spo2_ranked AS (
      SELECT candidate.*, row_number() OVER (PARTITION BY date ORDER BY
        COALESCE(device.recovery_priority, provider.recovery_priority, device.priority, provider.priority, 100),
        candidate.provider_id, COALESCE(candidate.source_name, ''), sample_kind) AS rank
      FROM spo2_candidates candidate
      LEFT JOIN fitness.provider_priority provider ON provider.provider_id = candidate.provider_id
      LEFT JOIN LATERAL (
        SELECT recovery_priority, priority FROM fitness.device_priority
        WHERE provider_id = candidate.provider_id AND candidate.source_name LIKE source_name_pattern
        ORDER BY length(source_name_pattern) DESC LIMIT 1
      ) device ON true
    ),
    resolved_spo2 AS (SELECT * FROM spo2_ranked WHERE rank = 1),
    daily_metrics_without_temperature AS (
      SELECT COALESCE(dm.date, oxygen.date) AS date, ${input.userId}::uuid AS user_id,
        dm.hrv, oxygen.spo2_avg, dm.respiratory_rate_avg, dm.skin_temp_c,
        dm.steps, dm.distance_km, dm.flights_climbed, dm.exercise_minutes, dm.stand_hours, dm.walking_speed,
        ARRAY(SELECT DISTINCT provider_id FROM unnest(COALESCE(dm.source_providers, ARRAY[]::text[]) ||
          CASE WHEN oxygen.provider_id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[oxygen.provider_id] END) provider_id ORDER BY provider_id) AS source_providers
      FROM (SELECT * FROM fitness.v_daily_metrics WHERE user_id = ${input.userId}
        ${dateWindowStartPredicate(sql`date`, input.endDate, input.days)} AND date <= ${input.endDate}::date) dm
      FULL JOIN resolved_spo2 oxygen ON oxygen.date = dm.date
    ), ${dailyMetricsTemperaturePostgresCte(temperatures, input)}`;
}

export function dailyMetricsSpo2QueryParams(
  input: Omit<DailyMetricsSourceInput, "sensorStore">,
): Record<string, unknown> {
  return {
    userId: input.userId,
    timezone: input.timezone,
    spo2EndDate: input.endDate,
    ...(input.days !== null
      ? { spo2WindowStart: dateWindowStartString(input.endDate, Math.max(0, input.days - 1)) }
      : {}),
  };
}

/** The same source selection for ClickHouse consumers with a caller-selected timezone. */
export function dailyMetricsWithSpo2ClickHouseCte(includeWindowStart: boolean): string {
  return `${sampleDailyClickHouseCte(includeWindowStart)},
  spo2_provider_priority AS (SELECT * FROM postgres_fitness.provider_priority FINAL WHERE _peerdb_is_deleted = 0),
  spo2_device_priority AS (SELECT * FROM postgres_fitness.device_priority FINAL WHERE _peerdb_is_deleted = 0),
  spo2_candidates AS (
    SELECT date, provider_id, source_name, toFloat64(spo2_avg) AS spo2_avg, 0 AS sample_kind
    FROM postgres_fitness.daily_metrics FINAL
    WHERE user_id = {userId:UUID} AND _peerdb_is_deleted = 0 AND spo2_avg > 0 AND spo2_avg <= 100
      ${includeWindowStart ? "AND date >= toDate({spo2WindowStart:String})" : ""}
      AND date <= toDate({spo2EndDate:String})
    UNION ALL SELECT *, 1 AS sample_kind FROM spo2_sample_daily
  ),
  spo2_candidate_priority AS (
    SELECT candidate.date AS date, candidate.provider_id AS provider_id, candidate.source_name AS source_name,
      candidate.spo2_avg AS spo2_avg, candidate.sample_kind AS sample_kind,
      coalesce(tupleElement(argMax(tuple(device.recovery_priority, device.priority), length(device.source_name_pattern)), 1),
        any(provider.recovery_priority), tupleElement(argMax(tuple(device.recovery_priority, device.priority), length(device.source_name_pattern)), 2), any(provider.priority), 100) AS recovery_priority
    FROM spo2_candidates candidate
    LEFT JOIN spo2_provider_priority provider ON provider.provider_id = candidate.provider_id
    LEFT JOIN spo2_device_priority device ON device.provider_id = candidate.provider_id
      AND candidate.source_name LIKE device.source_name_pattern
    GROUP BY candidate.date, candidate.provider_id, candidate.source_name, candidate.spo2_avg, candidate.sample_kind
  ),
  resolved_spo2 AS (
    SELECT priority.date AS date, argMin(priority.spo2_avg, (priority.recovery_priority, priority.provider_id, ifNull(priority.source_name, ''), priority.sample_kind)) AS spo2_avg,
      argMin(priority.provider_id, (priority.recovery_priority, priority.provider_id, ifNull(priority.source_name, ''), priority.sample_kind)) AS provider_id
    FROM spo2_candidate_priority priority GROUP BY priority.date
  ),
  daily_metric_dates AS (
    SELECT date FROM analytics.v_daily_metrics WHERE user_id = {userId:UUID}
      ${includeWindowStart ? "AND date >= toDate({spo2WindowStart:String})" : ""}
      AND date <= toDate({spo2EndDate:String})
    UNION DISTINCT SELECT date FROM resolved_spo2
  ),
  daily_metrics_without_temperature AS (
    SELECT dates.date AS date, {userId:UUID} AS user_id,
      dm.hrv AS hrv, if(oxygen.provider_id = '', NULL, oxygen.spo2_avg) AS spo2_avg,
      dm.respiratory_rate_avg AS respiratory_rate_avg, dm.skin_temp_c AS skin_temp_c,
      dm.steps AS steps, dm.distance_km AS distance_km, dm.flights_climbed AS flights_climbed,
      dm.exercise_minutes AS exercise_minutes, dm.stand_hours AS stand_hours, dm.walking_speed AS walking_speed,
      arraySort(arrayDistinct(arrayConcat(dm.source_providers, if(oxygen.provider_id = '', [], [oxygen.provider_id])))) AS source_providers
    FROM daily_metric_dates dates
    LEFT JOIN analytics.v_daily_metrics dm ON dm.user_id = {userId:UUID} AND dm.date = dates.date
    LEFT JOIN resolved_spo2 oxygen ON oxygen.date = dates.date
  ), ${dailyMetricsTemperatureClickHouseCte(includeWindowStart)}`;
}
