import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowStartString } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

const restingHeartRateRowSchema = z.object({
  date: dateStringSchema,
  resting_hr: z.coerce.number(),
});

export type RestingHeartRateRow = z.infer<typeof restingHeartRateRowSchema>;

interface FetchRestingHeartRateRowsInput {
  sensorStore: Pick<ActivitySensorStore, "query">;
  userId: string;
  timezone: string;
  endDate: string;
  days: number;
}

export async function fetchRestingHeartRateRows({
  sensorStore,
  userId,
  timezone,
  endDate,
  days,
}: FetchRestingHeartRateRowsInput): Promise<RestingHeartRateRow[]> {
  return sensorStore.query(
    restingHeartRateRowSchema,
    `WITH ${restingHeartRateClickHouseCte()}
    SELECT date, resting_hr
    FROM resting_heart_rate
    ORDER BY date ASC`,
    {
      userId,
      timezone,
      rhrEndDate: endDate,
      rhrWindowStart: dateWindowStartString(endDate, days),
    },
  );
}

export async function fetchRestingHeartRateValuesCte(
  input: FetchRestingHeartRateRowsInput,
): Promise<SQL> {
  return restingHeartRateValuesCte(await fetchRestingHeartRateRows(input));
}

export function restingHeartRateClickHouseCte(): string {
  return `sleep_windows AS (
      SELECT
        user_id,
        toString(toDate(toTimeZone(ended_at, {timezone:String}))) AS date,
        started_at,
        ended_at
      FROM analytics.v_sleep
      WHERE user_id = {userId:UUID}
        AND is_nap = false
        AND ended_at IS NOT NULL
        AND toDate(toTimeZone(ended_at, {timezone:String})) > toDate({rhrWindowStart:String})
        AND toDate(toTimeZone(ended_at, {timezone:String})) <= toDate({rhrEndDate:String})
    ),
    heart_rate_samples AS (
      SELECT
        sleep_windows.date AS date,
        samples.scalar AS heart_rate
      FROM sleep_windows
      INNER JOIN analytics.deduped_sensor AS samples
        ON samples.user_id = sleep_windows.user_id
       AND samples.recorded_at >= sleep_windows.started_at
       AND samples.recorded_at <= sleep_windows.ended_at
      WHERE samples.channel = 'heart_rate'
        AND samples.scalar IS NOT NULL
    ),
    resting_heart_rate AS (
      SELECT
      date,
      toInt32(round(arrayAvg(arraySlice(
        arraySort(groupArray(toFloat64(heart_rate))),
        1,
        greatest(toInt32(ceil(count() * 0.10)), 1)
      )))) AS resting_hr
      FROM heart_rate_samples
      GROUP BY date
      HAVING count() >= 30
    )`;
}

export function restingHeartRateValuesCte(rows: RestingHeartRateRow[]): SQL {
  if (rows.length === 0) {
    return sql`resting_heart_rate AS (
      SELECT NULL::date AS date, NULL::real AS resting_hr
      WHERE false
    )`;
  }

  const values = rows.map((row) => sql`(${row.date}::date, ${row.resting_hr}::real)`);
  return sql`resting_heart_rate(date, resting_hr) AS (VALUES ${sql.join(values, sql`, `)})`;
}

export function localDateString(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    return date.toISOString().slice(0, 10);
  }
  return `${year}-${month}-${day}`;
}
