import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

const nullableNumberSchema = z.preprocess(
  (value) => (value === undefined ? null : value),
  z.coerce.number().nullable(),
);

const clickHouseSleepNightSchema = z
  .object({
    date: z.string(),
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
    started_at: row.started_at ?? `${row.date}T12:00:00`,
    ended_at: row.ended_at ?? null,
  }));

export type ClickHouseSleepNight = z.infer<typeof clickHouseSleepNightSchema>;

export interface FetchSleepNightsInput {
  sensorStore: Pick<ActivitySensorStore, "query">;
  userId: string;
  timezone: string;
  endDate: string;
  days: number;
  accessWindow?: AccessWindow;
  order?: "asc" | "desc";
  limit?: number;
}

function accessWindowClause(accessWindow: AccessWindow | undefined): string {
  if (!accessWindow || accessWindow.kind === "full") return "";
  return `
    AND started_at >= parseDateTimeBestEffort({accessStartDate:String})
    AND started_at < parseDateTimeBestEffort({accessEndDateExclusive:String})`;
}

function accessWindowParams(accessWindow: AccessWindow | undefined): Record<string, unknown> {
  if (!accessWindow || accessWindow.kind === "full") return {};
  return {
    accessStartDate: accessWindow.startDate,
    accessEndDateExclusive: accessWindow.endDateExclusive,
  };
}

export async function fetchSleepNights(
  input: FetchSleepNightsInput,
): Promise<ClickHouseSleepNight[]> {
  const orderDirection = input.order === "desc" ? "DESC" : "ASC";
  const limitClause = input.limit != null ? "\nLIMIT {limit:UInt32}" : "";
  const rows = await input.sensorStore.query(
    clickHouseSleepNightSchema,
    `SELECT
      date,
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
        AND toDate(toTimeZone(started_at, {timezone:String}) - INTERVAL 6 HOUR) > subtractDays(toDate({endDate:String}), {days:UInt32})
        AND toDate(toTimeZone(started_at, {timezone:String}) - INTERVAL 6 HOUR) <= toDate({endDate:String})
        ${accessWindowClause(input.accessWindow)}
    )
    WHERE row_number = 1
    ORDER BY date ${orderDirection}${limitClause}`,
    {
      userId: input.userId,
      timezone: input.timezone,
      endDate: input.endDate,
      days: input.days,
      ...(input.limit != null ? { limit: input.limit } : {}),
      ...accessWindowParams(input.accessWindow),
    },
  );
  return rows.map((row) => clickHouseSleepNightSchema.parse(row));
}

export async function fetchLatestSleepNight(input: {
  sensorStore: Pick<ActivitySensorStore, "query">;
  userId: string;
  timezone: string;
  accessWindow?: AccessWindow;
}): Promise<ClickHouseSleepNight | null> {
  const rows = await input.sensorStore.query(
    clickHouseSleepNightSchema,
    `SELECT
      date,
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
        ${accessWindowClause(input.accessWindow)}
      ORDER BY started_at DESC
      LIMIT 1
    )`,
    {
      userId: input.userId,
      timezone: input.timezone,
      ...accessWindowParams(input.accessWindow),
    },
  );
  const parsedRows = rows.map((row) => clickHouseSleepNightSchema.parse(row));
  return parsedRows[0] ?? null;
}
