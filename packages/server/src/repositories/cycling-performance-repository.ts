import { z } from "zod";
import type { ActivitySensorStore } from "./activity-repository.ts";

const rideRowSchema = z.object({
  activity_id: z.string(),
  activity_date: z.string(),
  activity_name: z.string().nullable(),
  modality: z.string().nullable(),
  elapsed_seconds: z.coerce.number(),
  average_power: z.coerce.number().nullable(),
  normalized_power: z.coerce.number().nullable(),
  elevation_gain_meters: z.coerce.number().nullable(),
});

const effortRowSchema = z.object({
  activity_id: z.string(),
  activity_date: z.string(),
  duration_seconds: z.coerce.number(),
  best_power: z.coerce.number(),
});

const powerAvailabilityRowSchema = z.object({
  modality: z.enum(["indoor", "outdoor", "unknown"]),
  first_observed: z.string().nullable(),
  last_observed: z.string().nullable(),
  activities_with_power: z.coerce.number().int().nonnegative(),
  activities_total: z.coerce.number().int().nonnegative(),
  source_providers: z.array(z.string()),
});

const EFFORT_LABELS = { 5: "5s", 60: "1m", 300: "5m", 1200: "20m" } as const;
type EffortLabel = (typeof EFFORT_LABELS)[keyof typeof EFFORT_LABELS];
type EffortBest = { activity_id: string; date: string; watts: number };

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentage(observed: number, total: number): number {
  return total === 0 ? 0 : round((observed / total) * 100, 1);
}

function emptyEfforts(): Record<EffortLabel, number | null> {
  return { "5s": null, "1m": null, "5m": null, "20m": null };
}

function effortLabel(durationSeconds: number): EffortLabel | null {
  if (durationSeconds === 5) return EFFORT_LABELS[5];
  if (durationSeconds === 60) return EFFORT_LABELS[60];
  if (durationSeconds === 300) return EFFORT_LABELS[300];
  if (durationSeconds === 1200) return EFFORT_LABELS[1200];
  return null;
}

const ridesQuery = `
SELECT
  toString(activity_id) AS activity_id,
  toString(toDate(toTimeZone(started_at, {timezone:String}))) AS activity_date,
  activity_name AS activity_name,
  modality AS modality,
  elapsed_seconds AS elapsed_seconds,
  average_power AS average_power,
  normalized_power AS normalized_power,
  elevation_gain_meters AS elevation_gain_meters
FROM analytics.cycling_activity FINAL
WHERE user_id = {userId:UUID}
  AND is_deleted = 0
  AND toDate(toTimeZone(started_at, {timezone:String})) BETWEEN
    toDate({lookbackStartDate:String}) AND toDate({endDate:String})
ORDER BY started_at ASC`;

const effortsQuery = `
SELECT
  toString(activity_id) AS activity_id,
  toString(toDate(toTimeZone(started_at, {timezone:String}))) AS activity_date,
  duration_seconds AS duration_seconds,
  best_power AS best_power
FROM analytics.activity_power_curve FINAL
WHERE user_id = {userId:UUID}
  AND is_deleted = 0
  AND duration_seconds IN (5, 60, 300, 1200)
  AND toDate(toTimeZone(started_at, {timezone:String})) BETWEEN
    toDate({lookbackStartDate:String}) AND toDate({endDate:String})
ORDER BY started_at ASC, duration_seconds ASC`;

const powerAvailabilityQuery = `
WITH
  multiIf(
    modality IN ('indoor', 'virtual'), 'indoor',
    modality IN ('outdoor', 'road', 'mountain'), 'outdoor',
    'unknown'
  ) AS power_modality,
  (power_samples > 0 OR average_power IS NOT NULL OR normalized_power IS NOT NULL OR best_twenty_minute_power IS NOT NULL) AS has_power
SELECT
  power_modality AS modality,
  nullIf(toString(minIf(toDate(toTimeZone(started_at, {timezone:String})), has_power)), '1970-01-01') AS first_observed,
  nullIf(toString(maxIf(toDate(toTimeZone(started_at, {timezone:String})), has_power)), '1970-01-01') AS last_observed,
  countIf(has_power) AS activities_with_power,
  count() AS activities_total,
  arraySort(arrayDistinct(arrayFlatten(groupArrayIf(source_providers, has_power)))) AS source_providers
FROM analytics.cycling_activity FINAL
WHERE user_id = {userId:UUID}
  AND is_deleted = 0
GROUP BY power_modality
ORDER BY power_modality ASC`;

function emptyPowerAvailability(): {
  first_observed: string | null;
  last_observed: string | null;
  activities_with_power: number;
  activities_total: number;
  pct: number;
  source_providers: string[];
} {
  return {
    first_observed: null,
    last_observed: null,
    activities_with_power: 0,
    activities_total: 0,
    pct: 0,
    source_providers: [],
  };
}

