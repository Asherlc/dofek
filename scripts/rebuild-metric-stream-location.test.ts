import { describe, expect, it } from "vitest";
import {
  buildCopyTaskSql,
  buildPrepareSql,
  buildStatusSql,
  parseCliOptions,
} from "./rebuild-metric-stream-location.ts";

describe("rebuild-metric-stream-location", () => {
  it("prepares a compressed replacement hypertable and task table", () => {
    const sql = buildPrepareSql({ statementTimeout: "15min" });

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS fitness.metric_stream_rebuild");
    expect(sql).toContain("DROP CONSTRAINT");
    expect(sql).toContain("public.create_hypertable");
    expect(sql).toContain("public.set_chunk_time_interval");
    expect(sql).toContain("timescaledb.compress_segmentby = 'user_id,provider_id,channel'");
    expect(sql).toContain("timescaledb.compress_orderby = 'recorded_at DESC'");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS fitness.metric_stream_rebuild_task");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS next_range_start timestamptz");
    expect(sql).toContain("INSERT INTO fitness.metric_stream_rebuild_task");
    expect(sql).not.toContain("latitude real");
    expect(sql).not.toContain("longitude real");
    expect(sql).not.toContain("REFERENCES fitness.user_profile");
    expect(sql).not.toContain("REFERENCES fitness.provider");
    expect(sql).not.toContain("REFERENCES fitness.activity");
  });

  it("copies one source chunk into final rows and compresses replacement chunks immediately", () => {
    const sql = buildCopyTaskSql({ copyRangeInterval: "1 hour", statementTimeout: "60min" });

    expect(sql).not.toContain("ADD COLUMN IF NOT EXISTS next_range_start timestamptz");
    expect(sql).toContain(
      "copy_range_start := COALESCE(selected_task.next_range_start, selected_task.range_start)",
    );
    expect(sql).toContain(
      "copy_range_end := LEAST(copy_range_start + '1 hour'::interval, selected_task.range_end)",
    );
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("(COALESCE(next_range_start, range_start) > range_start) DESC");
    expect(sql).toContain("THEN COALESCE(next_range_start, range_start)");
    expect(sql).toContain("FROM fitness.metric_stream AS metric_stream");
    expect(sql).toContain("metric_stream.recorded_at >= %L::timestamptz");
    expect(sql).toContain("metric_stream.recorded_at < %L::timestamptz");
    expect(sql).toContain("ORDER BY metric_stream.id");
    expect(sql).not.toContain("ORDER BY metric_stream.ctid");
    expect(sql).toContain("WHERE metric_stream.channel = 'lat'");
    expect(sql).toContain("WHERE metric_stream.channel = 'lng'");
    expect(sql).toContain("WHERE metric_stream.channel = 'gps_accuracy'");
    expect(sql).toContain("metric_stream.channel NOT IN ('lat', 'lng')");
    expect(sql).toContain("metric_stream.channel = 'gps_accuracy'");
    expect(sql).toContain("metric_stream.channel = 'location'");
    expect(sql).toContain("metric_stream_rebuild_location_source_gps_id_idx");
    expect(sql).toContain("metric_stream_rebuild_location_source_existing_location_id_idx");
    expect(sql).toContain("INSERT INTO fitness.metric_stream_rebuild");
    expect(sql).toContain("metric_stream_rebuild_passthrough_source_rows");
    expect(sql).toContain("passthrough_verified_count");
    expect(sql).toContain("rebuild_rows.recorded_at >= copy_range_start");
    expect(sql).toContain("rebuild_rows.recorded_at < copy_range_end");
    expect(sql).toContain("source_has_external_id");
    expect(sql).toContain("source_external_id_expression");
    expect(sql).toContain("public.ST_MakePoint");
    expect(sql).toContain("'gps_accuracy_m'");
    expect(sql).toContain("public.compress_chunk");
    expect(sql).toContain("next_range_start = copy_range_end");
    expect(sql).toContain("WHEN copy_range_end >= range_end THEN clock_timestamp()");
  });

  it("reports task progress as a percentage", () => {
    const sql = buildStatusSql();

    expect(sql).toContain("completed_tasks");
    expect(sql).toContain("total_tasks");
    expect(sql).toContain("percent_done");
  });

  it("parses prepare and copy execution options", () => {
    const options = parseCliOptions([
      "--prepare",
      "--copy",
      "--execute",
      "--max-tasks",
      "3",
      "--statement-timeout",
      "90min",
      "--slice-interval",
      "1 day",
    ]);

    expect(options).toMatchObject({
      copy: true,
      dryRun: false,
      execute: true,
      maxTasks: 3,
      prepare: true,
      copyRangeInterval: "1 day",
      statementTimeout: "90min",
    });
  });
});
