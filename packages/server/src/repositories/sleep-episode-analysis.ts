import {
  localTimeSourceSchema,
  recordLocalTimeContextSchema,
} from "@dofek/format/record-local-time";
import { buildSleepEpisodeAnalysisSelectSql } from "dofek/db/clickhouse-sleep-episodes";
import { z } from "zod";
import type { ActivitySensorStore } from "./activity-repository.ts";

const nullableNumber = z.number().nullable();
const nullableString = z.string().nullable();

const sleepEpisodeRowSchema = z.object({
  selected_session_id: z.string(),
  source_session_ids: z.array(z.string()),
  source_providers: z.array(z.string()),
  provider_id: z.string(),
  source_name: nullableString,
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().nullable(),
  timezone: nullableString,
  start_utc_offset_minutes: nullableNumber,
  end_utc_offset_minutes: nullableNumber,
  local_time_source: localTimeSourceSchema,
  is_nap: z.boolean(),
  sleep_kind_recorded: z.boolean(),
  duration_minutes: nullableNumber,
  efficiency_pct: nullableNumber,
  deep_minutes: nullableNumber,
  rem_minutes: nullableNumber,
  light_minutes: nullableNumber,
  awake_minutes: nullableNumber,
  staging_available: z.boolean(),
});

export const sleepEpisodeTimingSchema = z.object({
  selected_session_id: z.string(),
  source_session_ids: z.array(z.string()),
  source_providers: z.array(z.string()),
  source_provider: z.string(),
  source_name: nullableString,
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().nullable(),
  local_start_date: z.string(),
  local_start_time: z.string(),
  local_wake_date: nullableString,
  local_wake_time: nullableString,
  display_timezone: nullableString,
  timezone_source: z.enum(["caller", "source", "profile"]),
  local_time_context: recordLocalTimeContextSchema,
  is_nap: z.boolean(),
  sleep_kind_recorded: z.boolean(),
  elapsed_minutes: nullableNumber,
});

export const analysisTimezoneSchema = z
  .string()
  .min(1)
  .refine((zone) => {
    if (/^[+-]/.test(zone)) return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "Expected an IANA timezone such as America/Los_Angeles");

export function analysisLocalClock(timestamp: string, timezone: string, offsetMinutes?: number) {
  const instant = new Date(
    Date.parse(timestamp) + (offsetMinutes === undefined ? 0 : offsetMinutes * 60_000),
  );
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: offsetMinutes === undefined ? timezone : "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.get("year")}-${values.get("month")}-${values.get("day")}`,
    time: `${values.get("hour")}:${values.get("minute")}:${values.get("second")}`,
  };
}

interface SleepEpisodeRange {
  userId: string;
  startDate: string;
  endDate: string;
  profileTimezone: string;
  analysisTimezone?: string;
  alignToProfileTimezone?: boolean;
  providers?: readonly string[];
  includeNaps?: boolean;
}

function mapSleepEpisode(row: z.infer<typeof sleepEpisodeRowSchema>, input: SleepEpisodeRange) {
  const useSource = !input.analysisTimezone && !input.alignToProfileTimezone;
  const sourceZone = useSource && row.local_time_source !== "unknown" ? row.timezone : null;
  const isOffsetSource =
    row.local_time_source === "provider_offset" || row.local_time_source === "device_offset";
  const useSourceOffset =
    useSource &&
    !sourceZone &&
    isOffsetSource &&
    row.start_utc_offset_minutes !== null &&
    (row.ended_at === null || row.end_utc_offset_minutes !== null);
  const timezone = input.analysisTimezone ?? sourceZone ?? input.profileTimezone;
  const start = analysisLocalClock(
    row.started_at,
    timezone,
    useSourceOffset ? (row.start_utc_offset_minutes ?? undefined) : undefined,
  );
  const wake =
    row.ended_at === null
      ? null
      : analysisLocalClock(
          row.ended_at,
          timezone,
          useSourceOffset ? (row.end_utc_offset_minutes ?? undefined) : undefined,
        );
  const elapsed =
    row.ended_at === null ? null : (Date.parse(row.ended_at) - Date.parse(row.started_at)) / 60_000;
  const timing: z.infer<typeof sleepEpisodeTimingSchema> = {
    selected_session_id: row.selected_session_id,
    source_session_ids: row.source_session_ids,
    source_providers: row.source_providers,
    source_provider: row.provider_id,
    source_name: row.source_name,
    started_at: row.started_at,
    ended_at: row.ended_at,
    local_start_date: start.date,
    local_start_time: start.time,
    local_wake_date: wake?.date ?? null,
    local_wake_time: wake?.time ?? null,
    display_timezone: useSourceOffset ? null : timezone,
    timezone_source: input.analysisTimezone
      ? "caller"
      : sourceZone || useSourceOffset
        ? "source"
        : "profile",
    local_time_context: {
      timezone: row.timezone,
      startUtcOffsetMinutes: row.start_utc_offset_minutes,
      endUtcOffsetMinutes: row.end_utc_offset_minutes,
      source: row.local_time_source,
    },
    is_nap: row.is_nap,
    sleep_kind_recorded: row.sleep_kind_recorded,
    elapsed_minutes: elapsed !== null && elapsed > 0 ? elapsed : null,
  };
  return {
    date: wake?.date ?? start.date,
    timing,
    duration_minutes: row.duration_minutes,
    efficiency_pct: row.efficiency_pct,
    staging_available: row.staging_available,
    stages_minutes: {
      deep: row.deep_minutes,
      rem: row.rem_minutes,
      light: row.light_minutes,
      awake: row.awake_minutes,
    },
  };
}

export type SleepEpisode = ReturnType<typeof mapSleepEpisode>;

export async function listSleepEpisodes(
  store: Pick<ActivitySensorStore, "query">,
  input: SleepEpisodeRange,
): Promise<SleepEpisode[]> {
  const rows = await store.query(
    sleepEpisodeRowSchema,
    `SELECT
      toString(id) AS selected_session_id,
      source_session_ids, source_providers, provider_id, source_name,
      replaceRegexpOne(formatDateTime(started_at, '%FT%T.%fZ', 'UTC'), '[.]0+Z$', 'Z') AS started_at,
      replaceRegexpOne(formatDateTime(ended_at, '%FT%T.%fZ', 'UTC'), '[.]0+Z$', 'Z') AS ended_at,
      timezone, start_utc_offset_minutes, end_utc_offset_minutes, local_time_source,
      toBool(is_nap) AS is_nap, toBool(sleep_kind_recorded) AS sleep_kind_recorded,
      duration_minutes, efficiency_pct, staging_available,
      deep_minutes, rem_minutes, light_minutes, awake_minutes
    FROM (${buildSleepEpisodeAnalysisSelectSql()})
    WHERE {includeNaps:Bool} OR NOT is_nap
    SETTINGS enable_materialized_cte = 1`,
    {
      userId: input.userId,
      startDate: input.startDate,
      endDate: input.endDate,
      providers: [...(input.providers ?? [])],
      includeNaps: input.includeNaps ?? false,
    },
  );
  return rows
    .map((row) => mapSleepEpisode(row, input))
    .filter(({ date }) => date >= input.startDate && date <= input.endDate)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.timing.started_at.localeCompare(b.timing.started_at) ||
        a.timing.selected_session_id.localeCompare(b.timing.selected_session_id),
    );
}
