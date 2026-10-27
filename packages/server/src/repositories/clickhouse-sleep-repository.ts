import { localTimeSourceSchema } from "@dofek/format/record-local-time";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import type { RangeDays } from "../lib/date-window.ts";
import { timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorQueryOptions, ActivitySensorStore } from "./activity-repository.ts";

const nullableNumberSchema = z.preprocess(
  (value) => (value === undefined || value === "" ? null : value),
  z.coerce.number().nullable(),
);

const nullableStringSchema = z.preprocess(
  (value) => (value === undefined || value === "" ? null : value),
  z.string().nullable(),
);

const overlappingSleepSessionSchema = z
  .object({
    session_id: z.string(),
    provider_id: z.string(),
    source_name: z.string().nullable().optional(),
    source_providers: z
      .preprocess((value) => (value == null ? [] : value), z.array(z.string()))
      .optional()
      .default([]),
    timezone: nullableStringSchema,
    start_utc_offset_minutes: nullableNumberSchema,
    end_utc_offset_minutes: nullableNumberSchema,
    local_time_source: localTimeSourceSchema,
    started_at: timestampStringSchema,
    ended_at: timestampStringSchema.nullable(),
    duration_minutes: nullableNumberSchema,
  })
  .transform((session) => ({
    ...session,
    source_name: session.source_name ?? null,
  }));

