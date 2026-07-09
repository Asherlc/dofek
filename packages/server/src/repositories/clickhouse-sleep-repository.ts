import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import {
  clickHouseDateRangePredicate,
  type RangeDays,
  rangeDaysParams,
} from "../lib/date-window.ts";
import type { ActivitySensorQueryOptions, ActivitySensorStore } from "./activity-repository.ts";

const nullableNumberSchema = z.preprocess(
  (value) => (value === undefined ? null : value),
  z.coerce.number().nullable(),
);

const clickHouseSleepNightSchema = z
  .object({
    date: z.string(),
    provider_id: z.string().nullable().optional(),
    source_name: z.string().nullable().optional(),
    source_providers: z
      .preprocess((value) => (value == null ? [] : value), z.array(z.string()))
      .optional()
      .default([]),
    started_at: z.string().optional(),
    ended_at: z.string().nullable().optional(),
    duration_minutes: nullableNumberSchema,
    deep_minutes: nullableNumberSchema,
    rem_minutes: nullableNumberSchema,
    light_minutes: nullableNumberSchema,
    awake_minutes: nullableNumberSchema,
    efficiency_pct: nullableNumberSchema,
  })
  .transform((row) => ({
    ...row,
    provider_id: row.provider_id ?? null,
    source_name: row.source_name ?? null,
    source_providers: row.source_providers ?? [],
    started_at: row.started_at ?? `${row.date}T12:00:00`,
    ended_at: row.ended_at ?? null,
  }));

export type ClickHouseSleepNight = z.infer<typeof clickHouseSleepNightSchema>;

export interface FetchSleepNightsInput {
  sensorStore: Pick<ActivitySensorStore, "query">;
  userId: string;
  timezone: string;
  endDate: string;
  days: RangeDays;
  accessWindow?: AccessWindow;
  order?: "asc" | "desc";
  limit?: number;
  queryOptions?: ActivitySensorQueryOptions;
}

const dailySleepPerformanceRowSchema = z.object({
  date: z.string(),
  provider_id: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  duration_minutes: nullableNumberSchema,
  deep_minutes: nullableNumberSchema,
  rem_minutes: nullableNumberSchema,
  light_minutes: nullableNumberSchema,
  awake_minutes: nullableNumberSchema,
  efficiency_pct: nullableNumberSchema,
});

export type DailySleepPerformanceNight = z.infer<typeof dailySleepPerformanceRowSchema>;

export interface FetchDailySleepPerformanceNightsInput {
  sensorStore: Pick<ActivitySensorStore, "query">;
  userId: string;
  endDate: string;
  days: number;
  accessWindow?: AccessWindow;
  queryOptions?: ActivitySensorQueryOptions;
}

function accessWindowClause(accessWindow: AccessWindow | undefined): string {
  if (!accessWindow || accessWindow.kind === "full") return "";
  return `
    AND toDate(toTimeZone(started_at, {timezone:String}) - INTERVAL 6 HOUR) >= toDate({accessStartDate:String})
    AND toDate(toTimeZone(started_at, {timezone:String}) - INTERVAL 6 HOUR) < toDate({accessEndDateExclusive:String})`;
}

function accessWindowParams(accessWindow: AccessWindow | undefined): Record<string, unknown> {
  if (!accessWindow || accessWindow.kind === "full") return {};
  return {
    accessStartDate: accessWindow.startDate,
    accessEndDateExclusive: accessWindow.endDateExclusive,
  };
}

function dateAccessWindowClause(accessWindow: AccessWindow | undefined): string {
  if (!accessWindow || accessWindow.kind === "full") return "";
  return `AND sleep.date >= toDate({accessStartDate:String})
          AND sleep.date < toDate({accessEndDateExclusive:String})`;
}

