import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { analysisLocalClock, type SleepEpisode } from "./sleep-episode-analysis.ts";

const activityRowSchema = z.object({
  sleep_id: z.string(),
  id: z.string(),
  canonical_type: z.string(),
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().nullable(),
  source_providers: z.array(z.string()),
  matches_filter: z.boolean(),
});

type ActivityRow = z.infer<typeof activityRowSchema>;
type WakeWindow = {
  sleep_id: string;
  previous_id: string;
  wake_at: string;
  sleep_start: string;
};

export const preSleepActivitySchema = z.object({
  coverage_status: z.enum([
    "observed",
    "no_records",
    "no_matching_records",
    "partial",
    "unavailable",
  ]),
  reason: z.string().nullable(),
  previous_wake: z.object({ session_id: z.string(), ended_at: z.iso.datetime() }).nullable(),
  activity_count: z.number().int().nonnegative().nullable(),
  source_activity_ids: z.array(z.string()),
  source_activity_ids_truncated: z.boolean(),
  source_providers: z.array(z.string()),
  duration: z.object({
    value_minutes: z.number().nonnegative().nullable(),
    supported_activities: z.number().int().nonnegative(),
  }),
  last_activity: activityRowSchema
    .pick({
      id: true,
      canonical_type: true,
      source_providers: true,
    })
    .extend({
      ended_at: z.iso.datetime(),
      local_end_date: z.string(),
      local_end_time: z.string(),
    })
    .nullable(),
  minutes_to_sleep: z.number().nonnegative().nullable(),
});

type PreSleepActivity = z.infer<typeof preSleepActivitySchema>;

const EVIDENCE_LIMIT = 100;

function summarizeWindow(
  window: WakeWindow | undefined,
  rows: ActivityRow[],
  timezone: string,
): PreSleepActivity {
  if (!window) {
    return {
      coverage_status: "unavailable",
      reason: "No valid preceding main wake in the two-calendar-day lookback.",
      previous_wake: null,
      activity_count: null,
      source_activity_ids: [],
      source_activity_ids_truncated: false,
      source_providers: [],
      duration: { value_minutes: null, supported_activities: 0 },
      last_activity: null,
      minutes_to_sleep: null,
    };
  }
  const qualifying = rows.filter((row) => row.matches_filter);
  const wakeAt = Date.parse(window.wake_at);
  const sleepStart = Date.parse(window.sleep_start);
  let coveredUntil = wakeAt;
  let elapsed = 0;
  let validCount = 0;
  let lastActivity: (ActivityRow & { ended_at: string }) | undefined;
  for (const activity of qualifying) {
    const start = Date.parse(activity.started_at);
    const end = activity.ended_at === null ? NaN : Date.parse(activity.ended_at);
    if (!(end > start) || activity.ended_at === null) continue;
    validCount += 1;
    const clippedEnd = Math.min(end, sleepStart);
    elapsed += Math.max(0, clippedEnd - Math.max(start, coveredUntil));
    coveredUntil = Math.max(coveredUntil, clippedEnd);
    if (end <= sleepStart && (!lastActivity || end > Date.parse(lastActivity.ended_at))) {
      lastActivity = { ...activity, ended_at: activity.ended_at };
    }
  }
  const incomplete = validCount < qualifying.length;
  const final = incomplete ? undefined : lastActivity;
  const finalLocal = final ? analysisLocalClock(final.ended_at, timezone) : null;
  return {
    coverage_status: incomplete
      ? "partial"
      : rows.length === 0
        ? "no_records"
        : qualifying.length === 0
          ? "no_matching_records"
          : "observed",
    reason: incomplete
      ? "At least one matching activity has a missing or invalid end."
      : rows.length === 0
        ? "No activity records cover this window. Recording completeness is unknown."
        : null,
    previous_wake: { session_id: window.previous_id, ended_at: window.wake_at },
    activity_count: qualifying.length,
    source_activity_ids: qualifying.slice(0, EVIDENCE_LIMIT).map(({ id }) => id),
    source_activity_ids_truncated: qualifying.length > EVIDENCE_LIMIT,
    source_providers: [...new Set(qualifying.flatMap((row) => row.source_providers))].sort(),
    duration: {
      value_minutes: rows.length === 0 || incomplete ? null : elapsed / 60_000,
      supported_activities: validCount,
    },
    last_activity:
      final && finalLocal
        ? {
            id: final.id,
            canonical_type: final.canonical_type,
            source_providers: final.source_providers,
            ended_at: final.ended_at,
            local_end_date: finalLocal.date,
            local_end_time: finalLocal.time,
          }
        : null,
    minutes_to_sleep: final ? (sleepStart - Date.parse(final.ended_at)) / 60_000 : null,
  };
}

