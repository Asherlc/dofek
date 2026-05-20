import { TrainingStressCalculator } from "@dofek/training/training-load";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import { osmTileUrl } from "../lib/osm-tile.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ActivityLocation {
  centroidLat: number;
  centroidLng: number;
  tileUrl: string;
  distanceMeters: number | null;
  elevationGainM: number | null;
}

export interface ActivityStat {
  label: string;
  value: string;
}

export interface CalendarActivityEntry {
  id: string;
  name: string | null;
  activityType: string;
  startedAt: string;
  endedAt: string | null;
  durationMin: number;
  location: ActivityLocation | null;
  calories: number | null;
  tss: number | null;
  stats: ActivityStat[];
}

export interface CalendarDayActivities {
  date: string;
  activities: CalendarActivityEntry[];
}

// ---------------------------------------------------------------------------
// Internal schemas
// ---------------------------------------------------------------------------

const activityRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  activity_type: z.string(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  duration_min: z.coerce.number(),
  avg_hr: z.coerce.number().nullable(),
  max_hr: z.coerce.number().nullable(),
  avg_power: z.coerce.number().nullable(),
  total_distance: z.coerce.number().nullable(),
  elevation_gain_m: z.coerce.number().nullable(),
  local_date: dateStringSchema,
});

const locationRowSchema = z.object({
  activity_id: z.string(),
  centroid_lat: z.coerce.number(),
  centroid_lng: z.coerce.number(),
});

const caloriesRowSchema = z.object({
  id: z.string(),
  calories: z.coerce.number().nullable(),
});

const baselineRowSchema = z.object({
  max_hr: z.coerce.number().nullable(),
  resting_hr: z.coerce.number().nullable(),
  ftp: z.coerce.number().nullable(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface WeekListInput {
  weeks: number;
  endDate: string;
}

/** Per-activity calendar data (location for outdoor, calories + TSS otherwise). */
export class ActivitiesCalendarRepository extends BaseRepository {
  readonly #sensorStore: ActivitySensorStore;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    sensorStore: ActivitySensorStore,
    accessWindow?: ConstructorParameters<typeof BaseRepository>[3],
  ) {
    super(db, userId, timezone, accessWindow);
    this.#sensorStore = sensorStore;
  }

  async getWeekList(input: WeekListInput): Promise<CalendarDayActivities[]> {
    const days = input.weeks * 7;
    const windowStart = dateWindowStartString(input.endDate, days);

    const [activityRows, baselineRows] = await Promise.all([
      this.#sensorStore.query(
        activityRowSchema,
        `SELECT
            toString(asum.activity_id) AS id,
            asum.name AS name,
            asum.activity_type AS activity_type,
            toString(asum.started_at) AS started_at,
            toString(asum.ended_at) AS ended_at,
            dateDiff('second', asum.started_at, asum.ended_at) / 60.0 AS duration_min,
            asum.avg_hr AS avg_hr,
            asum.max_hr AS max_hr,
            asum.avg_power AS avg_power,
            asum.total_distance AS total_distance,
            asum.elevation_gain_m AS elevation_gain_m,
            toString(toDate(toTimeZone(asum.started_at, {timezone:String}))) AS local_date
          FROM analytics.activity_summary asum
          WHERE asum.user_id = {userId:UUID}
            AND asum.ended_at IS NOT NULL
            AND toDate(toTimeZone(asum.started_at, {timezone:String})) >= toDate({windowStart:String})
          ORDER BY asum.started_at DESC`,
        {
          userId: this.userId,
          timezone: this.timezone,
          windowStart,
        },
      ),
      this.#sensorStore.query(
        baselineRowSchema,
        `SELECT
            up.max_hr AS max_hr,
            up.resting_hr AS resting_hr,
            up.ftp AS ftp
          FROM postgres_fitness.user_profile_current up
          WHERE up.id = {userId:UUID}`,
        { userId: this.userId },
      ),
    ]);

    const activityIds = activityRows.map((row) => row.id);
    const [locationRows, caloriesRows] = await Promise.all([
      this.#fetchLocationCentroids(activityIds),
      this.#fetchCaloriesByActivityId(activityIds),
    ]);

    const locationByActivityId = new Map(locationRows.map((row) => [row.activity_id, row]));
    const caloriesByActivityId = new Map(
      caloriesRows.map((row) => [row.id, row.calories] as const),
    );

    const baseline = baselineRows[0] ?? { max_hr: null, resting_hr: null, ftp: null };
    const calculator = new TrainingStressCalculator();

    const dayMap = new Map<string, CalendarActivityEntry[]>();
    for (const row of activityRows) {
      const location = locationByActivityId.get(row.id);
      const calories = caloriesByActivityId.get(row.id) ?? null;
      const tss = computeActivityTss({
        durationMin: row.duration_min,
        avgPower: row.avg_power,
        avgHr: row.avg_hr,
        maxHr: row.max_hr,
        baselineMaxHr: baseline.max_hr,
        baselineRestingHr: baseline.resting_hr,
        ftp: baseline.ftp,
        calculator,
      });

      const entry: CalendarActivityEntry = {
        id: row.id,
        name: row.name,
        activityType: row.activity_type,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        durationMin: Math.round(row.duration_min * 10) / 10,
        location: location
          ? {
              centroidLat: location.centroid_lat,
              centroidLng: location.centroid_lng,
              tileUrl: osmTileUrl(location.centroid_lat, location.centroid_lng),
              distanceMeters: row.total_distance,
              elevationGainM: row.elevation_gain_m,
            }
          : null,
        calories,
        tss: tss != null ? Math.round(tss * 10) / 10 : null,
        stats: formatActivityStats(tss, calories),
      };

      const bucket = dayMap.get(row.local_date) ?? [];
      bucket.push(entry);
      dayMap.set(row.local_date, bucket);
    }

    return Array.from(dayMap.entries())
      .map(([date, activities]) => ({ date, activities }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  async #fetchLocationCentroids(activityIds: string[]) {
    if (activityIds.length === 0) return [];
    return this.#sensorStore.query(
      locationRowSchema,
      `SELECT
          toString(activity_id) AS activity_id,
          avg(lat) AS centroid_lat,
          avg(lng) AS centroid_lng
        FROM analytics.deduped_location
        WHERE user_id = {userId:UUID}
          AND activity_id IN ({activityIds:Array(UUID)})
          AND lat IS NOT NULL
          AND lng IS NOT NULL
        GROUP BY activity_id`,
      { userId: this.userId, activityIds },
    );
  }

  async #fetchCaloriesByActivityId(activityIds: string[]) {
    if (activityIds.length === 0) return [];
    const activityIdFilter = sql.join(
      activityIds.map((activityId) => sql`${activityId}::uuid`),
      sql`, `,
    );
    return this.query(
      caloriesRowSchema,
      sql`SELECT
            a.id::text AS id,
            NULLIF(a.raw->>'calories', '')::numeric AS calories
          FROM fitness.activity a
          WHERE a.user_id = ${this.userId}::uuid
            AND a.id IN (${activityIdFilter})
            AND a.raw ? 'calories'`,
    );
  }
}

