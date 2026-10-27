import { computeCyclingPowerWork } from "@dofek/training/cycling-workout-metrics";
import {
  type SportVolumeMetric,
  type SportVolumeResult,
  sportVolumeMetrics,
} from "@dofek/training/sport-volume";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import type { RangeDays } from "../lib/date-window.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

const activitySchema = z.object({
  id: z.string(),
  sport: z.string(),
  modality: z.string().nullable(),
  week: z.string(),
  started_milliseconds: z.coerce.number(),
  duration_seconds: z.coerce.number().nullable(),
  distance_meters: z.coerce.number().nullable(),
  elevation_meters: z.coerce.number().nullable(),
});
const powerSchema = z.object({
  id: z.string(),
  samples: z.array(z.tuple([z.number(), z.number().nullable()])),
});

/** Weekly sport volume from canonical activities and existing sensor projections. */
export class SportVolumeRepository {
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #accessWindow: AccessWindow;
  constructor(
    store: Pick<ActivitySensorStore, "query">,
    userId: string,
    timezone: string,
    accessWindow: AccessWindow,
  ) {
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#accessWindow = accessWindow;
  }

  async getVolume(input: {
    days: RangeDays;
    sport?: string;
    metric: SportVolumeMetric;
  }): Promise<SportVolumeResult> {
    const rows = await this.#store.query(
      activitySchema,
      `SELECT
      toString(activity.activity_id) AS id, activity.canonical_type AS sport, activity.modality AS modality,
      toString(toMonday(toDate(toTimeZone(activity.started_at, {timezone:String})))) AS week,
      toUnixTimestamp64Milli(activity.started_at) AS started_milliseconds,
      if(activity.ended_at >= activity.started_at, dateDiff('millisecond', activity.started_at, activity.ended_at) / 1000, NULL) AS duration_seconds,
      summary.total_distance AS distance_meters, summary.elevation_gain_m AS elevation_meters
      FROM analytics.deduped_activities activity FINAL
      LEFT JOIN analytics.activity_summary summary ON summary.activity_id = activity.activity_id AND summary.user_id = activity.user_id
      WHERE activity.user_id = {userId:UUID} AND activity.is_deleted = 0
        AND activity.canonical_type NOT IN ('climbing', 'strength')
        AND toDate(toTimeZone(activity.started_at, {timezone:String})) <= toDate(now(), {timezone:String})
        AND ({days:Nullable(Int32)} IS NULL OR toDate(toTimeZone(activity.started_at, {timezone:String})) > subtractDays(toDate(now(), {timezone:String}), {days:Nullable(Int32)}))
        AND ({accessFull:Bool} OR (toDate(toTimeZone(activity.started_at, {timezone:String})) >= toDate({accessStart:Nullable(String)}) AND toDate(toTimeZone(activity.started_at, {timezone:String})) < toDate({accessEnd:Nullable(String)})))
      ORDER BY week, id SETTINGS join_use_nulls = 1`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        days: input.days,
        ...(this.#accessWindow.kind === "limited"
          ? {
              accessFull: false,
              accessStart: this.#accessWindow.startDate,
              accessEnd: this.#accessWindow.endDateExclusive,
            }
          : { accessFull: true, accessStart: null, accessEnd: null }),
      },
    );
    const sports = [...new Set(rows.map((row) => row.sport))].sort();
    const sport = input.sport ?? sports[0] ?? null;
    const metrics = sportVolumeMetrics(sport ?? "other");
    const definition = metrics.find((metric) => metric.key === input.metric);
    if (!definition) throw new Error(`${input.metric} volume is not supported for ${sport}.`);
    const selected = rows.filter((row) => row.sport === sport);
    const work = new Map<string, number | null>();
    if (input.metric === "work" && selected.length) {
      const powerRows = await this.#store.query(
        powerSchema,
        `SELECT toString(activity_id) AS id,
        groupArray(tuple(toUnixTimestamp64Milli(recorded_at), scalar)) AS samples
        FROM analytics.activity_sensor_sample FINAL
        WHERE user_id = {userId:UUID} AND activity_id IN {activityIds:Array(UUID)}
          AND channel = 'power' AND is_deleted = 0 GROUP BY activity_id`,
        {
          userId: this.#userId,
          activityIds: selected.map((row) => row.id),
        },
      );
      const samples = new Map(powerRows.map((row) => [row.id, row.samples]));
      for (const row of selected) {
        const nativeSamples = samples.get(row.id);
        if (nativeSamples === undefined) {
          work.set(row.id, null);
          continue;
        }
        const observations = nativeSamples.map(([timestamp, powerWatts]) => ({
          elapsedSeconds: (timestamp - row.started_milliseconds) / 1000,
          powerWatts,
        }));
        const result = computeCyclingPowerWork(
          observations,
          row.duration_seconds ?? 0,
          observations
            .filter((sample) => sample.powerWatts == null || sample.powerWatts < 0)
            .map((sample) => sample.elapsedSeconds),
        );
        work.set(row.id, result.coverage.missingSeconds === 0 ? result.workKilojoules : null);
      }
    }
    const weeks = new Map<string, number | null>();
    for (const row of selected) {
      if (!weeks.has(row.week)) weeks.set(row.week, 0);
      const indoorCycling =
        sport === "cycling" && (row.modality === "indoor" || row.modality === "virtual");
      if (indoorCycling && (input.metric === "distance" || input.metric === "elevation")) continue;
      // The activity summary uses zero as an indoor/virtual distance sentinel, not an observation.
      if (
        (row.modality === "indoor" || row.modality === "virtual") &&
        input.metric === "distance"
      ) {
        weeks.set(row.week, null);
        continue;
      }
      const value =
        input.metric === "time"
          ? row.duration_seconds == null
            ? null
            : row.duration_seconds / 60
          : input.metric === "distance"
            ? row.distance_meters == null
              ? null
              : row.distance_meters / 1000
            : input.metric === "elevation"
              ? row.elevation_meters
              : (work.get(row.id) ?? null);
      const previous = weeks.get(row.week);
      weeks.set(row.week, previous == null || value == null || value < 0 ? null : previous + value);
    }
    // A week consisting solely of indoor rides has no outdoor distance or elevation observation.
    if (sport === "cycling" && (input.metric === "distance" || input.metric === "elevation")) {
      for (const week of weeks.keys())
        if (
          !selected.some(
            (row) => row.week === week && row.modality !== "indoor" && row.modality !== "virtual",
          )
        )
          weeks.set(week, null);
    }
    return {
      sport,
      sports,
      metric: input.metric,
      metrics,
      unit: definition.unit,
      weeks: [...weeks].map(([week, value]) => ({ week, value })),
    };
  }
}