const clickHouseSleepNightSchema = z
  .object({
    date: z.string(),
    provider_id: z.string().nullable().optional(),
    source_name: z.string().nullable().optional(),
    source_providers: z
      .preprocess((value) => (value == null ? [] : value), z.array(z.string()))
      .optional()
      .default([]),
    selected_session_id: z.string().nullable().optional().default(null),
    overlapping_sessions: z
      .preprocess((value) => (value == null ? [] : value), z.array(overlappingSleepSessionSchema))
      .optional()
      .default([]),
    timezone: nullableStringSchema.optional().default(null),
    start_utc_offset_minutes: nullableNumberSchema,
    end_utc_offset_minutes: nullableNumberSchema,
    local_time_source: localTimeSourceSchema.optional().default("unknown"),
    started_at: z.string().optional(),
    ended_at: z.string().nullable().optional(),
    duration_minutes: nullableNumberSchema,
    deep_minutes: nullableNumberSchema,
    rem_minutes: nullableNumberSchema,
    light_minutes: nullableNumberSchema,
    awake_minutes: nullableNumberSchema,
    efficiency_pct: nullableNumberSchema,
    staging_available: z.boolean(),
  })
  .transform((row) => ({
    ...row,
    provider_id: row.provider_id ?? null,
    source_name: row.source_name ?? null,
    source_providers: row.source_providers ?? [],
    selected_session_id: row.selected_session_id ?? null,
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
  source_name: z.string().nullable(),
  source_providers: z.array(z.string()),
  timezone: nullableStringSchema,
  start_utc_offset_minutes: nullableNumberSchema,
  end_utc_offset_minutes: nullableNumberSchema,
  local_time_source: localTimeSourceSchema,
  started_at: z.string(),
  ended_at: z.string().nullable(),
  duration_minutes: nullableNumberSchema,
  deep_minutes: nullableNumberSchema,
  rem_minutes: nullableNumberSchema,
  light_minutes: nullableNumberSchema,
  awake_minutes: nullableNumberSchema,
  efficiency_pct: nullableNumberSchema,
  staging_available: z.boolean(),
});

export type DailySleepPerformanceNight = z.infer<typeof dailySleepPerformanceRowSchema>;

const sleepSelectionProjection = `toString(sleep.selected_session_id) AS selected_session_id,
      arrayMap(
        session -> CAST(
          (
            toString(session.session_id),
            session.provider_id,
            session.source_name,
            session.source_providers,
            session.timezone,
            session.start_utc_offset_minutes,
            session.end_utc_offset_minutes,
            session.local_time_source,
            formatDateTime(session.started_at, '%FT%TZ', 'UTC'),
            if(
              isNull(session.ended_at),
              NULL,
              formatDateTime(session.ended_at, '%FT%TZ', 'UTC')
            ),
            session.duration_minutes
          ),
          'Tuple(
            session_id String,
            provider_id String,
            source_name Nullable(String),
            source_providers Array(String),
            timezone Nullable(String),
            start_utc_offset_minutes Nullable(Int16),
            end_utc_offset_minutes Nullable(Int16),
            local_time_source String,
            started_at String,
            ended_at Nullable(String),
            duration_minutes Nullable(Int32)
          )'
        ),
        sleep.overlapping_sessions
      ) AS overlapping_sessions`;

export interface FetchDailySleepPerformanceNightsInput {
  sensorStore: Pick<ActivitySensorStore, "query">;
  userId: string;
  endDate: string;
  days: number;
  accessWindow?: AccessWindow;
  queryOptions?: ActivitySensorQueryOptions;
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
  const sleepLowerBoundClause =
    input.days === null
      ? ""
      : "AND sleep.date >= subtractDays(toDate({endDate:String}), {days:UInt32})";
  const rows = await input.sensorStore.query(
    clickHouseSleepNightSchema,
    `SELECT
      toString(sleep.date) AS date,
      sleep.provider_id AS provider_id,
      sleep.source_name AS source_name,
      sleep.source_providers AS source_providers,
      ${sleepSelectionProjection},
      sleep.timezone AS timezone,
      sleep.start_utc_offset_minutes AS start_utc_offset_minutes,
      sleep.end_utc_offset_minutes AS end_utc_offset_minutes,
      sleep.local_time_source AS local_time_source,
      formatDateTime(sleep.started_at, '%FT%TZ', 'UTC') AS started_at,
      if(isNull(sleep.ended_at), NULL, formatDateTime(sleep.ended_at, '%FT%TZ', 'UTC')) AS ended_at,
      sleep.duration_minutes AS duration_minutes,
      sleep.deep_minutes AS deep_minutes,
      sleep.rem_minutes AS rem_minutes,
      sleep.light_minutes AS light_minutes,
      sleep.awake_minutes AS awake_minutes,
      sleep.efficiency_pct AS efficiency_pct,
      sleep.staging_available AS staging_available
    FROM analytics.daily_sleep AS sleep FINAL
    WHERE sleep.user_id = {userId:UUID}
      AND sleep.is_deleted = 0
      ${sleepLowerBoundClause}
      AND sleep.date <= toDate({endDate:String})
      ${dateAccessWindowClause(input.accessWindow)}
    ORDER BY sleep.date ${orderDirection}${limitClause}`,
    {
      userId: input.userId,
      endDate: input.endDate,
      ...(input.days === null ? {} : { days: input.days }),
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
      sleep.source_name AS source_name,
      sleep.source_providers AS source_providers,
      sleep.timezone AS timezone,
      sleep.start_utc_offset_minutes AS start_utc_offset_minutes,
      sleep.end_utc_offset_minutes AS end_utc_offset_minutes,
      sleep.local_time_source AS local_time_source,
      formatDateTime(sleep.started_at, '%FT%TZ', 'UTC') AS started_at,
      if(isNull(sleep.ended_at), NULL, formatDateTime(sleep.ended_at, '%FT%TZ', 'UTC')) AS ended_at,
      sleep.duration_minutes AS duration_minutes,
      sleep.deep_minutes AS deep_minutes,
      sleep.rem_minutes AS rem_minutes,
      sleep.light_minutes AS light_minutes,
      sleep.awake_minutes AS awake_minutes,
      sleep.efficiency_pct AS efficiency_pct,
      sleep.staging_available AS staging_available
    FROM analytics.daily_sleep AS sleep FINAL
    WHERE sleep.user_id = {userId:UUID}
      AND sleep.is_deleted = 0
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
  const endDateClause = input.endDate ? "AND sleep.date <= toDate({endDate:String})" : "";
  const rows = await input.sensorStore.query(
    clickHouseSleepNightSchema,
    `SELECT
      toString(sleep.date) AS date,
      sleep.provider_id AS provider_id,
      sleep.source_name AS source_name,
      sleep.source_providers AS source_providers,
      ${sleepSelectionProjection},
      sleep.timezone AS timezone,
      sleep.start_utc_offset_minutes AS start_utc_offset_minutes,
      sleep.end_utc_offset_minutes AS end_utc_offset_minutes,
      sleep.local_time_source AS local_time_source,
      formatDateTime(sleep.started_at, '%FT%TZ', 'UTC') AS started_at,
      if(isNull(sleep.ended_at), NULL, formatDateTime(sleep.ended_at, '%FT%TZ', 'UTC')) AS ended_at,
      sleep.duration_minutes AS duration_minutes,
      sleep.deep_minutes AS deep_minutes,
      sleep.rem_minutes AS rem_minutes,
      sleep.light_minutes AS light_minutes,
      sleep.awake_minutes AS awake_minutes,
      sleep.efficiency_pct AS efficiency_pct,
      sleep.staging_available AS staging_available
    FROM analytics.daily_sleep AS sleep FINAL
    WHERE sleep.user_id = {userId:UUID}
      AND sleep.is_deleted = 0
      ${endDateClause}
      ${dateAccessWindowClause(input.accessWindow)}
    ORDER BY sleep.date DESC
    LIMIT 1`,
    {
      userId: input.userId,
      ...(input.endDate != null ? { endDate: input.endDate } : {}),
      ...accessWindowParams(input.accessWindow),
    },
  );
  const parsedRows = rows.map((row) => clickHouseSleepNightSchema.parse(row));
  return parsedRows[0] ?? null;
}
