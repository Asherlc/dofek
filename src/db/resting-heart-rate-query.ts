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
  return `resting_heart_rate AS (
      SELECT
        toString(toDate(toTimeZone(ended_at, {timezone:String}))) AS date,
        resting_hr
      FROM analytics.resting_heart_rate_sleep_window
      WHERE user_id = {userId:UUID}
        AND toDate(toTimeZone(ended_at, {timezone:String})) > toDate({rhrWindowStart:String})
        AND toDate(toTimeZone(ended_at, {timezone:String})) <= toDate({rhrEndDate:String})
      ORDER BY user_id, date, duration_seconds DESC, ended_at DESC
      LIMIT 1 BY user_id, date
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
