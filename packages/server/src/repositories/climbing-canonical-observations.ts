import type { ClimbingFilters } from "@dofek/training/climbing-filters";
import type { ClimbingGradePreference } from "@dofek/training/climbing-grades";
import { type SQL, sql } from "drizzle-orm";
import { postgresActivityCalendarDate } from "./activity-local-date.ts";
import { rockClimbingLogProjection } from "./climbing-rock-observations.ts";
export function canonicalClimbingLogCtes(
  range: number | { startDate?: string; endDate: string },
  filters: ClimbingFilters,
  preference: ClimbingGradePreference,
  userId: string,
  timezone: string,
  dateAccessPredicate: (date: SQL) => SQL,
) {
  const activityDate = postgresActivityCalendarDate(sql`a`, timezone);
  const datePredicate = (date: SQL) =>
    typeof range === "number"
      ? sql`(${date}) > (NOW() AT TIME ZONE ${timezone})::date - ${range}::int AND (${date}) <= (NOW() AT TIME ZONE ${timezone})::date`
      : sql`(${date}) <= ${range.endDate}::date ${range.startDate === undefined ? sql`` : sql`AND (${date}) >= ${range.startDate}::date`}`;
  return sql`rock_logs AS (${rockClimbingLogProjection(preference, filters)}),
      dated_logs AS (
        SELECT (${activityDate})::text AS session_date, a.id AS canonical_activity_id,
          a.name AS activity_name, ce.*
        FROM fitness.v_activity AS a JOIN rock_logs AS ce ON ce.activity_id = ANY(a.member_activity_ids)
        WHERE a.user_id = ${userId} AND ce.user_id = ${userId}
          AND a.canonical_type IN ('climbing', 'hiking')
          AND ${datePredicate(activityDate)}
          ${dateAccessPredicate(activityDate)}
        UNION ALL
        SELECT ce.climbed_on::text AS session_date, NULL::uuid AS canonical_activity_id,
          NULL::text AS activity_name, ce.* FROM rock_logs AS ce
        WHERE ce.user_id = ${userId} AND ce.activity_id IS NULL
          AND ${datePredicate(sql`ce.climbed_on`)}
          ${dateAccessPredicate(sql`ce.climbed_on`)}
      ), observations AS (
        SELECT ce.*, CASE WHEN ce.canonical_activity_id IS NOT NULL
          AND NULLIF(BTRIM(ce.climb_name), '') IS NOT NULL AND jsonb_array_length(ce.area_path) > 0
          AND (ce.attempt_scope = 'climb' OR ce.pitch_number IS NOT NULL)
          THEN jsonb_build_array(ce.canonical_activity_id, ce.session_date, ce.climb_kind,
            ce.grade_system, LOWER(BTRIM(ce.grade)), ce.attempt_scope, ce.pitch_number, ce.rope_method,
            ce.solo, ce.setting, LOWER(BTRIM(ce.climb_name)),
            (SELECT jsonb_agg(LOWER(BTRIM(node->>'name')) ORDER BY position)
              FROM jsonb_array_elements(ce.area_path) WITH ORDINALITY AS location(node, position)),
            LOWER(BTRIM(ce.board->>'name')), ce.wall_angle, ce.route_protection, ce.recorded_free_send)
          ELSE jsonb_build_array(ce.id, ce.pitch_id, ce.unknown_pitch_attempt_id) END AS observation
        FROM dated_logs AS ce
      ), ranked_observations AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY observation, provider_id ORDER BY recorded_attempt_count DESC, id) AS occurrence
        FROM observations
      ), canonical_logs AS (
        SELECT DISTINCT ON (observation, occurrence) *,
          CASE WHEN MIN(recorded_attempt_count) OVER paired = MAX(recorded_attempt_count) OVER paired
            THEN MAX(recorded_attempt_count) OVER paired END AS canonical_attempt_count
        FROM ranked_observations WINDOW paired AS (PARTITION BY observation, occurrence)
        ORDER BY observation, occurrence, provider_id, id
      )`;
}