export async function fetchSleepNights(
  input: FetchSleepNightsInput,
): Promise<ClickHouseSleepNight[]> {
  const orderDirection = input.order === "desc" ? "DESC" : "ASC";
  const limitClause = input.limit != null ? "\nLIMIT {limit:UInt32}" : "";
  const sleepDateExpression = "toDate(toTimeZone(started_at, {timezone:String}) - INTERVAL 6 HOUR)";
  const sleepLowerBoundClause = clickHouseDateRangePredicate({
    expression: sleepDateExpression,
    days: input.days,
    operator: ">=",
  });
  const rows = await input.sensorStore.query(
    clickHouseSleepNightSchema,
    `SELECT
      date,
      provider_id,
      source_name,
      source_providers,
      formatDateTime(started_at_dt, '%FT%TZ', 'UTC') AS started_at,
      if(isNull(ended_at_dt), NULL, formatDateTime(ended_at_dt, '%FT%TZ', 'UTC')) AS ended_at,
      duration_minutes,
      deep_minutes,
      rem_minutes,
      light_minutes,
      awake_minutes,
      efficiency_pct
    FROM (
      SELECT
        toString(toDate(toTimeZone(started_at, {timezone:String}) - INTERVAL 6 HOUR)) AS date,
        provider_id,
        source_name,
        source_providers,
        started_at AS started_at_dt,
        ended_at AS ended_at_dt,
        duration_minutes,
        deep_minutes,
        rem_minutes,
        light_minutes,
        awake_minutes,
        efficiency_pct,
        row_number() OVER (
          PARTITION BY toDate(toTimeZone(started_at, {timezone:String}) - INTERVAL 6 HOUR)
          ORDER BY duration_minutes DESC NULLS LAST
        ) AS row_number
      FROM analytics.v_sleep
      WHERE user_id = {userId:UUID}
        AND is_nap = false
        ${sleepLowerBoundClause}
        AND toDate(toTimeZone(started_at, {timezone:String}) - INTERVAL 6 HOUR) <= toDate({endDate:String})
        ${accessWindowClause(input.accessWindow)}
    )
    WHERE row_number = 1
    ORDER BY date ${orderDirection}${limitClause}`,
    {
      userId: input.userId,
      timezone: input.timezone,
      endDate: input.endDate,
      ...rangeDaysParams(input.days),
      ...(input.limit != null ? { limit: input.limit } : {}),
      ...accessWindowParams(input.accessWindow),
    },
    input.queryOptions,
  );
  return rows.map((row) => clickHouseSleepNightSchema.parse(row));
}

export async function fetchDailySleepPerformanceNights(
  input: FetchDailySleepPerformanceNightsInput,
): Promise<DailySleepPerformanceNight[]> {
  const rows = await input.sensorStore.query(
    dailySleepPerformanceRowSchema,
    `SELECT
      toString(sleep.date) AS date,
      sleep.provider_id AS provider_id,
      formatDateTime(sleep.started_at, '%FT%TZ', 'UTC') AS started_at,
      if(isNull(sleep.ended_at), NULL, formatDateTime(sleep.ended_at, '%FT%TZ', 'UTC')) AS ended_at,
      sleep.duration_minutes AS duration_minutes,
      sleep.deep_minutes AS deep_minutes,
      sleep.rem_minutes AS rem_minutes,
      sleep.light_minutes AS light_minutes,
      sleep.awake_minutes AS awake_minutes,
      sleep.efficiency_pct AS efficiency_pct
    FROM analytics.daily_sleep AS sleep FINAL
    WHERE sleep.user_id = {userId:UUID}
      AND sleep.date >= toDate({endDate:String}) - {days:UInt32}
      AND sleep.date <= toDate({endDate:String})
      ${dateAccessWindowClause(input.accessWindow)}
    ORDER BY sleep.date ASC`,
    {
      userId: input.userId,
      endDate: input.endDate,
      days: input.days,
      ...accessWindowParams(input.accessWindow),
    },
    input.queryOptions,
  );
  return rows.map((row) => dailySleepPerformanceRowSchema.parse(row));
}

export async function fetchLatestSleepNight(input: {
  sensorStore: Pick<ActivitySensorStore, "query">;
  userId: string;
  timezone: string;
  /** Inclusive upper bound on the sleep-day (timezone-shifted). Latest as-of this date. */
  endDate?: string;
  accessWindow?: AccessWindow;
}): Promise<ClickHouseSleepNight | null> {
  const endDateClause = input.endDate
    ? `AND toDate(toTimeZone(started_at, {timezone:String}) - INTERVAL 6 HOUR) <= toDate({endDate:String})`
    : "";
  const rows = await input.sensorStore.query(
    clickHouseSleepNightSchema,
    `SELECT
      date,
      provider_id,
      source_name,
      source_providers,
      formatDateTime(started_at_dt, '%FT%TZ', 'UTC') AS started_at,
      if(isNull(ended_at_dt), NULL, formatDateTime(ended_at_dt, '%FT%TZ', 'UTC')) AS ended_at,
      duration_minutes,
      deep_minutes,
      rem_minutes,
      light_minutes,
      awake_minutes,
      efficiency_pct
    FROM (
      SELECT
        toString(toDate(toTimeZone(started_at, {timezone:String}) - INTERVAL 6 HOUR)) AS date,
        provider_id,
        source_name,
        source_providers,
        started_at AS started_at_dt,
        ended_at AS ended_at_dt,
        duration_minutes,
        deep_minutes,
        rem_minutes,
        light_minutes,
        awake_minutes,
        efficiency_pct
      FROM analytics.v_sleep
      WHERE user_id = {userId:UUID}
        AND is_nap = false
        ${endDateClause}
        ${accessWindowClause(input.accessWindow)}
      ORDER BY started_at DESC
      LIMIT 1
    )`,
    {
      userId: input.userId,
      timezone: input.timezone,
      ...(input.endDate != null ? { endDate: input.endDate } : {}),
      ...accessWindowParams(input.accessWindow),
    },
  );
  const parsedRows = rows.map((row) => clickHouseSleepNightSchema.parse(row));
  return parsedRows[0] ?? null;
}
