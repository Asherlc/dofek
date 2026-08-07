import { describe, expect, it } from "vitest";
import {
  buildIncrementalDedupedSensorMigrationStatements,
  buildIncrementalDedupedSensorStatements,
} from "./clickhouse-deduped-sensor.ts";

describe("ClickHouse deduped sensor bootstrap", () => {
  it("creates dbt-owned target tables without custom dirty-key processors", () => {
    const sql = buildIncrementalDedupedSensorStatements().join("\n");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.sensor_scalar_sample");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.deduped_sensor");
    expect(sql).toContain("ENGINE = ReplacingMergeTree(_peerdb_version)");
    expect(sql).toContain("ENGINE = ReplacingMergeTree(refresh_version)");
    expect(sql).not.toContain("analytics.sensor_dirty_key");
    expect(sql).not.toContain("CREATE MATERIALIZED VIEW");
  });

  it("keeps migration statements schema-only because dbt owns backfills", () => {
    const sql = buildIncrementalDedupedSensorMigrationStatements().join("\n");

    expect(sql).toContain("DROP TABLE IF EXISTS analytics.sensor_dirty_key");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.sensor_scalar_sample");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.deduped_sensor");
    expect(sql).not.toContain("INSERT INTO analytics.sensor_scalar_sample");
    expect(sql).not.toContain("INSERT INTO analytics.deduped_sensor");
    expect(sql).not.toContain("CREATE MATERIALIZED VIEW");
  });
});