// ---------------------------------------------------------------------------
// TSS computation (server-side, per CLAUDE.md "Server-side metric computation")
// ---------------------------------------------------------------------------

interface TssInput {
  durationMin: number;
  avgPower: number | null;
  avgHr: number | null;
  maxHr: number | null;
  baselineMaxHr: number | null;
  baselineRestingHr: number | null;
  ftp: number | null;
  calculator: TrainingStressCalculator;
}

function computeActivityTss(input: TssInput): number | null {
  if (input.durationMin <= 0) return null;
  if (input.avgPower != null && input.avgPower > 0 && input.ftp != null && input.ftp > 0) {
    return TrainingStressCalculator.computePowerTss(input.avgPower, input.ftp, input.durationMin);
  }
  const effectiveMaxHr = input.baselineMaxHr ?? input.maxHr;
  const effectiveRestingHr = input.baselineRestingHr ?? 60;
  if (
    input.avgHr != null &&
    input.avgHr > 0 &&
    effectiveMaxHr != null &&
    effectiveMaxHr > effectiveRestingHr
  ) {
    return input.calculator.computeHrTss(
      input.durationMin,
      input.avgHr,
      effectiveMaxHr,
      effectiveRestingHr,
    );
  }
  return null;
}

function formatActivityStats(tss: number | null, calories: number | null): ActivityStat[] {
  const roundedTss = tss != null ? Math.round(tss * 10) / 10 : null;
  return [
    {
      label: "Training Stress Score",
      value: roundedTss != null ? formatStatNumber(roundedTss) : "—",
    },
    { label: "Calories", value: calories != null ? `${Math.round(calories)} kcal` : "—" },
  ];
}

function formatStatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
