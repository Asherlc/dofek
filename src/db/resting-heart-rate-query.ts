import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { buildRestingHeartRateCteSql } from "./clickhouse-resting-heart-rate.ts";

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
  days: number | null;
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
    `WITH ${restingHeartRateClickHouseCte({ includeWindowStart: days !== null })}
    SELECT date, resting_hr
    FROM resting_heart_rate
    ORDER BY date ASC`,
    {
      userId,
      timezone,
      rhrEndDate: endDate,
      ...(days !== null ? { rhrWindowStart: dateWindowStartString(endDate, days) } : {}),
    },
  );
}

interface RestingHeartRateClickHouseCteOptions {
  includeWindowStart?: boolean;
}

export function restingHeartRateClickHouseCte(
  options: RestingHeartRateClickHouseCteOptions = {},
): string {
  return buildRestingHeartRateCteSql(options);
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

/**
 * Pick a single representative resting heart rate from a sequence of daily readings.
 * Takes the median of the most recent positive readings so one noisy night (a wrist
 * tracker capturing waking HR inside a sleep window, etc.) can't shift zone boundaries
 * for every subsequent activity. Rows must be sorted ascending by date — the contract
 * of `fetchRestingHeartRateRowsFromClickHouse`.
 */
export function representativeRestingHeartRate(
  rows: RestingHeartRateRow[],
  sampleWindow = 14,
): number | null {
  if (sampleWindow <= 0) return null;
  const recent = rows
    .map((row) => row.resting_hr)
    .filter((value) => value > 0)
    .slice(-sampleWindow)
    .sort((a, b) => a - b);
  if (recent.length === 0) return null;
  const mid = Math.floor(recent.length / 2);
  if (recent.length % 2 === 1) return recent[mid] ?? null;
  const lower = recent[mid - 1];
  const upper = recent[mid];
  return lower != null && upper != null ? (lower + upper) / 2 : null;
}
