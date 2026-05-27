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
      "sleep_heart_rate_sample",
      "resting_heart_rate_sleep_window",
      "activity_sensor_sample",
      "activity_location_sample",
      "activity_sensor_summary_rows",
      "activity_location_summary_rows",
      "activity_summary_rows",
      "activity_vo2max_estimate",
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

  it("materializes activity sensor membership as a microbatch intermediary", () => {
    expect(existsSync(new URL("./activity_sensor_sample.sql", import.meta.url))).toBe(true);
    const sql = readModel("activity_sensor_sample");

    expect(sql).toContain("incremental_strategy='microbatch'");
    expect(sql).toContain("event_time='recorded_at'");
    expect(sql).toContain("lookback=3");
    expect(sql).toContain("ref('deduped_sensor')");
    expect(sql).toContain("WITH RECURSIVE {{ bounded_activity_graph() }}");
    expect(sql).toContain("bounded_activity_graph()");
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
    expect(sql).toContain("WITH RECURSIVE {{ bounded_activity_graph() }}");
    expect(sql).toContain("bounded_activity_graph()");
    expect(sql).not.toContain("source('analytics', 'v_activity_members')");
    expect(sql).toContain("channel = 'location'");
  });

  it("bounds activity graph construction to the active microbatch window", () => {
    const sql = readProjectFile("analytics/macros/bounded_activity_graph.sql");

    expect(sql).toContain("__dbt_internal_microbatch_event_time_start");
    expect(sql).toContain("__dbt_internal_microbatch_event_time_end");
    expect(sql).toContain("started_at < toDateTime64('{{ batch_end }}', 6, 'UTC')");
    expect(sql).toContain(
      "coalesce(ended_at, started_at + INTERVAL 12 HOUR) >= toDateTime64('{{ batch_start }}', 6, 'UTC')",
    );
  });

  it("uses the same null-ended activity window for overlap matching", () => {
    const sql = readProjectFile("analytics/macros/bounded_activity_graph.sql");

    expect(sql).toContain("coalesce(left_activity.ended_at, left_activity.started_at + INTERVAL 12 HOUR)");
    expect(sql).toContain("coalesce(right_activity.ended_at, right_activity.started_at + INTERVAL 12 HOUR)");
    expect(sql).not.toContain("INTERVAL 1 HOUR");
  });

  it("uses merged group time bounds for current activity sensor membership", () => {
    const sql = readProjectFile("analytics/macros/bounded_activity_graph.sql");

    expect(sql).toContain("min(ranked.started_at) AS started_at");
    expect(sql).toContain("max(coalesce(ranked.ended_at, ranked.started_at + INTERVAL 12 HOUR)) AS ended_at");
    expect(sql).toContain("max(ranked._peerdb_synced_at) AS source_synced_at");
    expect(sql).not.toContain("any(best.started_at) AS started_at");
    expect(sql).not.toContain("any(best.ended_at) AS ended_at");
  });

  it("carries upstream source freshness through lookback microbatch intermediaries", () => {
    const dedupedSensorSql = readModel("deduped_sensor");
    const activitySensorSampleSql = readModel("activity_sensor_sample");
    const activityLocationSampleSql = readModel("activity_location_sample");
    const sleepHeartRateSampleSql = readModel("sleep_heart_rate_sample");

    expect(dedupedSensorSql).toContain("max(samples._peerdb_synced_at) AS refreshed_at");
    expect(dedupedSensorSql).not.toContain("now64(9) AS refreshed_at");
    expect(activitySensorSampleSql).toContain(
      "greatest(samples.refreshed_at, current_activity.source_synced_at) AS source_refreshed_at",
    );
    expect(activitySensorSampleSql).toContain("source_refreshed_at AS refreshed_at");
    expect(activitySensorSampleSql).not.toContain("now64(9) AS refreshed_at");
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
    expect(sql).toContain("(sensor_samples.user_id, sensor_samples.activity_id) IN");
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
    expect(sql).toContain("(location_samples.user_id, location_samples.activity_id) IN");
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

    expect(sql).toContain("ref('activity_sensor_summary_rows')");
    expect(sql).toContain("ref('activity_location_summary_rows')");
    expect(sql).toContain("(user_id, activity_id) IN");
    expect(sql).toContain("changed_activity_dirty_keys");
    expect(sql).toContain("source('postgres_fitness', 'activity') }} FINAL");
    expect(sql).not.toContain("source('analytics', 'v_activity')");
    expect(normalizedSql).not.toContain("ref('activity_sensor_sample')");
    expect(normalizedSql).not.toContain("ref('activity_location_sample')");
    expect(normalizedSql).not.toContain("FROM {{ ref('deduped_sensor') }}");
    expect(normalizedSql).not.toContain("FROM analytics.deduped_location");
    expect(normalizedSql).not.toContain("source('postgres_fitness', 'metric_stream')");
    expect(normalizedSql).not.toContain("existing_activity_summary AS (");
    expect(normalizedSql).not.toContain("stale_activity_dirty_keys AS (");
    expect(normalizedSql).not.toContain("ref('activity_sensor_summary_rows') }} FINAL");
    expect(normalizedSql).not.toContain("ref('activity_location_summary_rows') }} FINAL");
    expect(normalizedSql).toContain("LIMIT 1 BY user_id, activity_id");
    expect(normalizedSql).not.toContain(
      "SELECT * FROM {{ ref('activity_sensor_summary_rows') }} FINAL WHERE is_deleted = 0 )",
    );
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
});
