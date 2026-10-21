import { standardViewHeader } from "./clickhouse-sql-helpers.ts";

export function buildActivityOriginViewSql(legacyFields: string): string {
  const header = standardViewHeader("analytics.v_activity");
  const matchingMembers =
    "arraySort(legacy.member_activity_ids) = arraySort(origins.member_activity_ids)";
  const resolved = `origins.primary_activity_id IS NOT NULL AND origins.primary_provider_id IS NOT NULL AND ${matchingMembers}`;
  return `${header}
WITH legacy_fields AS (${legacyFields}),
materialized_origins AS (
  SELECT activity_id, user_id, primary_activity_id, primary_provider_id, primary_source_name,
    origin_candidate_member_ids, origin_evidence, member_activity_ids
  FROM analytics.deduped_activities FINAL WHERE is_deleted = 0
)
SELECT
  legacy.id,
  if(${resolved},
    origins.primary_activity_id, NULL) AS primary_activity_id,
  legacy.primary_activity_id AS representative_activity_id,
  if(${resolved}, origins.primary_provider_id, NULL) AS primary_provider_id,
  if(${resolved}, origins.primary_source_name, NULL) AS primary_source_name,
  if(${resolved}, [assumeNotNull(origins.primary_activity_id)], legacy.member_activity_ids) AS origin_candidate_member_ids,
  if(${matchingMembers}, coalesce(origins.origin_evidence, CAST([], 'Array(Map(String, String))')),
    CAST([], 'Array(Map(String, String))')) AS origin_evidence,
  legacy.provider_id, legacy.user_id, legacy.canonical_type, legacy.provider_type, legacy.modality,
  legacy.started_at, legacy.ended_at, legacy.source_name, legacy.name, legacy.notes,
  legacy.timezone, legacy.start_utc_offset_minutes, legacy.end_utc_offset_minutes,
  legacy.local_time_source, legacy.raw, legacy.source_providers, legacy.source_external_ids,
  legacy.absent_source_external_ids, legacy.member_activity_ids
FROM legacy_fields AS legacy
LEFT JOIN materialized_origins AS origins ON origins.activity_id = legacy.id AND origins.user_id = legacy.user_id`;
}
