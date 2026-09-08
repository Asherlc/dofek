import { type SQL, sql } from "drizzle-orm";

const AUTHORITATIVE_LOCAL_TIME_SOURCES = [
  "provider_timezone",
  "device_timezone",
  "user_home_timezone",
  "gps_timezone",
  "home_zone_fallback",
  "provider_offset",
  "device_offset",
] as const;

/**
 * Canonical activity date: use the source-resolved offset at the activity instant,
 * then fall back to the user's analysis timezone when source context is incomplete.
 */
export function postgresActivityLocalDate(activityAlias: SQL, analysisTimezone: string): SQL {
  return sql`CASE
    WHEN ${activityAlias}.local_time_source IN (${sql.join(
      AUTHORITATIVE_LOCAL_TIME_SOURCES.map((source) => sql`${source}`),
      sql`, `,
    )}) AND ${activityAlias}.start_utc_offset_minutes IS NOT NULL
      THEN ((${activityAlias}.started_at AT TIME ZONE 'UTC')
        + ${activityAlias}.start_utc_offset_minutes * INTERVAL '1 minute')::date
    ELSE (${activityAlias}.started_at AT TIME ZONE ${analysisTimezone})::date
  END`;
}

/** Equivalent ClickHouse expression; authoritative contexts store the resolved start offset. */
export function clickHouseActivityLocalDate(activityAlias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(activityAlias)) throw new Error("Invalid SQL alias");
  const sources = AUTHORITATIVE_LOCAL_TIME_SOURCES.map((source) => `'${source}'`).join(", ");
  return `toDate(if(
    has([${sources}], ${activityAlias}.local_time_source)
      AND isNotNull(${activityAlias}.start_utc_offset_minutes),
    addMinutes(
      toTimeZone(${activityAlias}.started_at, 'UTC'),
      toInt32(coalesce(${activityAlias}.start_utc_offset_minutes, 0))
    ),
    toTimeZone(${activityAlias}.started_at, {timezone:String})
  ))`;
}

export function postgresActivityDateIsAuthoritative(activityAlias: SQL): SQL {
  return sql`${activityAlias}.local_time_source IN (${sql.join(
    AUTHORITATIVE_LOCAL_TIME_SOURCES.map((source) => sql`${source}`),
    sql`, `,
  )}) AND ${activityAlias}.start_utc_offset_minutes IS NOT NULL`;
}

export function clickHouseActivityDateIsAuthoritative(activityAlias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(activityAlias)) throw new Error("Invalid SQL alias");
  const sources = AUTHORITATIVE_LOCAL_TIME_SOURCES.map((source) => `'${source}'`).join(", ");
  return `has([${sources}], ${activityAlias}.local_time_source)
    AND isNotNull(${activityAlias}.start_utc_offset_minutes)`;
}