/** Exact-range cycling analytics derived from deduped ClickHouse read models. */
export class CyclingPerformanceRepository {
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(store: Pick<ActivitySensorStore, "query">, userId: string, timezone: string) {
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async listRange(startDate: string, endDate: string) {
    const lookbackStartDate = daysBefore(endDate, 89);
    const params = {
      userId: this.#userId,
      timezone: this.#timezone,
      lookbackStartDate,
      startDate,
      endDate,
    };
    const [rideRows, effortRows, powerAvailabilityRows] = await Promise.all([
      this.#store.query(rideRowSchema, ridesQuery, params),
      this.#store.query(effortRowSchema, effortsQuery, params),
      this.#store.query(powerAvailabilityRowSchema, powerAvailabilityQuery, params),
    ]);

    const effortsByActivity = new Map<string, Record<EffortLabel, number | null>>();
    for (const effort of effortRows) {
      const label = effortLabel(effort.duration_seconds);
      if (!label) continue;
      const efforts = effortsByActivity.get(effort.activity_id) ?? emptyEfforts();
      efforts[label] = effort.best_power;
      effortsByActivity.set(effort.activity_id, efforts);
    }

    const requestedRides = rideRows.filter(
      (ride) => ride.activity_date >= startDate && ride.activity_date <= endDate,
    );
    const activities = requestedRides.map((ride) => {
      const ftpWindowStart = daysBefore(ride.activity_date, 89);
      const twentyMinuteBest = effortRows
        .filter(
          (effort) =>
            effort.duration_seconds === 1200 &&
            effort.activity_date >= ftpWindowStart &&
            effort.activity_date <= ride.activity_date,
        )
        .reduce<number | null>(
          (best, effort) => (best === null || effort.best_power > best ? effort.best_power : best),
          null,
        );
      const estimatedFtp = twentyMinuteBest === null ? null : round(twentyMinuteBest * 0.95, 1);
      return {
        activity_id: ride.activity_id,
        date: ride.activity_date,
        name: ride.activity_name,
        modality: ride.modality,
        duration_minutes: round(ride.elapsed_seconds / 60, 1),
        average_power_watts: ride.average_power,
        normalized_power_watts: ride.normalized_power,
        estimated_ftp_watts: estimatedFtp,
        estimated_ftp_source: estimatedFtp === null ? null : "rolling_90_day_best_20_min_x_0.95",
        intensity_factor:
          ride.normalized_power === null || estimatedFtp === null || estimatedFtp <= 0
            ? null
            : round(ride.normalized_power / estimatedFtp, 3),
        elevation_gain_m: ride.elevation_gain_meters,
        best_efforts_watts: effortsByActivity.get(ride.activity_id) ?? emptyEfforts(),
      };
    });

    const rollingBest: Record<EffortLabel, EffortBest | null> = {
      "5s": null,
      "1m": null,
      "5m": null,
      "20m": null,
    };
    for (const effort of effortRows) {
      const label = effortLabel(effort.duration_seconds);
      if (!label) continue;
      const current = rollingBest[label];
      if (current === null || effort.best_power > current.watts) {
        rollingBest[label] = {
          activity_id: effort.activity_id,
          date: effort.activity_date,
          watts: effort.best_power,
        };
      }
    }

    const activitiesWithPower = activities.filter(
      (activity) =>
        activity.average_power_watts !== null ||
        activity.normalized_power_watts !== null ||
        Object.values(activity.best_efforts_watts).some((value) => value !== null),
    ).length;
    const elevations = activities.flatMap((activity) =>
      activity.elevation_gain_m === null ? [] : [activity.elevation_gain_m],
    );
    const totalElevation =
      elevations.length === 0
        ? null
        : round(
            elevations.reduce((sum, value) => sum + value, 0),
            1,
          );
    const powerAvailabilityByModality = {
      indoor: emptyPowerAvailability(),
      outdoor: emptyPowerAvailability(),
      unknown: emptyPowerAvailability(),
    };
    for (const row of powerAvailabilityRows) {
      powerAvailabilityByModality[row.modality] = {
        first_observed: row.first_observed,
        last_observed: row.last_observed,
        activities_with_power: row.activities_with_power,
        activities_total: row.activities_total,
        pct: percentage(row.activities_with_power, row.activities_total),
        source_providers: row.source_providers,
      };
    }

    return {
      activities,
      rolling_90_day_best: rollingBest,
      summary: {
        power_coverage: {
          activities_with_power: activitiesWithPower,
          activities_total: activities.length,
          pct: percentage(activitiesWithPower, activities.length),
        },
        power_availability_by_modality: powerAvailabilityByModality,
        elevation_gain: {
          total_elevation_gain_m: totalElevation,
          avg_elevation_gain_m:
            totalElevation === null ? null : round(totalElevation / elevations.length, 1),
          coverage: {
            activities_with_elevation: elevations.length,
            activities_total: activities.length,
            pct: percentage(elevations.length, activities.length),
          },
        },
      },
    };
  }
}
