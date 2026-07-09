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

  it("runs activity read models before sleep and dashboard models", () => {
    const entrypoint = readProjectFile("entrypoint.sh");
    const activityMatch = entrypoint.match(/^DBT_ACTIVITY_MODELS="([^"]+)"$/m);
    const sleepDashboardMatch = entrypoint.match(/^DBT_SLEEP_DASHBOARD_MODELS="([^"]+)"$/m);

    // DBT_ACTIVITY_MODELS order is load-bearing: upstream intermediaries must build
    // before downstream activity read models and provider_stats in run_dbt_safe_builds().
    expect(activityMatch?.[1]?.split(" ")).toEqual([
      "sensor_scalar_sample",
      "deduped_sensor",
      "activity_source_records",
      "activity_duplicate_matches",
      "activity_duplicate_groups",
      "deduped_activities",
      "deduped_activity_members",
      "activity_sensor_sample",
      "activity_location_sample",
      "activity_sensor_summary_rows",
      "activity_location_summary_rows",
      "activity_stream_points",
      "activity_heart_rate_zones",
      "activity_summary_rows",
      "hiking_activity",
      "activity_vo2max_estimate",
      "activity_aerobic_efficiency",
      "activity_polarization_zones",
      "activity_power_curve",
      "provider_stats",
    ]);
    expect(sleepDashboardMatch?.[1]?.split(" ")).toEqual([
      "sleep_heart_rate_sample",
      "resting_heart_rate_sleep_window",
      "daily_sleep",
      "daily_recovery_inputs",
      "daily_recovery",
      "daily_endurance_load",
      "weekly_endurance_ramp_rate",
      "weekly_training_monotony",
      "daily_activity_load",
      "daily_strain",
      "daily_body_measurement",
      "healthspan_activity_zone_minutes",
      "weekly_healthspan",
    ]);
    expect(entrypoint).toContain('DBT_SAFE_MODELS="$DBT_ACTIVITY_MODELS $DBT_SLEEP_DASHBOARD_MODELS"');
    expect(entrypoint).toContain("run_dbt_safe_builds()");
    expect(entrypoint).toContain("--select $DBT_ACTIVITY_MODELS &&");
    expect(entrypoint).toContain("--select $DBT_SLEEP_DASHBOARD_MODELS");
  });

  it("materializes sleep heart-rate membership from dirty sleep, sensor, and activity keys", () => {
    expect(existsSync(new URL("./sleep_heart_rate_sample.sql", import.meta.url))).toBe(true);
    const sql = readModel("sleep_heart_rate_sample");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("incremental_strategy='append'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("initial_lookback_days");
    expect(sql).toContain("target_state AS");
    expect(sql).toContain("sleep_dirty_keys AS");
    expect(sql).toContain("sensor_dirty_keys AS");
    expect(sql).toContain("activity_dirty_keys AS");
    expect(sql).toContain("activity_dirty_refreshes AS");
    expect(sql).toContain("max(activity_source._peerdb_synced_at) AS activity_refreshed_at");
    expect(sql).toContain("initial_dirty_keys AS");
    expect(sql).toContain("stale_sleep_dirty_keys AS");
    expect(sql).toContain("stale_sample_tombstones AS");
    expect(sql).toContain("ref('deduped_sensor')");
    expect(sql).toContain("source('postgres_fitness', 'sleep_session')");
    expect(sql).toContain("source('postgres_fitness', 'activity')");
    expect(sql).toContain("channel = 'heart_rate'");
    expect(sql).toContain("'join_use_nulls': 1");
    expect(sql).toContain("assumeNotNull(sleep_id) AS sleep_id");
    expect(sql).toContain("assumeNotNull(user_id) AS user_id");
    expect(sql).toContain("assumeNotNull(recorded_at) AS recorded_at");
    expect(sql).toContain("assumeNotNull(recorded_date) AS recorded_date");
    expect(normalizedSql).toContain("_peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)");
    expect(normalizedSql).toContain("refreshed_at > (SELECT last_refreshed_at FROM target_state)");
    expect(normalizedSql).not.toContain("incremental_strategy='microbatch'");
    expect(normalizedSql).not.toContain("lookback=");
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
    expect(sql).toContain("'memberActivityId', toString(ranked.activity_id)");
    expect(sql).toContain("'subsource', coalesce(");
    expect(sql).toContain("assumeNotNull(user_id) AS user_id");
    expect(sql).toContain("stale_deduped_activities AS");
    expect(sql).toContain("{% if is_incremental() %}");
    expect(sql).toContain("'join_use_nulls': 1");
    expect(normalizedSql).toContain(
      "source_external_ids, absent_source_external_ids, member_activity_ids, refresh_clock.refresh_version AS refresh_version, 0 AS is_deleted, refresh_clock.refreshed_at AS refreshed_at",
    );
    expect(normalizedSql).toContain(
      "source_external_ids, absent_source_external_ids, member_activity_ids, refresh_clock.refresh_version AS refresh_version, 1 AS is_deleted, refresh_clock.refreshed_at AS refreshed_at",
    );
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
    expect(sourceRecordsSql).toContain("provider_absent_at IS NULL");
    expect(sourceRecordsSql).toContain("deleted_at IS NULL");
    expect(sourceRecordsSql).toContain("length(active_device_priority.source_name_pattern) DESC");
    expect(sourceRecordsSql).toContain("active_device_priority.priority ASC");
    expect(sourceRecordsSql).toContain("active_device_priority.source_name_pattern ASC");

    expect(matchesSql).toContain("materialized='incremental'");
    expect(matchesSql).toContain("ref('activity_source_records')");
    expect(matchesSql).toContain("current_duplicate_matches AS");
    expect(matchesSql).toContain("active_to_tombstoned_matches AS");
    expect(matchesSql).toContain("overlap_ratio");

    expect(groupsSql).toContain("materialized='incremental'");
    expect(groupsSql).toContain("ref('activity_source_records')");
    expect(groupsSql).toContain("ref('activity_duplicate_matches')");
    expect(groupsSql).toContain("duplicate_links AS");
    expect(groupsSql).toContain("duplicate_walk AS");
    expect(groupsSql).toContain("current_duplicate_groups AS");
    expect(groupsSql).toContain("GROUP BY activity_id");
  });

  it("fails closed instead of tombstoning all activity source records from an empty source scan", () => {
    const sourceRecordsSql = readModel("activity_source_records");
    const normalizedSql = compactWhitespace(sourceRecordsSql);

    expect(sourceRecordsSql).toContain("source_record_counts AS");
    expect(sourceRecordsSql).toContain("source_safety_check AS");
    expect(sourceRecordsSql).toContain("activity_source_mass_tombstone_min_existing");
    expect(sourceRecordsSql).toContain("activity_source_mass_tombstone_ratio");
    expect(sourceRecordsSql).toContain("throwIf(");
    expect(normalizedSql).toContain("existing_source_record_count > 0");
    expect(normalizedSql).toContain("current_source_record_count = 0");
    expect(normalizedSql).toContain("existing_source_record_count >=");
    expect(normalizedSql).toContain("stale_source_record_count >=");
    expect(normalizedSql).toContain("existing_source_record_count *");
    expect(normalizedSql).toContain(
      "Activity source mirror returned zero current rows while active activity_source_records rows already exist",
    );
    expect(normalizedSql).toContain(
      "Activity source mirror would tombstone at least",
    );
    expect(normalizedSql.match(/CROSS JOIN source_safety_check/g)?.length).toBe(2);
  });

  it("counts only active activities in provider stats", () => {
    const providerStatsSql = readModel("provider_stats");

    expect(providerStatsSql).toContain("source('postgres_fitness', 'activity') }} FINAL");
    expect(providerStatsSql).toContain("provider_absent_at IS null");
    expect(providerStatsSql).toContain("deleted_at IS null");
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
    expect(sql).toContain("event_time='refreshed_at'");
    expect(sql).toContain("lookback=3");
    expect(sql).toContain("ref('deduped_sensor')");
    expect(sql).toContain("ref('deduped_activities')");
    expect(sql).not.toContain("source('analytics', 'v_activity')");
    expect(sql).toContain("activity_id");
    expect(sql).toContain("source_refreshed_at AS refreshed_at");
  });

  it("uses source freshness for late-arriving activity stream samples", () => {
    const sourcesYaml = readProjectFile("analytics/models/sources.yml");
    const sensorScalarSampleSql = readProjectFile(
      "analytics/models/staging/sensor_scalar_sample.sql",
    );
    const dedupedSensorSql = readModel("deduped_sensor");
    const activityLocationSampleSql = readModel("activity_location_sample");

    expect(sourcesYaml).toContain("name: metric_stream_freshness");
    expect(sourcesYaml).toContain("identifier: metric_stream");
    expect(sourcesYaml).toContain("name: ingest");
    expect(sourcesYaml).toContain("event_time: ingested_at");
    expect(sensorScalarSampleSql).toContain("event_time='_peerdb_synced_at'");
    expect(sensorScalarSampleSql).toContain("source('ingest', 'metric_stream_freshness')");
    expect(dedupedSensorSql).toContain("event_time='refreshed_at'");
    expect(dedupedSensorSql).toContain("max(samples._peerdb_synced_at) AS source_refreshed_at");
    expect(dedupedSensorSql).toContain("source_refreshed_at AS refreshed_at");
    expect(activityLocationSampleSql).toContain("source('ingest', 'metric_stream_freshness')");
    expect(activityLocationSampleSql).not.toContain("source('postgres_fitness', 'metric_stream')");
  });

  it("materializes activity location membership as a microbatch intermediary", () => {
    expect(existsSync(new URL("./activity_location_sample.sql", import.meta.url))).toBe(true);
    const sql = readModel("activity_location_sample");

    expect(sql).toContain("incremental_strategy='microbatch'");
    expect(sql).toContain("event_time='refreshed_at'");
    expect(sql).toContain("lookback=3");
    expect(sql).toContain("source('ingest', 'metric_stream_freshness')");
    expect(sql).toContain("ref('deduped_activity_members')");
    expect(sql).not.toContain("source('analytics', 'v_activity_members')");
    expect(sql).toContain("channel = 'location'");
    expect(sql).toContain("argMax(point, version) AS point");
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

    expect(dedupedActivitiesSql).toContain("minIf(ranked.started_at, ranked.activity_id IS NOT null) AS started_at");
    expect(dedupedActivitiesSql).toContain("maxIf(coalesce(ranked.ended_at, ranked.started_at + INTERVAL 12 HOUR), ranked.activity_id IS NOT null) AS ended_at");
    expect(dedupedActivitiesSql).toContain("maxIf(ranked.source_synced_at, ranked.activity_id IS NOT null) AS source_synced_at");
  });

  it("requires positive activity windows before shorter-window duplicate matching", () => {
    const normalizedSql = compactWhitespace(readModel("activity_duplicate_matches"));

    expect(normalizedSql).toContain(
      "dateDiff('second', left_activity.started_at, left_activity.ended_at) > 0",
    );
    expect(normalizedSql).toContain(
      "dateDiff('second', right_activity.started_at, right_activity.ended_at) > 0",
    );
    expect(normalizedSql).toContain(
      "dateDiff( 'second', greatest(left_activity.started_at, right_activity.started_at), least(left_activity.ended_at, right_activity.ended_at) ) > 0",
    );
  });

  it("carries upstream source freshness through lookback microbatch intermediaries", () => {
    const dedupedSensorSql = readModel("deduped_sensor");
    const activitySensorSampleSql = readModel("activity_sensor_sample");
    const activityLocationSampleSql = readModel("activity_location_sample");
    const sleepHeartRateSampleSql = readModel("sleep_heart_rate_sample");

    expect(dedupedSensorSql).toContain("max(samples._peerdb_synced_at) AS source_refreshed_at");
    expect(dedupedSensorSql).toContain("source_refreshed_at AS refreshed_at");
    expect(activitySensorSampleSql).toContain(
      "greatest(samples.refreshed_at, current_activity.source_synced_at) AS source_refreshed_at",
    );
    expect(activitySensorSampleSql).toContain("source_refreshed_at AS refreshed_at");
    expect(activityLocationSampleSql).toContain(
      "greatest(location_rows.ingested_at, activity_members.source_synced_at) AS source_refreshed_at",
    );
    expect(activityLocationSampleSql).toContain("source_refreshed_at AS refreshed_at");
    expect(activityLocationSampleSql).not.toContain("now64(9) AS refreshed_at");
    expect(sleepHeartRateSampleSql).toContain(
      "greatest(samples.refreshed_at, active_dirty_sleep.source_refreshed_at)",
    );
    expect(sleepHeartRateSampleSql).toContain("source_refreshed_at AS refreshed_at");
    expect(sleepHeartRateSampleSql).toContain("stale_sample_tombstones");
  });

  it("aggregates activity sensor summary from the bounded sensor intermediary", () => {
    expect(existsSync(new URL("./activity_sensor_summary_rows.sql", import.meta.url))).toBe(true);
    const sql = readModel("activity_sensor_summary_rows");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("ref('activity_sensor_sample')");
    expect(sql).toContain("latest_sensor_samples AS");
    expect(normalizedSql).toContain("(user_id, activity_id) IN");
    expect(normalizedSql).toContain(
      "LIMIT 1 BY user_id, activity_id, channel, recorded_at",
    );
    expect(sql).toContain("source('postgres_fitness', 'activity') }} FINAL");
    expect(sql).toContain("provider_absent_at IS null");
    expect(sql).toContain("deleted_at IS null");
    expect(sql).toContain("restored_dirty_keys AS");
    expect(sql).toContain("prior_summary.is_deleted = 0");
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
    expect(sql).toContain("latest_location_samples AS");
    expect(normalizedSql).toContain("(user_id, activity_id) IN");
    expect(normalizedSql).toContain("LIMIT 1 BY source_metric_stream_id");
    expect(sql).toContain("source('postgres_fitness', 'activity') }} FINAL");
    expect(sql).toContain("provider_absent_at IS null");
    expect(sql).toContain("deleted_at IS null");
    expect(sql).toContain("restored_dirty_keys AS");
    expect(sql).toContain("prior_summary.is_deleted = 0");
    expect(sql).not.toContain("source('analytics', 'v_activity')");
    expect(normalizedSql).not.toContain("ref('activity_location_sample') }} AS location_samples FINAL");
    expect(normalizedSql).not.toContain("FROM analytics.deduped_location");
    expect(normalizedSql).not.toContain("source('postgres_fitness', 'metric_stream')");
    expect(normalizedSql).not.toContain(
      "INNER JOIN dirty_keys ON dirty_keys.activity_id = location_samples.activity_id",
    );
  });

  it("materializes activity stream points from bounded activity intermediaries", () => {
    expect(existsSync(new URL("./activity_stream_points.sql", import.meta.url))).toBe(true);
    const sql = readModel("activity_stream_points");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("order_by='(user_id, activity_id)'");
    expect(sql).toContain("ref('activity_sensor_sample')");
    expect(sql).toContain("ref('activity_location_sample')");
    expect(sql).toContain("sample_dirty_keys AS");
    expect(sql).toContain("location_dirty_keys AS");
    expect(sql).toContain("existing_stream_points AS");
    expect(sql).toContain("stale_dirty_keys AS");
    expect(sql).toContain("latest_sensor_samples AS");
    expect(sql).toContain("latest_location_samples AS");
    expect(normalizedSql).toContain("FROM current_activity WHERE (SELECT is_empty FROM target_state)");
    expect(sql).toContain("arraySort");
    expect(sql).toContain("groupArray(tuple(");
    expect(normalizedSql).toContain("argMax(lat, tuple(refresh_version, source_metric_stream_id))");
    expect(normalizedSql).toContain("argMax(lng, tuple(refresh_version, source_metric_stream_id))");
    expect(sql).toContain("toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version");
    expect(normalizedSql).toContain("LIMIT 1 BY user_id, activity_id, channel, recorded_at");
    expect(normalizedSql).toContain("LIMIT 1 BY source_metric_stream_id");
    expect(normalizedSql).toContain("if(points_by_activity.activity_id IS null, 1, 0) AS is_deleted");
    expect(sql).toContain("refresh_clock.refreshed_at AS refreshed_at");
    expect(sql).not.toContain("activity_stream_points_max_points");
    expect(normalizedSql).not.toContain("modulo( point_index - 1");
    expect(normalizedSql).not.toContain("intDiv(point_count");
    expect(normalizedSql).not.toContain("source('postgres_fitness', 'metric_stream')");
    expect(normalizedSql).not.toContain("ref('deduped_sensor')");
  });

  it("materializes activity heart-rate zones from bounded activity samples", () => {
    expect(existsSync(new URL("./activity_heart_rate_zones.sql", import.meta.url))).toBe(true);
    const sql = readModel("activity_heart_rate_zones");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("order_by='(user_id, activity_id)'");
    expect(sql).toContain("ref('activity_sensor_sample')");
    expect(sql).toContain("ref('resting_heart_rate_sleep_window')");
    expect(sql).toContain("postgres_fitness.user_profile_current");
    expect(sql).toContain("profile_recompute_lookback_days");
    expect(sql).toContain("groupArray(tuple(");
    expect(sql).toContain("zone_seconds AS");
    expect(sql).toContain("channel = 'heart_rate'");
    expect(sql).toContain("existing_zone_rows AS");
    expect(sql).toContain("stale_dirty_keys AS");
    expect(sql).toContain("latest_sensor_samples AS");
    expect(normalizedSql).toContain("FROM current_activity WHERE (SELECT is_empty FROM target_state)");
    expect(normalizedSql).toContain("ORDER BY resting.ended_at DESC");
    expect(normalizedSql).toContain("resting.ended_at <= activity_bounds.started_at");
    expect(normalizedSql).not.toContain(
      "toDate(resting.ended_at) <= toDate(activity_bounds.started_at)",
    );
    expect(normalizedSql).toContain("LIMIT 1 BY user_id, activity_id, channel, recorded_at");
    expect(normalizedSql).toContain("if(zones_by_activity.activity_id IS null, 1, 0) AS is_deleted");
    expect(sql).toContain("refresh_clock.refreshed_at AS refreshed_at");
    expect(normalizedSql).not.toContain("ref('deduped_sensor')");
    expect(normalizedSql).not.toContain("source('postgres_fitness', 'metric_stream')");
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

  it("collapses activity sample versions before aggregate models filter deletions", () => {
    const sensorSummarySql = readModel("activity_sensor_summary_rows");
    const locationSummarySql = readModel("activity_location_summary_rows");
    const normalizedSensorSql = compactWhitespace(sensorSummarySql);
    const normalizedLocationSql = compactWhitespace(locationSummarySql);

    expect(sensorSummarySql).toContain("latest_sensor_samples AS");
    expect(normalizedSensorSql).toContain(
      "LIMIT 1 BY user_id, activity_id, channel, recorded_at",
    );
    expect(normalizedSensorSql).toContain("FROM latest_sensor_samples WHERE scalar IS NOT null");
    expect(normalizedSensorSql).toContain("FROM latest_sensor_samples WHERE channel = 'power'");
    expect(normalizedSensorSql).toContain("FROM latest_sensor_samples WHERE channel = 'altitude'");
    expect(normalizedSensorSql).toContain("FROM latest_sensor_samples WHERE channel = 'grade'");
    expect(normalizedSensorSql).not.toContain("FROM {{ ref('activity_sensor_sample') }} WHERE is_deleted = 0 AND");

    expect(locationSummarySql).toContain("latest_location_samples AS");
    expect(normalizedLocationSql).toContain("LIMIT 1 BY source_metric_stream_id");
    expect(normalizedLocationSql).toContain("FROM latest_location_samples WHERE lat IS NOT null");
    expect(normalizedLocationSql).not.toContain(
      "FROM {{ ref('activity_location_sample') }} AS location_samples WHERE location_samples.is_deleted = 0",
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
    expect(sql).toContain("query_settings={");
    expect(sql).toContain("'max_threads': 1");
    expect(sql).not.toContain("ref('activity_sensor_sample')");
    expect(sql).not.toContain("ref('deduped_sensor')");
  });

  it("materializes daily endurance load from activity summary rows and resting heart rate", () => {
    const sql = readModel("daily_endurance_load");

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("ref('activity_summary_rows')");
    expect(sql).toContain("ref('resting_heart_rate_sleep_window')");
    expect(sql).toContain("postgres_fitness.user_profile_current");
    expect(sql).toContain("argMax(resting.resting_hr, resting.ended_at)");
    expect(sql).toContain("nullIf(user_profile.resting_hr, 0)");
    expect(sql).toContain("activity_type IN (");
    expect(sql).toContain("'road_cycling'");
    expect(compactWhitespace(sql)).toContain("if( max_hr > resting_hr");
    expect(sql).toContain("0.64 * exp(1.92 * intensity)");
    expect(sql).toContain("training_load");
    expect(sql).not.toContain("ref('activity_sensor_sample')");
    expect(sql).not.toContain("ref('deduped_sensor')");
  });

  it("materializes weekly endurance ramp rate from daily endurance load", () => {
    const sql = readModel("weekly_endurance_ramp_rate");

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("ref('daily_endurance_load')");
    expect(sql).toContain("WITH changed_users AS");
    expect(sql).toContain("pow(41.0 / 42.0");
    expect(sql).toContain("lagInFrame(toNullable(ctl_end)");
    expect(sql).toContain("ramp_rate");
    expect(sql).toContain("if(current_rows.user_id IS NULL, 1, 0) AS is_deleted");
    expect(sql).not.toContain("ref('activity_sensor_sample')");
    expect(sql).not.toContain("ref('deduped_sensor')");
    expect(sql).not.toContain("ref('activity_summary_rows')");
  });

  it("materializes weekly training monotony from daily endurance load", () => {
    const sql = readModel("weekly_training_monotony");

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("ref('daily_endurance_load')");
    expect(sql).toContain("WITH changed_users AS");
    expect(sql).toContain("stddevPop(training_load)");
    expect(sql).toContain("HAVING stddevPop(training_load) > 1e-6");
    expect(sql).toContain(
      "round(weekly_load * (mean_load / stdev_load), 1)",
    );
    expect(sql).toContain("if(current_rows.user_id IS NULL, 1, 0) AS is_deleted");
    expect(sql).not.toContain("ref('activity_sensor_sample')");
    expect(sql).not.toContain("ref('deduped_sensor')");
    expect(sql).not.toContain("ref('activity_summary_rows')");
  });

  it("materializes daily recovery inputs from compact daily and sleep sources", () => {
    const sql = readModel("daily_recovery_inputs");

    expect(sql).toContain("analytics.v_daily_metrics");
    expect(sql).toContain("analytics.v_sleep");
    expect(sql).toContain("argMax(efficiency_pct, tuple(duration_minutes, started_at))");
    expect(sql).toContain("ref('resting_heart_rate_sleep_window')");
    expect(sql).toContain("hrv_mean_60d");
    expect(sql).toContain("rhr_mean_60d");
    expect(sql).not.toContain("source('postgres_fitness', 'metric_stream')");
    expect(sql).not.toContain("ref('deduped_sensor')");
  });

  it("materializes the daily recovery model from daily recovery inputs", () => {
    const sql = readModel("daily_recovery");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("{% if is_incremental() %}");
    expect(sql).toContain("existing_dates AS");
    expect(sql).toContain("latest_materialized_refreshed_at");
    expect(normalizedSql).toContain("recovery_inputs.refreshed_at > existing_dates.latest_materialized_refreshed_at");
    expect(normalizedSql).toContain("existing_dates.latest_materialized_date - INTERVAL 60 DAY");
    expect(sql).toContain("ref('daily_recovery_inputs')");
    expect(sql).toContain("hrv_score");
    expect(sql).toContain("resting_hr_score");
    expect(sql).toContain("sleep_score");
    expect(sql).toContain("respiratory_rate_score");
  });

  it("materializes one daily sleep row per user from the ClickHouse sleep view", () => {
    const sql = readModel("daily_sleep");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("'join_use_nulls': 1");
    expect(sql).toContain("{% if is_incremental() %}");
    expect(sql).toContain("existing_dates AS");
    expect(normalizedSql).toContain(
      "toDate(sleep.started_at - INTERVAL 6 HOUR) >= existing_dates.latest_materialized_date - INTERVAL 7 DAY",
    );
    expect(sql).toContain("analytics.v_sleep");
    expect(normalizedSql).toContain("PARTITION BY user_id, date");
    expect(normalizedSql).toContain("ORDER BY duration_minutes DESC NULLS LAST, started_at DESC");
    expect(sql).toContain("WHERE ranked_sleep.row_number = 1");
    expect(sql).not.toContain("source('postgres_fitness', 'metric_stream')");
    expect(sql).not.toContain("ref('deduped_sensor')");
  });

  it("materializes the daily strain model from activity load rows", () => {
    const sql = readModel("daily_strain");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("'join_use_nulls': 1");
    expect(sql).toContain("{% if is_incremental() %}");
    expect(sql).toContain("existing_dates AS");
    expect(normalizedSql).toContain("existing_dates.latest_materialized_date - INTERVAL 54 DAY");
    expect(normalizedSql).toContain("existing_dates.latest_materialized_date - INTERVAL 27 DAY");
    expect(sql).toContain("output_min_date");
    expect(sql).toContain("ref('daily_activity_load')");
    expect(sql).toContain("acute_load_7d");
    expect(sql).toContain("chronic_load_28d");
    expect(sql).toContain("workload_ratio");
    expect(sql).toContain("strain");
  });

  it("materializes healthspan zone minutes from bounded activity samples", () => {
    const sql = readModel("healthspan_activity_zone_minutes");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("ref('activity_summary_rows')");
    expect(sql).toContain("FROM {{ ref('activity_summary_rows') }} FINAL");
    expect(sql).toContain("WHERE is_deleted = 0");
    expect(sql).toContain("ref('activity_sensor_sample')");
    expect(sql).toContain("ref('resting_heart_rate_sleep_window')");
    expect(sql).toContain("postgres_fitness.user_profile_current");
    expect(sql).toContain("FROM {{ this }} FINAL");
    expect(sql).toContain("if(zone_minutes.activity_id IS NULL, 1, 0) AS is_deleted");
    expect(sql).toContain("sensor_samples.scalar >= activity_metadata.ftp * 0.9");
    expect(sql).not.toContain("ref('deduped_sensor')");
    expect(sql).not.toContain("source('postgres_fitness', 'metric_stream')");
    expect(normalizedSql).toContain("sensor_samples.activity_id = activity_metadata.activity_id");
    expect(normalizedSql).toContain("sensor_samples.user_id = activity_metadata.user_id");
  });

  it("materializes weekly healthspan from compact inputs", () => {
    const sql = readModel("weekly_healthspan");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("{% if is_incremental() %}");
    expect(sql).toContain("existing_weeks AS");
    expect(normalizedSql).toContain("existing_weeks.latest_materialized_week_start - INTERVAL 26 WEEK");
    expect(sql).toContain("ref('healthspan_activity_zone_minutes')");
    expect(sql).toContain("ref('resting_heart_rate_sleep_window')");
    expect(sql).toContain("ref('activity_vo2max_estimate')");
    expect(sql).toContain("ref('daily_body_measurement')");
    expect(sql).toContain("toMonday(toDate(started_at)) AS week_start");
    expect(sql).not.toContain("activity_date");
    expect(sql).toContain("argMax(vo2max, started_at) AS latest_vo2max");
    expect(sql).toContain("avg_sleep_min");
    expect(sql).toContain("weekly_aerobic_min");
    expect(sql).toContain("weekly_high_intensity_min");
    expect(sql).toContain("latest_vo2max");
  });

  it("materializes daily body measurements from the body measurement view", () => {
    const sql = readModel("daily_body_measurement");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("order_by='(user_id, measurement_id)'");
    expect(sql).toContain("{% if is_incremental() %}");
    expect(sql).toContain("existing_measurements AS");
    expect(sql).toContain("analytics.v_body_measurement");
    expect(normalizedSql).toContain("existing_measurements.latest_recorded_at) - INTERVAL 7 DAY");
    expect(normalizedSql).not.toContain("row_number() OVER");
    expect(sql).not.toContain("source('postgres_fitness', 'metric_stream')");
  });
});
