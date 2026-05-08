import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

export const restingHeartRateRowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  resting_hr: z.coerce.number(),
});

export type RestingHeartRateRow = z.infer<typeof restingHeartRateRowSchema>;

export interface RestingHeartRateQueryStore {
  query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params?: Record<string, unknown>,
  ): Promise<z.infer<TSchema>[]>;
}

interface FetchRestingHeartRateRowsInput {
  queryStore: RestingHeartRateQueryStore;
  userId: string;
  timezone: string;
  endDate: string;
  days: number;
}

export async function fetchRestingHeartRateRowsFromClickHouse({
  queryStore,
  userId,
  timezone,
  endDate,
  days,
}: FetchRestingHeartRateRowsInput): Promise<RestingHeartRateRow[]> {
  return queryStore.query(
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

export function restingHeartRateClickHouseCte(): string {
  return `raw_sleep_windows AS (
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
    sleep_windows AS (
      SELECT user_id, date, started_at, ended_at
      FROM raw_sleep_windows
      ORDER BY user_id, date, dateDiff('second', started_at, ended_at) DESC, ended_at DESC
      LIMIT 1 BY user_id, date
    ),
    heart_rate_samples AS (
      SELECT
        sleep_windows.date AS date,
        samples.scalar AS heart_rate
      FROM sleep_windows
      INNER JOIN analytics.deduped_sensor AS samples
        ON samples.user_id = sleep_windows.user_id
      WHERE samples.channel = 'heart_rate'
        AND samples.recorded_at >= sleep_windows.started_at
        AND samples.recorded_at <= sleep_windows.ended_at
        AND samples.activity_id IS NULL
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

export function dateWindowStartString(endDate: string, days: number): string {
  const windowStart = new Date(`${endDate}T00:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - days);
  return windowStart.toISOString().slice(0, 10);
}
