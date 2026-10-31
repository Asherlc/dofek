import { type SQL, sql } from "drizzle-orm";
import { dateWindowStartPredicate } from "../lib/date-window.ts";
import { whoopTemperatureDailyCte } from "./whoop-sensor-repository.ts";

interface TemperatureDailyRow {
  date: string;
  provider_id: string;
  source_name: string | null;
  skin_temp_c: number;
}

/** Resolve one source's daily temperature; do not combine overlapping providers. */
export function dailyMetricsTemperaturePostgresCte(
  rows: TemperatureDailyRow[],
  input: { userId: string; endDate: string; days: number | null },
): SQL {
  const values =
    rows.length > 0
      ? sql`VALUES ${sql.join(
          rows.map(
            (row) =>
              sql`(${row.date}::date, ${row.provider_id}::text, ${row.source_name}::text, ${row.skin_temp_c}::real)`,
          ),
          sql`, `,
        )}`
      : sql`SELECT NULL::date, NULL::text, NULL::text, NULL::real WHERE false`;
  return sql`temperature_sample_daily(date, provider_id, source_name, skin_temp_c) AS (${values}),
    temperature_candidates AS (
      SELECT date, provider_id, source_name, skin_temp_c, 0 AS sample_kind FROM fitness.daily_metrics
      WHERE user_id = ${input.userId} AND skin_temp_c IS NOT NULL
        ${dateWindowStartPredicate(sql`date`, input.endDate, input.days)} AND date <= ${input.endDate}::date
      UNION ALL SELECT *, 1 AS sample_kind FROM temperature_sample_daily
    ), temperature_ranked AS (
      SELECT candidate.*, row_number() OVER (PARTITION BY date ORDER BY
        COALESCE(device.recovery_priority, provider.recovery_priority, device.priority, provider.priority, 100),
        candidate.provider_id, COALESCE(candidate.source_name, ''), sample_kind) AS rank
      FROM temperature_candidates candidate
      LEFT JOIN fitness.provider_priority provider ON provider.provider_id = candidate.provider_id
      LEFT JOIN LATERAL (
        SELECT recovery_priority, priority FROM fitness.device_priority
        WHERE provider_id = candidate.provider_id AND candidate.source_name LIKE source_name_pattern
        ORDER BY length(source_name_pattern) DESC LIMIT 1
      ) device ON true
    ), resolved_temperature AS (SELECT * FROM temperature_ranked WHERE rank = 1),
    daily_metrics AS (
      SELECT COALESCE(dm.date, temperature.date) AS date, ${input.userId}::uuid AS user_id,
        dm.hrv, dm.spo2_avg, dm.respiratory_rate_avg, temperature.skin_temp_c,
        dm.steps, dm.distance_km, dm.flights_climbed, dm.exercise_minutes, dm.stand_hours, dm.walking_speed,
        ARRAY(SELECT DISTINCT provider_id FROM unnest(COALESCE(dm.source_providers, ARRAY[]::text[]) ||
          CASE WHEN temperature.provider_id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[temperature.provider_id] END) provider_id ORDER BY provider_id) AS source_providers
      FROM daily_metrics_without_temperature dm FULL JOIN resolved_temperature temperature ON temperature.date = dm.date
    )`;
}

export function dailyMetricsTemperatureClickHouseCte(includeWindowStart: boolean): string {
  return `${whoopTemperatureDailyCte(includeWindowStart)}, temperature_candidates AS (
    SELECT date, provider_id, source_name, toFloat64(skin_temp_c) AS skin_temp_c, 0 AS sample_kind
    FROM postgres_fitness.daily_metrics FINAL
    WHERE user_id = {userId:UUID} AND _peerdb_is_deleted = 0 AND skin_temp_c IS NOT NULL
      ${includeWindowStart ? "AND date >= toDate({spo2WindowStart:String})" : ""}
      AND date <= toDate({spo2EndDate:String})
    UNION ALL SELECT *, 1 AS sample_kind FROM temperature_sample_daily
  ), temperature_candidate_priority AS (
    SELECT candidate.date AS date, candidate.provider_id AS provider_id, candidate.source_name AS source_name,
      candidate.skin_temp_c AS skin_temp_c, candidate.sample_kind AS sample_kind,
      coalesce(tupleElement(argMax(tuple(device.recovery_priority, device.priority), length(device.source_name_pattern)), 1),
        any(provider.recovery_priority), tupleElement(argMax(tuple(device.recovery_priority, device.priority), length(device.source_name_pattern)), 2), any(provider.priority), 100) AS recovery_priority
    FROM temperature_candidates candidate
    LEFT JOIN spo2_provider_priority provider ON provider.provider_id = candidate.provider_id
    LEFT JOIN spo2_device_priority device ON device.provider_id = candidate.provider_id AND candidate.source_name LIKE device.source_name_pattern
    GROUP BY candidate.date, candidate.provider_id, candidate.source_name, candidate.skin_temp_c, candidate.sample_kind
  ), resolved_temperature AS (
    SELECT priority.date AS date,
      argMin(priority.skin_temp_c, (priority.recovery_priority, priority.provider_id, ifNull(priority.source_name, ''), priority.sample_kind)) AS skin_temp_c,
      argMin(priority.provider_id, (priority.recovery_priority, priority.provider_id, ifNull(priority.source_name, ''), priority.sample_kind)) AS provider_id
    FROM temperature_candidate_priority priority GROUP BY priority.date
  ), daily_metrics AS (
    SELECT coalesce(dm.present_date, temperature.date) AS date, {userId:UUID} AS user_id,
      dm.hrv AS hrv, dm.spo2_avg AS spo2_avg, dm.respiratory_rate_avg AS respiratory_rate_avg,
      if(temperature.provider_id = '', NULL, temperature.skin_temp_c) AS skin_temp_c,
      dm.steps AS steps, dm.distance_km AS distance_km, dm.flights_climbed AS flights_climbed,
      dm.exercise_minutes AS exercise_minutes, dm.stand_hours AS stand_hours, dm.walking_speed AS walking_speed,
      arraySort(arrayDistinct(arrayConcat(dm.source_providers, if(temperature.provider_id = '', [], [temperature.provider_id])))) AS source_providers
    FROM (SELECT *, toNullable(date) AS present_date FROM daily_metrics_without_temperature) dm
    FULL OUTER JOIN resolved_temperature temperature ON temperature.date = dm.date
  )`;
}
