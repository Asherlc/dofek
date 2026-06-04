import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readProjectFile(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

function readModel(name: string): string {
  return readFileSync(new URL(`./${name}.sql`, import.meta.url), "utf8");
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

describe("production analytics read-model build", () => {
  it("does not block the BullMQ worker on analytics dbt builds", () => {
    const entrypoint = readProjectFile("entrypoint.sh");
    const workerBlockMatch = entrypoint.match(/  worker\)\n(?<body>[\s\S]*?)\n    ;;/);

    expect(workerBlockMatch?.groups?.body).toContain("exec $NODE src/jobs/worker.ts");
    expect(workerBlockMatch?.groups?.body).not.toContain("dbt build");
  });

  it("delays the first scheduled analytics build after container startup", () => {
    const entrypoint = readProjectFile("entrypoint.sh");
    const analyticsWorkerBlockMatch = entrypoint.match(/  analytics-worker\)\n(?<body>[\s\S]*?)\n    ;;/);

    expect(analyticsWorkerBlockMatch?.groups?.body).toContain("ANALYTICS_BUILD_STARTUP_DELAY_SECONDS:-120");
    expect(analyticsWorkerBlockMatch?.groups?.body).toContain("sleep \"$startup_delay_seconds\"");
    expect(analyticsWorkerBlockMatch?.groups?.body).toContain("dbt build");
  });

  it("does not run analytics dbt builds in the deploy migration path", () => {
    const entrypoint = readProjectFile("entrypoint.sh");
    const migrateBlockMatch = entrypoint.match(/  migrate\)\n(?<body>[\s\S]*?)\n    ;;/);

    expect(migrateBlockMatch?.groups?.body).toContain("$NODE src/db/run-migrate.ts");
    expect(migrateBlockMatch?.groups?.body).not.toContain("dbt build");
  });

  it("runs every bounded intermediary and final read model in dependency order", () => {
    const entrypoint = readProjectFile("entrypoint.sh");
    const safeModelMatch = entrypoint.match(/^DBT_SAFE_MODELS="([^"]+)"$/m);

    expect(safeModelMatch?.[1]?.split(" ")).toEqual([
      "sensor_scalar_sample",
      "deduped_sensor",
      "activity_source_records",
      "activity_duplicate_matches",
      "activity_duplicate_groups",
      "deduped_activities",
      "deduped_activity_members",
      "sleep_heart_rate_sample",
      "resting_heart_rate_sleep_window",
      "daily_recovery_inputs",
      "activity_sensor_sample",
      "activity_location_sample",
      "activity_sensor_summary_rows",
      "activity_location_summary_rows",
      "activity_summary_rows",
      "activity_vo2max_estimate",
      "daily_activity_load",
      "healthspan_activity_zone_minutes",
    ]);
  });

  it("materializes sleep heart-rate membership as a microbatch intermediary", () => {
    expect(existsSync(new URL("./sleep_heart_rate_sample.sql", import.meta.url))).toBe(true);
    const sql = readModel("sleep_heart_rate_sample");

    expect(sql).toContain("incremental_strategy='microbatch'");
    expect(sql).toContain("event_time='recorded_at'");
    expect(sql).toContain("ref('deduped_sensor')");
    expect(sql).toContain("source('postgres_fitness', 'sleep_session')");
    expect(sql).toContain("channel = 'heart_rate'");
    expect(sql).toContain("'join_use_nulls': 1");
  });

  it("aggregates resting heart rate from the bounded sleep intermediary", () => {
    const sql = readModel("resting_heart_rate_sleep_window");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("ref('sleep_heart_rate_sample')");
    expect(sql).not.toContain("ref('deduped_sensor')");
    expect(normalizedSql).not.toContain("ref('sleep_heart_rate_sample') }} AS sleep_samples FINAL");
    expect(normalizedSql).not.toContain("ref('sleep_heart_rate_sample') }} FINAL");
  });

  it("materializes deduped activities from domain activity dedupe models", () => {
    expect(existsSync(new URL("./deduped_activities.sql", import.meta.url))).toBe(true);
    const sql = readModel("deduped_activities");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("ref('activity_source_records')");
    expect(sql).toContain("ref('activity_duplicate_groups')");
    expect(sql).toContain("current_deduped_activities AS");
    expect(sql).toContain("member_activity_ids");
    expect(sql).toContain("assumeNotNull(user_id) AS user_id");
    expect(sql).toContain("stale_deduped_activities AS");
    expect(sql).toContain("{% if is_incremental() %}");
    expect(sql).toContain("'join_use_nulls': 1");
    expect(normalizedSql).toContain("FROM existing_deduped_activities");
    expect(normalizedSql).toContain("FROM {{ this }} AS deduped FINAL");
    expect(normalizedSql).toContain("WHERE deduped.is_deleted = 0");
    expect(normalizedSql).toContain(
      "ON current_deduped_activities.activity_id = existing_deduped_activities.activity_id AND current_deduped_activities.user_id = existing_deduped_activities.user_id",
    );
  });

  it("breaks activity deduplication into conceptual domain stages", () => {
    const sourceRecordsSql = readModel("activity_source_records");
    const matchesSql = readModel("activity_duplicate_matches");
    const groupsSql = readModel("activity_duplicate_groups");

    expect(sourceRecordsSql).toContain("materialized='incremental'");
    expect(sourceRecordsSql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sourceRecordsSql).toContain("active_provider_priority AS");
    expect(sourceRecordsSql).toContain("device_priority_match AS");
    expect(sourceRecordsSql).toContain("current_source_records AS");
    expect(sourceRecordsSql).toContain("length(active_device_priority.source_name_pattern) DESC");
    expect(sourceRecordsSql).toContain("active_device_priority.priority ASC");
    expect(sourceRecordsSql).toContain("active_device_priority.source_name_pattern ASC");

    expect(matchesSql).toContain("materialized='incremental'");
    expect(matchesSql).toContain("ref('activity_source_records')");
    expect(matchesSql).toContain("current_duplicate_matches AS");
    expect(matchesSql).toContain("overlap_ratio");

    expect(groupsSql).toContain("materialized='incremental'");
    expect(groupsSql).toContain("ref('activity_source_records')");
    expect(groupsSql).toContain("ref('activity_duplicate_matches')");
    expect(groupsSql).toContain("duplicate_links AS");
    expect(groupsSql).toContain("duplicate_walk AS");
    expect(groupsSql).toContain("current_duplicate_groups AS");
    expect(groupsSql).toContain("GROUP BY activity_id");
  });

  it("materializes deduped activity member aliases from deduped activities", () => {
    expect(existsSync(new URL("./deduped_activity_members.sql", import.meta.url))).toBe(true);
    const sql = readModel("deduped_activity_members");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("ref('deduped_activities')");
    expect(sql).toContain("target_state AS");
    expect(sql).toContain("changed_deduped_activities AS");
    expect(sql).toContain("changed_activity_member_keys AS");
    expect(sql).toContain(
      "deduped_activities.refreshed_at > (SELECT last_refreshed_at FROM target_state)",
    );
    expect(sql).toContain("arrayJoin(deduped_activities.member_activity_ids) AS member_activity_id");
    expect(sql).toContain("stale_activity_members AS");
    expect(sql).toContain("'join_use_nulls': 1");
    expect(normalizedSql).toContain("LEFT JOIN current_activity_members");
    expect(normalizedSql).toContain(
      "(existing_members.user_id, existing_members.member_activity_id) IN",
    );
    expect(normalizedSql).toContain("FROM {{ this }} AS existing_members FINAL");
    expect(normalizedSql).toContain("WHERE existing_members.is_deleted = 0");
  });

  it("materializes activity sensor membership as a microbatch intermediary", () => {
    expect(existsSync(new URL("./activity_sensor_sample.sql", import.meta.url))).toBe(true);
    const sql = readModel("activity_sensor_sample");

    expect(sql).toContain("incremental_strategy='microbatch'");
    expect(sql).toContain("event_time='recorded_at'");
    expect(sql).toContain("lookback=3");
    expect(sql).toContain("ref('deduped_sensor')");
    expect(sql).toContain("ref('deduped_activities')");
    expect(sql).not.toContain("source('analytics', 'v_activity')");
    expect(sql).toContain("activity_id");
  });

  it("materializes activity location membership as a microbatch intermediary", () => {
    expect(existsSync(new URL("./activity_location_sample.sql", import.meta.url))).toBe(true);
    const sql = readModel("activity_location_sample");

    expect(sql).toContain("incremental_strategy='microbatch'");
    expect(sql).toContain("event_time='recorded_at'");
    expect(sql).toContain("lookback=3");
    expect(sql).toContain("source('postgres_fitness', 'metric_stream')");
    expect(sql).toContain("ref('deduped_activity_members')");
    expect(sql).not.toContain("source('analytics', 'v_activity_members')");
    expect(sql).toContain("channel = 'location'");
    expect(sql).toContain("argMax(point, _peerdb_version) AS point");
    expect(sql).toContain("toString(point) AS point_text");
    expect(sql).toContain("startsWith(location_rows.point_text, '{')");
    expect(sql).toContain("JSONExtract(location_rows.point_text, 'coordinates', 'Array(Float64)')[2]");
    expect(sql).toContain("trim(BOTH '()' FROM location_rows.point_text)");
  });

  it("uses the same null-ended activity window for duplicate matches and merged activities", () => {
    const matchesSql = readModel("activity_duplicate_matches");
    const dedupedActivitiesSql = readModel("deduped_activities");

    expect(matchesSql).toContain("coalesce(ended_at, started_at + INTERVAL 12 HOUR) AS ended_at");
    expect(matchesSql).toContain("greatest(left_activity.started_at, right_activity.started_at)");
    expect(matchesSql).toContain("least(left_activity.ended_at, right_activity.ended_at)");

    expect(dedupedActivitiesSql).toContain("min(ranked.started_at) AS started_at");
    expect(dedupedActivitiesSql).toContain("max(coalesce(ranked.ended_at, ranked.started_at + INTERVAL 12 HOUR)) AS ended_at");
    expect(dedupedActivitiesSql).toContain("max(ranked.source_synced_at) AS source_synced_at");
  });

  it("carries upstream source freshness through lookback microbatch intermediaries", () => {
    const dedupedSensorSql = readModel("deduped_sensor");
    const activitySensorSampleSql = readModel("activity_sensor_sample");
    const activityLocationSampleSql = readModel("activity_location_sample");
    const sleepHeartRateSampleSql = readModel("sleep_heart_rate_sample");

    expect(dedupedSensorSql).toContain("now64(9) AS refreshed_at");
    expect(activitySensorSampleSql).toContain(
      "greatest(samples.refreshed_at, current_activity.source_synced_at) AS source_refreshed_at",
    );
    expect(activitySensorSampleSql).toContain("now64(9) AS refreshed_at");
    expect(activityLocationSampleSql).toContain(
      "greatest(location_rows._peerdb_synced_at, activity_members.source_synced_at) AS refreshed_at",
    );
    expect(activityLocationSampleSql).not.toContain("now64(9) AS refreshed_at");
    expect(sleepHeartRateSampleSql).toContain("greatest(samples.refreshed_at, active_sleep._peerdb_synced_at)");
    expect(sleepHeartRateSampleSql).not.toContain("now64(9) AS refreshed_at");
  });

  it("aggregates activity sensor summary from the bounded sensor intermediary", () => {
    expect(existsSync(new URL("./activity_sensor_summary_rows.sql", import.meta.url))).toBe(true);
    const sql = readModel("activity_sensor_summary_rows");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("ref('activity_sensor_sample')");
    expect(normalizedSql).toContain("(sensor_samples.user_id, sensor_samples.activity_id) IN");
    expect(sql).toContain("source('postgres_fitness', 'activity') }} FINAL");
    expect(sql).not.toContain("source('analytics', 'v_activity')");
    expect(normalizedSql).not.toContain("ref('activity_sensor_sample') }} AS sensor_samples FINAL");
    expect(normalizedSql).not.toContain("FROM {{ ref('deduped_sensor') }}");
    expect(normalizedSql).not.toContain("source('postgres_fitness', 'metric_stream')");
    expect(normalizedSql).not.toContain("INNER JOIN dirty_keys ON dirty_keys.activity_id = sensor_samples.activity_id");
  });

  it("aggregates activity location summary from the bounded location intermediary", () => {
    expect(existsSync(new URL("./activity_location_summary_rows.sql", import.meta.url))).toBe(true);
    const sql = readModel("activity_location_summary_rows");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("ref('activity_location_sample')");
    expect(normalizedSql).toContain("(location_samples.user_id, location_samples.activity_id) IN");
    expect(sql).toContain("source('postgres_fitness', 'activity') }} FINAL");
    expect(sql).not.toContain("source('analytics', 'v_activity')");
    expect(normalizedSql).not.toContain("ref('activity_location_sample') }} AS location_samples FINAL");
    expect(normalizedSql).not.toContain("FROM analytics.deduped_location");
    expect(normalizedSql).not.toContain("source('postgres_fitness', 'metric_stream')");
    expect(normalizedSql).not.toContain(
      "INNER JOIN dirty_keys ON dirty_keys.activity_id = location_samples.activity_id",
    );
  });

  it("joins activity summary from bounded aggregate intermediaries", () => {
    const sql = readModel("activity_summary_rows");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("ref('deduped_activities')");
    expect(sql).toContain("ref('deduped_activity_members')");
    expect(sql).toContain("ref('activity_sensor_summary_rows')");
    expect(sql).toContain("ref('activity_location_summary_rows')");
    expect(sql).toContain("(user_id, activity_id) IN");
    expect(sql).toContain("changed_raw_activity");
    expect(sql).toContain("dirty_key_candidates");
    expect(sql).toContain("dedupe_mapping_dirty_keys");
    expect(sql).toContain("canonical_dirty_keys");
    expect(sql).toContain("stale_activity_dirty_keys");
    expect(normalizedSql).toContain("FROM current_activity CROSS JOIN target_state");
    expect(normalizedSql).not.toContain(
      "current_activity AS ( SELECT id AS activity_id, user_id, activity_type, name, started_at, ended_at FROM {{ source('postgres_fitness', 'activity') }} FINAL",
    );
    expect(sql).not.toContain("source('analytics', 'v_activity')");
    expect(normalizedSql).not.toContain("ref('activity_sensor_sample')");
    expect(normalizedSql).not.toContain("ref('activity_location_sample')");
    expect(normalizedSql).not.toContain("FROM {{ ref('deduped_sensor') }}");
    expect(normalizedSql).not.toContain("FROM analytics.deduped_location");
    expect(normalizedSql).not.toContain("source('postgres_fitness', 'metric_stream')");
    expect(normalizedSql).not.toContain("existing_activity_summary AS (");
    expect(normalizedSql).not.toContain("ref('activity_sensor_summary_rows') }} FINAL");
    expect(normalizedSql).not.toContain("ref('activity_location_summary_rows') }} FINAL");
    expect(normalizedSql).not.toContain("FROM dirty_keys LEFT JOIN activity_bounds");
    expect(normalizedSql).not.toContain("assumeNotNull(dirty_keys.activity_id) AS activity_id");
    expect(normalizedSql).not.toContain("assumeNotNull(dirty_keys.user_id) AS user_id");
    expect(sql).toContain("'join_use_nulls': 1");
    expect(normalizedSql).toContain("FROM active_dirty_keys LEFT JOIN activity_bounds");
    expect(normalizedSql).toContain("if(activity_bounds.activity_id IS null, 1, 0) AS is_deleted");
    expect(normalizedSql).toContain(
      "INNER JOIN active_dirty_keys ON active_dirty_keys.activity_id = current_activity.activity_id",
    );
    expect(normalizedSql).toContain("LIMIT 1 BY user_id, activity_id");
    expect(normalizedSql).toContain(
      "FROM {{ ref('activity_sensor_summary_rows') }} WHERE (user_id, activity_id) IN",
    );
    expect(normalizedSql).toContain(
      "LIMIT 1 BY user_id, activity_id ) WHERE is_deleted = 0 ), location_summary AS",
    );
    expect(normalizedSql).toContain(
      "FROM {{ ref('activity_location_summary_rows') }} WHERE (user_id, activity_id) IN",
    );
  });

  it("canonicalizes activity summary dirty keys through bounded activity members", () => {
    const sql = readModel("activity_summary_rows");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("ref('deduped_activity_members')");
    expect(sql).toContain("dirty_key_candidates AS");
    expect(sql).toContain("dedupe_mapping_dirty_keys AS");
    expect(sql).toContain("canonical_dirty_keys AS");
    expect(normalizedSql).toContain(
      "current_activity.refreshed_at > target_state.last_refreshed_at",
    );
    expect(normalizedSql).toContain(
      "coalesce(activity_members.activity_id, dirty_key_candidates.activity_id) AS activity_id",
    );
    expect(normalizedSql).toContain("FROM dirty_key_candidates AS dirty_key_candidates LEFT JOIN activity_members");
    expect(normalizedSql).toContain(
      "activity_members.member_activity_id = dirty_key_candidates.activity_id",
    );
    expect(normalizedSql).toContain("FROM canonical_dirty_keys");
    expect(normalizedSql).toContain("FROM stale_activity_dirty_keys");
  });

  it("estimates activity VO2 max from bounded activity sensor membership", () => {
    const sql = readModel("activity_vo2max_estimate");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("ref('activity_sensor_sample')");
    expect(sql).not.toContain("ref('deduped_sensor')");
    expect(normalizedSql).not.toContain("INNER JOIN {{ ref('deduped_sensor') }}");
    expect(normalizedSql).toContain("samples.activity_id = activity_bounds.activity_id");
    expect(normalizedSql).toContain("samples.user_id = activity_bounds.user_id");
  });

  it("materializes daily activity load from activity summary rows", () => {
    const sql = readModel("daily_activity_load");

    expect(sql).toContain("ref('activity_summary_rows')");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).not.toContain("ref('activity_sensor_sample')");
    expect(sql).not.toContain("ref('deduped_sensor')");
  });

  it("materializes daily recovery inputs from compact daily and sleep sources", () => {
    const sql = readModel("daily_recovery_inputs");

    expect(sql).toContain("analytics.v_daily_metrics");
    expect(sql).toContain("analytics.v_sleep");
    expect(sql).toContain("ref('resting_heart_rate_sleep_window')");
    expect(sql).toContain("hrv_mean_60d");
    expect(sql).toContain("rhr_mean_60d");
    expect(sql).not.toContain("source('postgres_fitness', 'metric_stream')");
    expect(sql).not.toContain("ref('deduped_sensor')");
  });

  it("materializes healthspan zone minutes from bounded activity samples", () => {
    const sql = readModel("healthspan_activity_zone_minutes");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("ref('activity_summary_rows')");
    expect(sql).toContain("ref('activity_sensor_sample')");
    expect(sql).toContain("ref('resting_heart_rate_sleep_window')");
    expect(sql).toContain("postgres_fitness.user_profile_current");
    expect(sql).toContain("sensor_samples.scalar >= activity_metadata.ftp * 0.9");
    expect(sql).not.toContain("ref('deduped_sensor')");
    expect(sql).not.toContain("source('postgres_fitness', 'metric_stream')");
    expect(normalizedSql).toContain("sensor_samples.activity_id = activity_metadata.activity_id");
    expect(normalizedSql).toContain("sensor_samples.user_id = activity_metadata.user_id");
  });
});
