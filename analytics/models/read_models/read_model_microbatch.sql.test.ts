import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactWhitespace } from "../../../src/db/read-model-sql-test-helpers.ts";

function readProjectFile(path: string): string {
  const projectFileUrl = new URL(`../../../${path}`, import.meta.url);
  let contents: string;
  try {
    contents = readFileSync(projectFileUrl, "utf8");
  } catch (error) {
    throw new Error(`Failed to read project file: ${path}`, { cause: error });
  }
  if (contents.length === 0) {
    throw new Error(`Project file is empty: ${path}`);
  }
  return contents;
}

function readModel(name: string): string {
  const modelUrl = new URL(`./${name}.sql`, import.meta.url);
  expect(existsSync(modelUrl)).toBe(true);
  const sql = readFileSync(modelUrl, "utf8");
  expect(sql.length).toBeGreaterThan(0);
  return sql;
}

describe("production analytics read-model build", () => {
  it("gives the activity refresh chain one reusable user and affected-key scope", () => {
    const scopeMacro = readProjectFile("analytics/macros/activity_refresh_scope.sql");
    const scopedModels = [
      "activity_source_records",
      "activity_duplicate_matches",
      "activity_duplicate_groups",
      "deduped_activities",
      "deduped_activity_members",
      "activity_sensor_sample",
      "activity_sensor_summary_rows",
      "activity_summary_rows",
    ];

    expect(scopeMacro).toContain("activity_refresh_user_id");
    expect(scopeMacro).toContain("activity_refresh_activity_ids");
    expect(scopeMacro).toContain("activity_ids | length > 0");
    expect(scopeMacro).toContain("user_id | string | trim | length > 0");
    for (const model of scopedModels) {
      const sql = readModel(model);
      expect(sql, model).toContain("activity_refresh_scope_enabled()");
    }
  });

  it("does not block the BullMQ worker on analytics dbt builds", () => {
    const entrypoint = readProjectFile("entrypoint.sh");
    const workerBlockMatch = entrypoint.match(/  worker\)\n(?<body>[\s\S]*?)\n    ;;/);

    expect(workerBlockMatch).not.toBeNull();
    expect(workerBlockMatch?.groups?.body).toContain("exec $NODE src/jobs/worker.ts");
    expect(workerBlockMatch?.groups?.body).not.toContain("dbt build");
  });

  it("does not run analytics dbt builds in the deploy migration path", () => {
    const entrypoint = readProjectFile("entrypoint.sh");
    const migrateBlockMatch = entrypoint.match(/  migrate\)\n(?<body>[\s\S]*?)\n    ;;/);

    expect(migrateBlockMatch).not.toBeNull();
    expect(migrateBlockMatch?.groups?.body).toContain("$NODE src/db/run-migrate.ts");
    expect(migrateBlockMatch?.groups?.body).not.toContain("dbt build");
  });

  it("bounds e2e analytics microbatch builds without changing production analytics defaults", () => {
    const entrypoint = readProjectFile("entrypoint.sh");
    const compose = readProjectFile("docker-compose.e2e.yml");
    const analyticsBlockMatch = entrypoint.match(/  analytics\)\n(?<body>[\s\S]*?)\n    ;;/);
    const analyticsE2eBlockMatch = entrypoint.match(/  analytics-e2e\)\n(?<body>[\s\S]*?)\n    ;;/);

    expect(analyticsBlockMatch).not.toBeNull();
    expect(analyticsE2eBlockMatch).not.toBeNull();
    expect(entrypoint).toContain("DBT_E2E_MICROBATCH_VARS=");
    expect(entrypoint).toContain('"sensor_scalar_sample_begin":"2026-01-01"');
    expect(entrypoint).toContain('"activity_sensor_sample_begin":"2026-01-01"');
    expect(entrypoint).toContain('"activity_location_sample_begin":"2026-01-01"');
    expect(entrypoint).toContain('"deduped_sensor_begin":"2026-01-01"');
    expect(analyticsBlockMatch?.groups?.body).toContain("run_dbt_safe_builds");
    expect(analyticsBlockMatch?.groups?.body).not.toContain("DBT_E2E_MICROBATCH_VARS");
    expect(analyticsE2eBlockMatch?.groups?.body).toContain("run_dbt_e2e_builds");
    expect(compose).toContain('command: ["analytics-e2e"]');
  });

  it("runs activity read models before sleep and dashboard models", () => {
    const entrypoint = readProjectFile("entrypoint.sh");
    const activityMatch = entrypoint.match(/^DBT_ACTIVITY_MODELS="([^"]+)"$/m);
    const sleepDashboardMatch = entrypoint.match(/^DBT_SLEEP_DASHBOARD_MODELS="([^"]+)"$/m);

    // The E2E build keeps upstream intermediaries before downstream activity
    // read models and provider_stats.
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
      "body_measurement",
      "activity_vo2max_estimate",
      "activity_aerobic_efficiency",
      "activity_polarization_zones",
      "activity_power_curve",
      "cycling_activity",
      "daily_cycling",
      "provider_metric_stream_daily",
      "provider_change_watermark",
      "provider_stats",
    ]);
    expect(sleepDashboardMatch?.[1]?.split(" ")).toEqual([
      "sleep_heart_rate_window",
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
    expect(entrypoint).toContain("run_dbt_safe_builds()");
    expect(entrypoint).toContain('--select "$DBT_ACTIVITY_MODELS" &&');
    expect(entrypoint).toContain('--select "$DBT_SLEEP_DASHBOARD_MODELS"');
    expect(entrypoint).toContain("$NODE scripts/warm-query-cache.ts");
  });

  it("materializes sleep heart-rate membership in bounded dirty-key batches", () => {
    expect(existsSync(new URL("./sleep_heart_rate_sample.sql", import.meta.url))).toBe(true);
    const sql = readModel("sleep_heart_rate_sample");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("incremental_strategy='append'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("full_refresh=false");
    expect(sql).toContain("sleep_dirty_key_batch_size");
    expect(sql).toContain("existing_sleep_state AS");
    expect(sql).toContain("current_windows AS");
    expect(sql).toContain("ref('sleep_heart_rate_window')");
    expect(sql).toContain("ref('deduped_sensor')");
    expect(sql).toContain("source('postgres_fitness', 'activity')");
    expect(sql).toContain("source_dirty_sleep_keys AS");
    expect(sql).toContain("stale_sleep_dirty_keys AS");
    expect(normalizedSql).toContain("LIMIT {{ sleep_dirty_key_batch_size }}");
    expect(sql).toContain("existing_sleep_state AS MATERIALIZED");
    expect(sql).toContain("dirty_keys AS MATERIALIZED");
    expect(sql).toContain("merged_samples AS");
    expect(sql).toContain("FULL OUTER JOIN existing_samples");
    expect(sql).toContain("'join_use_nulls': 1");
    expect(sql).toContain("assumeNotNull(sleep_id) AS sleep_id");
    expect(sql).toContain("assumeNotNull(user_id) AS user_id");
    expect(sql).toContain("assumeNotNull(recorded_at) AS recorded_at");
    expect(sql).toContain("assumeNotNull(recorded_date) AS recorded_date");
    expect(normalizedSql).toContain(
      "current_windows.refreshed_at > existing_sleep_state.refreshed_at",
    );
    expect(normalizedSql).not.toContain("target_state AS");
    expect(normalizedSql).not.toContain("last_refreshed_at");
    expect(normalizedSql).not.toContain("incremental_strategy='microbatch'");
    expect(normalizedSql).not.toContain("lookback=");
  });

  it("materializes exact sleep windows in bounded batches", () => {
    expect(existsSync(new URL("./sleep_heart_rate_window.sql", import.meta.url))).toBe(true);
    const sql = readModel("sleep_heart_rate_window");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("incremental_strategy='append'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("full_refresh=false");
    expect(sql).toContain("source('analytics', 'heart_rate_day_change')");
    expect(sql).toContain("ref('deduped_sensor')");
    expect(sql).toContain("eligible_sample_count");
    expect(normalizedSql).toContain("LIMIT {{ sleep_dirty_key_batch_size }}");
    expect(normalizedSql).not.toContain(
      "{% if is_incremental() %} LIMIT {{ sleep_dirty_key_batch_size }}",
    );
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
      "ON scoped_current_deduped_activities.activity_id = existing_deduped_activities.activity_id AND scoped_current_deduped_activities.user_id = existing_deduped_activities.user_id",
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
    const compactMatchesSql = compactWhitespace(matchesSql);
    expect(compactMatchesSql).toContain(
      "left_activity.canonical_type = right_activity.canonical_type OR ( left_activity.canonical_type = 'other' AND right_activity.canonical_type != 'other'",
    );
    expect(compactMatchesSql).toContain(
      "dateDiff('second', left_activity.started_at, left_activity.ended_at) <= dateDiff('second', right_activity.started_at, right_activity.ended_at)",
    );
    expect(compactMatchesSql).toContain(
      "right_activity.canonical_type = 'other' AND left_activity.canonical_type != 'other'",
    );

    expect(groupsSql).toContain("materialized='incremental'");
    expect(groupsSql).toContain("ref('activity_source_records')");
    expect(groupsSql).toContain("ref('activity_duplicate_matches')");
    expect(groupsSql).toContain("current_edges AS");
    expect(groupsSql).toContain("convergence_check AS");
    expect(groupsSql).toContain("groupArray(tuple(activity_id, linked_activity_ids))");
    expect(groupsSql).toContain("UNION ALL");
    expect(groupsSql).toContain("current_duplicate_groups AS");
    expect(groupsSql).toContain("arrayFold(");
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
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("incremental_strategy='microbatch'");
    expect(sql).toContain(
      "activity_sensor_sample_begin = var('activity_sensor_sample_begin', default_microbatch_begin)",
    );
    expect(sql).toContain("begin=activity_sensor_sample_begin");
    expect(sql).toContain("'name': 'by_activity_source_refresh_version'");
    expect(sql).toContain(
      "'query': 'SELECT activity_id, user_id, max(refresh_version) AS source_refresh_version GROUP BY activity_id, user_id'",
    );
    expect(sql).toContain("event_time='refreshed_at'");
    expect(sql).toContain("lookback=3");
    expect(sql).toContain("ref('deduped_sensor')");
    expect(sql).toContain("ref('deduped_activities')");
    expect(sql).toContain("activity_days AS");
    expect(sql).toContain("arrayJoin(arrayMap(");
    expect(normalizedSql).toContain(
      "activity_days.recorded_date = samples.recorded_date",
    );
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
    expect(sensorScalarSampleSql).toContain(
      "sensor_scalar_sample_begin = var('sensor_scalar_sample_begin', default_microbatch_begin)",
    );
    expect(sensorScalarSampleSql).toContain("begin=sensor_scalar_sample_begin");
    expect(sensorScalarSampleSql).toContain("source('ingest', 'metric_stream_freshness')");
    expect(dedupedSensorSql).toContain("event_time='refreshed_at'");
    expect(dedupedSensorSql).toContain(
      "deduped_sensor_begin = var('deduped_sensor_begin', default_microbatch_begin)",
    );
    expect(dedupedSensorSql).toContain("begin=deduped_sensor_begin");
    expect(dedupedSensorSql).toContain("max(samples._peerdb_synced_at) AS source_refreshed_at");
    expect(dedupedSensorSql).toContain("source_refreshed_at AS refreshed_at");
    expect(activityLocationSampleSql).toContain("source('ingest', 'metric_stream_freshness')");
    expect(activityLocationSampleSql).not.toContain("source('postgres_fitness', 'metric_stream')");
  });

  it("materializes activity location membership as a microbatch intermediary", () => {
    expect(existsSync(new URL("./activity_location_sample.sql", import.meta.url))).toBe(true);
    const sql = readModel("activity_location_sample");

    expect(sql).toContain("incremental_strategy='microbatch'");
    expect(sql).toContain(
      "activity_location_sample_begin = var('activity_location_sample_begin', default_microbatch_begin)",
    );
    expect(sql).toContain("begin=activity_location_sample_begin");
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
      "greatest(samples.refreshed_at, activity_days.source_synced_at) AS source_refreshed_at",
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
    expect(sleepHeartRateSampleSql).toContain(
      "if(is_stale, refresh_clock.refreshed_at, source_refreshed_at) AS refreshed_at",
    );
    expect(sleepHeartRateSampleSql).toContain("merged_samples AS");
  });

  it("aggregates activity sensor summary from the bounded sensor intermediary", () => {
    expect(existsSync(new URL("./activity_sensor_summary_rows.sql", import.meta.url))).toBe(true);
    const sql = readModel("activity_sensor_summary_rows");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("ref('activity_sensor_sample')");
    expect(sql).toContain("latest_sensor_samples AS");
    expect(sql).toContain("changed_sample_dirty_keys AS");
    expect(sql).toContain("missing_summary_dirty_keys AS");
    expect(sql).toContain("'join_use_nulls': 1");
    expect(sql).toContain("existing_summary_state AS");
    expect(normalizedSql).toContain("(user_id, activity_id) IN");
    expect(normalizedSql).toContain(
      "LIMIT 1 BY user_id, activity_id, channel, recorded_at",
    );
    expect(sql).toContain("source('postgres_fitness', 'activity') }} FINAL");
    expect(sql).toContain("provider_absent_at IS null");
    expect(sql).toContain("deleted_at IS null");
    expect(normalizedSql).toContain(
      "LEFT JOIN existing_summary_state ON existing_summary_state.activity_id = sample_source_versions.activity_id",
    );
    expect(normalizedSql).toContain(
      "argMax(source_refresh_version, refresh_version) AS source_refresh_version",
    );
    expect(normalizedSql).toContain("argMax(is_deleted, refresh_version) AS is_deleted");
    expect(normalizedSql).toContain("FROM existing_summary_state WHERE is_deleted = 0");
    expect(normalizedSql).toContain("(SELECT is_empty FROM target_state)");
    expect(normalizedSql).toContain("NOT (SELECT is_empty FROM target_state)");
    expect(normalizedSql).toContain(
      "sample_source_versions.source_refresh_version > existing_summary_state.source_refresh_version",
    );
    expect(normalizedSql).not.toContain("last_refreshed_at");
    expect(normalizedSql).toContain("FROM missing_summary_dirty_keys");
    expect(normalizedSql).toContain("INNER JOIN current_activity");
    expect(normalizedSql).toContain("WHERE existing_summary_state.activity_id IS null");
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
    expect(sql).toContain("affected_location_sample_ids AS");
    expect(sql).toContain("latest_location_samples AS");
    expect(sql).toContain("current_dirty_keys AS");
    expect(normalizedSql).toContain(
      "FROM {{ ref('activity_location_sample') }} AS location_samples INNER JOIN current_dirty_keys",
    );
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
    expect(normalizedSql).toContain(
      "distance_per_activity.total_distance AS total_distance",
    );
    expect(normalizedSql).not.toContain(
      "coalesce(distance_per_activity.total_distance, CAST(0, 'Nullable(Float64)'))",
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
    expect(sql).toContain("restored_dirty_keys AS");
    expect(sql).toContain("latest_sensor_samples AS");
    expect(sql).toContain("latest_location_samples AS");
    expect(normalizedSql).toContain("FROM current_activity WHERE (SELECT is_empty FROM target_state)");
    expect(sql).toContain("arraySort");
    expect(sql).toContain("groupArray(tuple(");
    expect(normalizedSql).toContain(
      "argMax( location_samples.lat, tuple( location_samples.refresh_version, location_samples.source_metric_stream_id ) )",
    );
    expect(normalizedSql).toContain(
      "argMax( location_samples.lng, tuple( location_samples.refresh_version, location_samples.source_metric_stream_id ) )",
    );
    expect(normalizedSql).toContain("WHERE location_samples.lat IS NOT null AND location_samples.lng IS NOT null");
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
    expect(sql).toContain("source('postgres_fitness', 'user_profile_current')");
    expect(sql).toContain("profile_recompute_lookback_days");
    expect(sql).toContain("groupArray(tuple(");
    expect(sql).toContain("zone_seconds AS");
    expect(sql).toContain("channel = 'heart_rate'");
    expect(sql).toContain("existing_zone_rows AS");
    expect(sql).toContain("stale_dirty_keys AS");
    expect(sql).toContain("latest_sensor_samples AS");
    expect(normalizedSql).toContain("WHERE channel = 'heart_rate' AND (user_id, activity_id) IN");
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
      "current_activity AS ( SELECT id AS activity_id, user_id, canonical_type, name, started_at, ended_at FROM {{ source('postgres_fitness', 'activity') }} FINAL",
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
    expect(locationSummarySql).toContain("current_dirty_keys AS");
    expect(normalizedLocationSql).toContain(
      "FROM {{ ref('activity_location_sample') }} AS location_samples INNER JOIN current_dirty_keys",
    );
    expect(normalizedLocationSql).toContain(
      "current_activity.activity_id = active_dirty_keys.activity_id",
    );
    expect(normalizedLocationSql).toContain("LIMIT 1 BY source_metric_stream_id");
    expect(normalizedLocationSql).toContain("FROM latest_location_samples WHERE lat IS NOT null");
    expect(normalizedLocationSql).not.toContain("WHERE (user_id, activity_id) IN");
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
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("ref('activity_summary_rows')");
    expect(sql).toContain("FROM {{ ref('activity_summary_rows') }} AS activity_summary FINAL");
    expect(sql).toContain("WHERE activity_summary.is_deleted = 0");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("query_settings={");
    expect(sql).toContain("'max_threads': 1");
    expect(sql).toContain("changed_activity_keys AS");
    expect(sql).toContain("existing_activities AS");
    expect(sql).toContain("if(activity_load.activity_id IS NULL, 1, 0) AS is_deleted");
    expect(normalizedSql).toContain(
      "refreshed_at > (SELECT last_refreshed_at FROM target_state)",
    );
    expect(sql).not.toContain("ref('activity_sensor_sample')");
    expect(sql).not.toContain("ref('deduped_sensor')");
  });

  it("materializes daily endurance load from activity summary rows and resting heart rate", () => {
    const sql = readModel("daily_endurance_load");

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("ref('activity_summary_rows')");
    expect(sql).toContain("ref('resting_heart_rate_sleep_window')");
    expect(sql).toContain("source('postgres_fitness', 'user_profile_current')");
    expect(sql).toContain("argMax(resting.resting_hr, resting.ended_at)");
    expect(sql).toContain("nullIf(user_profile.resting_hr, 0)");
    expect(sql).toContain("canonical_type IN (");
    expect(sql).toContain("'cycling'");
    expect(sql).not.toContain("'road_cycling'");
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
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("{% if is_incremental() %}");
    expect(sql).toContain("existing_rows AS");
    expect(sql).toContain("dirty_keys AS");
    expect(sql).toContain("IS DISTINCT FROM tuple(");
    expect(sql).toContain("source('analytics', 'v_daily_metrics')");
    expect(sql).toContain("nullIf(hrv, 0) AS hrv");
    expect(sql).toContain("nullIf(respiratory_rate_avg, 0) AS respiratory_rate");
    expect(sql).toContain("nullIf(efficiency_pct, 0) AS efficiency_pct");
    expect(normalizedSql).toContain(
      "nullIf( argMax(resting_hr, tuple(duration_seconds, ended_at)), 0 ) AS selected_resting_hr",
    );
    expect(sql).toContain("ref('daily_sleep')");
    expect(sql).toContain("is_deleted = 0");
    expect(sql).toContain("ref('resting_heart_rate_sleep_window')");
    expect(sql).toContain("hrv_mean_60d");
    expect(sql).toContain("rhr_mean_60d");
    expect(normalizedSql).toContain(
      "ORDER BY toUInt32(date) RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING",
    );
    expect(normalizedSql).toContain(
      "ORDER BY toUInt32(date) RANGE BETWEEN 6 PRECEDING AND CURRENT ROW",
    );
    expect(normalizedSql).toContain(
      "ORDER BY toUInt32(date) RANGE BETWEEN 34 PRECEDING AND 7 PRECEDING",
    );
    expect(sql).toContain("hrv_baseline_sample_count");
    expect(sql).toContain("hrv_baseline_coverage");
    expect(sql).toContain("hrv_mean_7d");
    expect(sql).toContain("hrv_mean_previous_28d");
    expect(sql).toContain("efficiency_mean_30d");
    expect(sql).toContain("efficiency_sd_30d");
    expect(sql).toContain("efficiency_baseline_sample_count");
    expect(sql).toContain("efficiency_baseline_coverage");
    expect(sql).toContain("efficiency_mean_7d");
    expect(sql).toContain("efficiency_mean_previous_28d");
    expect(sql).toContain("avgOrNull(hrv) OVER");
    expect(sql).toContain("avgOrNull(resting_hr) OVER");
    expect(sql).toContain("avgOrNull(respiratory_rate) OVER");
    expect(sql).toContain("avgOrNull(efficiency_pct) OVER");
    expect(sql).toContain("if(inputs_with_baselines.user_id IS NULL, 1, 0) AS is_deleted");
    expect(sql).not.toContain("analytics.v_sleep");
    expect(sql).not.toContain("source('postgres_fitness', 'metric_stream')");
    expect(sql).not.toContain("ref('deduped_sensor')");
  });

  it("materializes weekly healthspan from compact daily sleep rows", () => {
    const sql = readModel("weekly_healthspan");

    expect(sql).toContain("ref('daily_sleep')");
    expect(sql).toContain("FINAL");
    expect(sql).not.toContain("analytics.v_sleep");
  });

  it("materializes the daily recovery model from daily recovery inputs", () => {
    const sql = readModel("daily_recovery");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("{% if is_incremental() %}");
    expect(sql).toContain("changed_users AS");
    expect(sql).toContain("existing_keys AS");
    expect(normalizedSql).toContain("WHERE recovery_inputs.is_deleted = 0");
    expect(normalizedSql).toContain(
      "recovery_inputs.refreshed_at > (SELECT last_refreshed_at FROM target_state)",
    );
    expect(sql).toContain("if(sigmoid_scores.user_id IS NULL, 1, 0) AS is_deleted");
    expect(sql).toContain("ref('daily_recovery_inputs')");
    expect(sql).toContain("hrv_score");
    expect(sql).toContain("resting_hr_score");
    expect(sql).toContain("sleep_score");
    expect(sql).toContain("respiratory_rate_score");
    expect(sql).toContain("hrv_z_score");
    expect(sql).toContain("resting_hr_z_score");
    expect(sql).toContain("respiratory_rate_z_score");
    expect(sql).toContain("efficiency_z_score");
    expect(sql).toContain("hrv_mean_7d");
    expect(sql).toContain("hrv_mean_previous_28d");
    expect(sql).toContain("efficiency_mean_7d");
    expect(sql).toContain("efficiency_mean_previous_28d");
  });

  it("materializes one daily sleep row per user from the ClickHouse sleep view", () => {
    const sql = readModel("daily_sleep");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("'join_use_nulls': 1");
    expect(sql).toContain("{% if is_incremental() %}");
    expect(sql).toContain("target_state AS");
    expect(sql).toContain("changed_users AS");
    expect(sql).toContain("source('postgres_fitness', 'sleep_session')");
    expect(normalizedSql).toContain(
      "_peerdb_synced_at > (SELECT last_refreshed_at FROM target_state)",
    );
    expect(sql).toContain("dirty_dates AS");
    expect(sql).toContain("current_rows.is_deleted = 0");
    expect(sql).toContain("source('analytics', 'v_sleep')");
    expect(sql).toContain("sleep.source_name AS source_name");
    expect(sql).toContain("sleep.source_providers AS source_providers");
    expect(sql).toContain("selected_sleep.source_name AS source_name");
    expect(sql).toContain("selected_sleep.source_providers AS source_providers");
    expect(normalizedSql).toContain("PARTITION BY live_sleep.user_id, live_sleep.date");
    expect(normalizedSql).toContain(
      "ORDER BY live_sleep.duration_minutes DESC NULLS LAST, live_sleep.started_at DESC",
    );
    expect(sql).toContain("if(selected_sleep.user_id IS NULL, 1, 0) AS is_deleted");
    expect(sql).toContain("rows_to_write.is_deleted AS is_deleted");
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
    expect(sql).toContain("changed_users AS");
    expect(sql).toContain("existing_keys AS");
    expect(sql).toContain("output_min_date");
    expect(sql).toContain("ref('daily_activity_load')");
    expect(sql).toContain("WHERE is_deleted = 0");
    expect(sql).toContain("if(current_rows.user_id IS NULL, 1, 0) AS is_deleted");
    expect(normalizedSql).toContain(
      "refreshed_at > (SELECT last_refreshed_at FROM target_state)",
    );
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
    expect(sql).toContain("source('postgres_fitness', 'user_profile_current')");
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
    expect(sql).toContain("sleep_week_keys AS");
    expect(sql).toContain("changed_sleep_weeks AS");
    expect(sql).toContain("FROM sleep_week_keys");
    expect(sql).toContain("FROM changed_sleep_weeks");
    expect(normalizedSql).toContain("existing_weeks.latest_materialized_week_start - INTERVAL 26 WEEK");
    expect(sql).toContain("ref('healthspan_activity_zone_minutes')");
    expect(sql).toContain("ref('resting_heart_rate_sleep_window')");
    expect(sql).toContain("ref('activity_vo2max_estimate')");
    expect(sql).toContain("ref('daily_body_measurement')");
    expect(sql).toContain("changed_body_weeks AS");
    expect(sql).toContain("WHERE is_deleted = 0");
    expect(normalizedSql).toContain(
      "ref('daily_body_measurement') }} FINAL WHERE refreshed_at > (SELECT last_refreshed_at FROM target_state)",
    );
    expect(sql).toContain("toMonday(toDate(started_at)) AS week_start");
    expect(sql).not.toContain("activity_date");
    expect(sql).toContain("argMax(vo2max, started_at) AS latest_vo2max");
    expect(sql).toContain("avg_sleep_min");
    expect(sql).toContain("weekly_aerobic_min");
    expect(sql).toContain("weekly_high_intensity_min");
    expect(sql).toContain("latest_vo2max");
  });

  it("materializes daily body measurements from the canonical body model", () => {
    const sql = readModel("daily_body_measurement");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("order_by='(user_id, measurement_id)'");
    expect(sql).toContain("{% if is_incremental() %}");
    expect(sql).toContain("body_user_state AS");
    expect(sql).toContain("changed_user_watermarks AS");
    expect(sql).toContain("existing_rows AS");
    expect(sql).toContain("ref('body_measurement')");
    expect(sql).toContain("body.is_deleted = 0");
    expect(normalizedSql).toContain(
      "body_user_state.source_synced_at > target_user_state.last_source_synced_at",
    );
    expect(normalizedSql).toContain("if(live_body.measurement_id IS NULL, 1, 0) AS is_deleted");
    expect(sql).toContain("rows_to_write.source_synced_at AS source_synced_at");
    expect(sql).not.toContain("INTERVAL 7 DAY");
    expect(sql).not.toContain("system.view_refreshes");
    expect(sql).not.toContain("analytics.v_body_measurement");
    expect(normalizedSql).not.toContain("row_number() OVER");
    expect(sql).not.toContain("source('postgres_fitness', 'metric_stream')");
  });
});
