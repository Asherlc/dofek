import type { ClimbingFilters } from "@dofek/training/climbing-filters";
import {
  BOULDER_GRADE_SYSTEMS,
  type ClimbingGradePreference,
  ROUTE_GRADE_SYSTEMS,
} from "@dofek/training/climbing-grades";
import { sql } from "drizzle-orm";

/** Select recorded rock attempts and one published grade before aggregation. */
export function rockClimbingLogProjection(
  preference: ClimbingGradePreference,
  filters: ClimbingFilters = {},
) {
  const logPredicates = [
    sql`ce.discipline = 'rock_climbing'`,
    sql`ce.climb_kind IN ('boulder', 'route')`,
    sql`ce.provider_absent_at IS NULL`,
  ];
  for (const [value, column] of [
    [filters.climbKind, sql`ce.climb_kind`],
    [filters.discipline, sql`ce.discipline`],
    [filters.setting, sql`ce.setting`],
  ] as const) {
    if (value === "unknown") logPredicates.push(sql`${column} IS NULL`);
    else if (value !== undefined) logPredicates.push(sql`${column} = ${value}`);
  }
  if (filters.routeProtection === "unknown") logPredicates.push(sql`ce.route_protection IS NULL`);
  else if (filters.routeProtection !== undefined)
    logPredicates.push(sql`${filters.routeProtection} = ANY(ce.route_protection)`);
  const attemptPredicates = [
    sql`attempt.climbing_log_entry_id = ce.id`,
    sql`attempt.scope = ${filters.attemptScope ?? "climb"}`,
  ];
  if (filters.ropeMethod === "unknown") attemptPredicates.push(sql`attempt.rope_method IS NULL`);
  else if (filters.ropeMethod !== undefined)
    attemptPredicates.push(sql`attempt.rope_method = ${filters.ropeMethod}`);
  if (filters.solo === null) attemptPredicates.push(sql`attempt.solo IS NULL`);
  else if (filters.solo !== undefined) attemptPredicates.push(sql`attempt.solo = ${filters.solo}`);
  if (filters.protectionUsed === "unknown")
    attemptPredicates.push(sql`attempt.protection_used IS NULL`);
  else if (filters.protectionUsed !== undefined)
    attemptPredicates.push(sql`${filters.protectionUsed} = ANY(attempt.protection_used)`);
  return sql`
    SELECT ce.*, target.scope AS attempt_scope, target.pitch_id, target.unknown_pitch_attempt_id,
      pitch.number AS pitch_number, selected_grade.value AS grade, selected_grade.system AS grade_system,
      target.rope_method, target.solo, target.used_aid, target.recorded_attempt_count,
      target.sends, target.unknown_outcomes, target.free_send AS recorded_free_send,
      target.attempts, target.attempt_observations, target.rock_result_labels,
      (ce.area_path -> -1 ->> 'name') AS location_name
    FROM fitness.v_climbing_log_entry AS ce
    JOIN LATERAL (
      SELECT attempt.scope, attempt.pitch_id,
        CASE WHEN attempt.scope = 'pitch' AND attempt.pitch_id IS NULL THEN attempt.id END AS unknown_pitch_attempt_id,
        CASE WHEN COUNT(attempt.rope_method) = COUNT(*) AND COUNT(DISTINCT attempt.rope_method) = 1 THEN MIN(attempt.rope_method::text) END AS rope_method,
        CASE WHEN COUNT(attempt.solo) = COUNT(*) AND BOOL_AND(attempt.solo) = BOOL_OR(attempt.solo) THEN BOOL_OR(attempt.solo) END AS solo,
        CASE WHEN COUNT(attempt.used_aid) = COUNT(*) AND BOOL_AND(attempt.used_aid) = BOOL_OR(attempt.used_aid) THEN BOOL_OR(attempt.used_aid) END AS used_aid,
        COUNT(*)::int AS recorded_attempt_count,
        COUNT(*) FILTER (WHERE attempt.free_send)::int AS sends,
        COUNT(*) FILTER (WHERE attempt.free_send IS NULL)::int AS unknown_outcomes,
        CASE WHEN BOOL_OR(attempt.free_send) THEN true
          WHEN BOOL_AND(COALESCE(attempt.free_send = false, false)) THEN false END AS free_send,
        jsonb_agg(jsonb_build_object(
          'id', attempt.id, 'climbingLogEntryId', attempt.climbing_log_entry_id, 'scope', attempt.scope,
          'pitchId', attempt.pitch_id, 'parentAttemptId', attempt.parent_attempt_id, 'attemptIndex', attempt.attempt_index,
          'outcome', attempt.outcome, 'ropeMethod', attempt.rope_method, 'solo', attempt.solo,
          'protectionUsed', attempt.protection_used, 'usedPreplacedProtection', attempt.used_preplaced_protection,
          'usedAid', attempt.used_aid, 'fellOrHung', attempt.fell_or_hung, 'dabbed', attempt.dabbed,
          'receivedBeta', attempt.received_beta, 'hadCompletedBefore', attempt.had_completed_before,
          'priorFailedAttemptsGroundUp', attempt.prior_failed_attempts_ground_up, 'notes', attempt.notes,
          'createdAt', to_char(attempt.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) ORDER BY attempt.attempt_index NULLS LAST, attempt.created_at, attempt.id) AS attempts,
        jsonb_agg(jsonb_build_object(
          'ropeMethod', attempt.rope_method, 'solo', attempt.solo, 'usedAid', attempt.used_aid,
          'sends', CASE WHEN attempt.free_send THEN 1 ELSE 0 END,
          'unknownOutcomes', CASE WHEN attempt.free_send IS NULL THEN 1 ELSE 0 END,
          'onsight', attempt.free_send AND attempt.attempt_index = 1 AND attempt.received_beta = false
            AND attempt.had_completed_before IS DISTINCT FROM true AND attempt.prior_failed_attempts_ground_up IS DISTINCT FROM true,
          'flash', attempt.free_send AND attempt.attempt_index = 1 AND attempt.received_beta = true
            AND attempt.had_completed_before IS DISTINCT FROM true AND attempt.prior_failed_attempts_ground_up IS DISTINCT FROM true
        ) ORDER BY attempt.attempt_index NULLS LAST, attempt.created_at, attempt.id) AS attempt_observations,
        jsonb_build_object(
          'onsight', BOOL_OR(attempt.free_send AND attempt.attempt_index = 1 AND attempt.received_beta = false
            AND attempt.had_completed_before IS DISTINCT FROM true AND attempt.prior_failed_attempts_ground_up IS DISTINCT FROM true),
          'flash', BOOL_OR(attempt.free_send AND attempt.attempt_index = 1 AND attempt.received_beta = true
            AND attempt.had_completed_before IS DISTINCT FROM true AND attempt.prior_failed_attempts_ground_up IS DISTINCT FROM true)
        ) AS rock_result_labels
      FROM (
        SELECT attempt.*, CASE
          WHEN attempt.outcome = 'completed' AND attempt.fell_or_hung = false AND attempt.used_aid = false
            AND (ce.climb_kind = 'route' OR attempt.dabbed = false) THEN true
          WHEN attempt.outcome = 'failed' OR attempt.fell_or_hung = true OR attempt.used_aid = true
            OR (ce.climb_kind = 'boulder' AND attempt.dabbed = true) THEN false END AS free_send
        FROM fitness.v_climbing_attempt AS attempt WHERE ${sql.join(attemptPredicates, sql` AND `)}
      ) AS attempt
      GROUP BY attempt.scope, attempt.pitch_id,
        CASE WHEN attempt.scope = 'pitch' AND attempt.pitch_id IS NULL THEN attempt.id END
    ) AS target ON true
    LEFT JOIN fitness.pitch AS pitch ON pitch.id = target.pitch_id
    LEFT JOIN LATERAL (
      SELECT component.value, component.system FROM (
        SELECT value, system, position FROM fitness.climb_grade WHERE climb_id = ce.climb_id AND target.scope = 'climb'
        UNION ALL
        SELECT value, system, position FROM fitness.pitch_grade WHERE pitch_id = target.pitch_id AND target.scope = 'pitch'
      ) AS component
      WHERE (ce.climb_kind = 'boulder' AND component.system::text IN (${sql.join(
        BOULDER_GRADE_SYSTEMS.map((system) => sql`${system}`),
        sql`, `,
      )}))
        OR (ce.climb_kind = 'route' AND component.system::text IN (${sql.join(
          ROUTE_GRADE_SYSTEMS.map((system) => sql`${system}`),
          sql`, `,
        )}))
      ORDER BY (component.system::text = CASE WHEN ce.climb_kind = 'boulder' THEN ${preference.boulder} ELSE ${preference.route} END) DESC, component.position
      LIMIT 1
    ) AS selected_grade ON true
    WHERE ${sql.join(logPredicates, sql` AND `)}`;
}