export async function listPreSleepActivities(
  db: Pick<Database, "execute">,
  userId: string,
  episodes: readonly SleepEpisode[],
  timezone: string,
  filters: {
    providers: readonly string[];
    modalities: readonly string[];
    canonicalTypes: readonly string[];
  },
) {
  const chronological = [...episodes].sort(
    (a, b) =>
      Date.parse(a.timing.started_at) - Date.parse(b.timing.started_at) ||
      a.timing.selected_session_id.localeCompare(b.timing.selected_session_id),
  );
  const windows = chronological.flatMap(({ timing }, index): WakeWindow[] => {
    const previous = chronological[index - 1]?.timing;
    if (!previous?.ended_at || Date.parse(previous.ended_at) >= Date.parse(timing.started_at)) {
      return [];
    }
    const calendarDays =
      (Date.parse(timing.local_start_date) -
        Date.parse(previous.local_wake_date ?? previous.local_start_date)) /
      86_400_000;
    if (calendarDays > 2) return [];
    return [
      {
        sleep_id: timing.selected_session_id,
        previous_id: previous.selected_session_id,
        wake_at: previous.ended_at,
        sleep_start: timing.started_at,
      },
    ];
  });
  const rows =
    windows.length === 0
      ? []
      : await executeWithSchema(
          db,
          activityRowSchema,
          sql`
    SELECT
      wake.sleep_id,
      a.id,
      a.canonical_type::text,
      to_char(a.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
      to_char(a.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ended_at,
      a.source_providers,
      ((cardinality(${sql.param(filters.providers)}::text[]) = 0
        OR a.source_providers && ${sql.param(filters.providers)}::text[])
        AND (cardinality(${sql.param(filters.modalities)}::text[]) = 0
          OR COALESCE(a.modality::text = ANY(${sql.param(filters.modalities)}::text[]), false))
        AND (cardinality(${sql.param(filters.canonicalTypes)}::text[]) = 0
          OR a.canonical_type::text = ANY(${sql.param(filters.canonicalTypes)}::text[]))
      ) AS matches_filter
    FROM jsonb_to_recordset(${JSON.stringify(windows)}::jsonb)
      AS wake(sleep_id uuid, wake_at timestamptz, sleep_start timestamptz)
    JOIN fitness.v_activity a ON a.user_id = ${userId}::uuid
      AND a.started_at < wake.sleep_start
      AND (a.ended_at > wake.wake_at OR a.started_at >= wake.wake_at)
    ORDER BY wake.sleep_id, a.started_at, a.id
  `,
        );
  const bySleep = new Map<string, ActivityRow[]>();
  for (const row of rows) {
    const group = bySleep.get(row.sleep_id) ?? [];
    group.push(row);
    bySleep.set(row.sleep_id, group);
  }
  const windowBySleep = new Map(windows.map((window) => [window.sleep_id, window]));
  return new Map(
    episodes.map(({ timing }) => {
      const id = timing.selected_session_id;
      return [id, summarizeWindow(windowBySleep.get(id), bySleep.get(id) ?? [], timezone)];
    }),
  );
}
