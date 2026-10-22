import { healthMetricSchema } from "@dofek/mcp-contracts/health-explorer";
import { z } from "zod";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  dailyMetricsSpo2QueryParams,
  dailyMetricsWithSpo2ClickHouseCte,
} from "./daily-metrics-spo2-query.ts";
import { localDateString } from "./resting-heart-rate-query.ts";

const dataCoverageRowSchema = z.object({
  metric: healthMetricSchema,
  first_observed: z.string().nullable(),
  last_observed: z.string().nullable(),
  total_days_observed: z.coerce.number().int().nonnegative(),
  source_providers: z.array(z.string()),
});

export type DataCoverageRow = z.infer<typeof dataCoverageRowSchema>;

const dailyMetricColumns = {
  hrv: "hrv",
  spo2: "spo2_avg",
  respiratory_rate: "respiratory_rate_avg",
  skin_temp: "skin_temp_c",
  steps: "steps",
  distance_km: "distance_km",
  exercise_minutes: "exercise_minutes",
  flights_climbed: "flights_climbed",
} as const;

const dailyCoverageMetrics = [
  "hrv",
  "spo2",
  "respiratory_rate",
  "skin_temp",
  "steps",
  "distance_km",
  "exercise_minutes",
  "flights_climbed",
] as const satisfies readonly (keyof typeof dailyMetricColumns)[];

function dailyMetricCoverageTuple(metric: keyof typeof dailyMetricColumns): string {
  const column = dailyMetricColumns[metric];
  return `tuple('${metric}',
    nullIf(toString(minIf(date, ${column} IS NOT NULL)), '1970-01-01'),
    nullIf(toString(maxIf(date, ${column} IS NOT NULL)), '1970-01-01'),
    countIf(${column} IS NOT NULL),
    arraySort(arrayDistinct(arrayFlatten(groupArrayIf(source_providers, ${column} IS NOT NULL)))))`;
}

const coverageQuery = `WITH ${dailyMetricsWithSpo2ClickHouseCte(false)}
, daily_metric_coverage AS (
  SELECT arrayJoin([${dailyCoverageMetrics.map(dailyMetricCoverageTuple).join(",\n")}]) AS item
  FROM daily_metrics WHERE user_id = {userId:UUID}
)
SELECT item.1 AS metric, item.2 AS first_observed, item.3 AS last_observed,
  item.4 AS total_days_observed, item.5 AS source_providers
FROM daily_metric_coverage
UNION ALL
SELECT
  'resting_hr' AS metric,
  nullIf(toString(minIf(toDate(toTimeZone(rhr.ended_at, {timezone:String})), rhr.resting_hr IS NOT NULL)), '1970-01-01') AS first_observed,
  nullIf(toString(maxIf(toDate(toTimeZone(rhr.ended_at, {timezone:String})), rhr.resting_hr IS NOT NULL)), '1970-01-01') AS last_observed,
  uniqExactIf(toDate(toTimeZone(rhr.ended_at, {timezone:String})), rhr.resting_hr IS NOT NULL) AS total_days_observed,
  arraySort(groupUniqArrayIf(sleep.provider_id, rhr.resting_hr IS NOT NULL AND sleep.provider_id != '')) AS source_providers
FROM analytics.resting_heart_rate_sleep_window AS rhr FINAL
LEFT JOIN postgres_fitness.sleep_session AS sleep FINAL
  ON sleep.id = rhr.sleep_id
  AND sleep._peerdb_is_deleted = 0
WHERE rhr.user_id = {userId:UUID}
  AND rhr.is_deleted = 0
UNION ALL
SELECT
  'sleep_efficiency' AS metric,
  nullIf(toString(minIf(date, efficiency_pct IS NOT NULL)), '1970-01-01') AS first_observed,
  nullIf(toString(maxIf(date, efficiency_pct IS NOT NULL)), '1970-01-01') AS last_observed,
  countIf(efficiency_pct IS NOT NULL) AS total_days_observed,
  arraySort(arrayDistinct(arrayFlatten(groupArrayIf(source_providers, efficiency_pct IS NOT NULL)))) AS source_providers
FROM analytics.daily_sleep FINAL
WHERE user_id = {userId:UUID}
  AND is_deleted = 0
ORDER BY metric ASC`;

/** Source-aware first/last-observed inventory for MCP health metrics. */
export class DataCoverageRepository {
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #timezone: string;
  readonly #userId: string;

  constructor(store: Pick<ActivitySensorStore, "query">, userId: string, timezone: string) {
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async list(): Promise<DataCoverageRow[]> {
    return this.#store.query(dataCoverageRowSchema, coverageQuery, {
      ...dailyMetricsSpo2QueryParams({
        userId: this.#userId,
        timezone: this.#timezone,
        endDate: localDateString(new Date(), this.#timezone),
        days: null,
      }),
      userId: this.#userId,
      timezone: this.#timezone,
    });
  }
}
