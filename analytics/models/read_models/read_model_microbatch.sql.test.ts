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
    expect(sql).toContain("ref('deduped_sensor')");
    expect(sql).toContain("source('analytics', 'v_activity')");
    expect(sql).toContain("activity_id");
  });

  it("materializes activity location membership as a microbatch intermediary", () => {
    expect(existsSync(new URL("./activity_location_sample.sql", import.meta.url))).toBe(true);
    const sql = readModel("activity_location_sample");

    expect(sql).toContain("incremental_strategy='microbatch'");
    expect(sql).toContain("event_time='recorded_at'");
    expect(sql).toContain("source('postgres_fitness', 'metric_stream')");
    expect(sql).toContain("source('analytics', 'v_activity_members')");
    expect(sql).toContain("channel = 'location'");
  });

  it("aggregates activity sensor summary from the bounded sensor intermediary", () => {
    expect(existsSync(new URL("./activity_sensor_summary_rows.sql", import.meta.url))).toBe(true);
    const sql = readModel("activity_sensor_summary_rows");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("ref('activity_sensor_sample')");
    expect(normalizedSql).not.toContain("ref('activity_sensor_sample') }} AS sensor_samples FINAL");
    expect(normalizedSql).not.toContain("FROM {{ ref('deduped_sensor') }}");
    expect(normalizedSql).not.toContain("source('postgres_fitness', 'metric_stream')");
  });

  it("aggregates activity location summary from the bounded location intermediary", () => {
    expect(existsSync(new URL("./activity_location_summary_rows.sql", import.meta.url))).toBe(true);
    const sql = readModel("activity_location_summary_rows");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("ref('activity_location_sample')");
    expect(normalizedSql).not.toContain("ref('activity_location_sample') }} AS location_samples FINAL");
    expect(normalizedSql).not.toContain("FROM analytics.deduped_location");
    expect(normalizedSql).not.toContain("source('postgres_fitness', 'metric_stream')");
  });

  it("joins activity summary from bounded aggregate intermediaries", () => {
    const sql = readModel("activity_summary_rows");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("ref('activity_sensor_summary_rows')");
    expect(sql).toContain("ref('activity_location_summary_rows')");
    expect(normalizedSql).not.toContain("ref('activity_sensor_sample')");
    expect(normalizedSql).not.toContain("ref('activity_location_sample')");
    expect(normalizedSql).not.toContain("FROM {{ ref('deduped_sensor') }}");
    expect(normalizedSql).not.toContain("FROM analytics.deduped_location");
    expect(normalizedSql).not.toContain("source('postgres_fitness', 'metric_stream')");
  });
});
