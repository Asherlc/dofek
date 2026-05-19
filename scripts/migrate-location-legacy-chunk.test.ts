import { describe, expect, it } from "vitest";
import {
  buildChunkListSql,
  buildChunkMigrationSql,
  parseCliOptions,
} from "./migrate-location-legacy-chunk.ts";

describe("migrate-location-legacy-chunk", () => {
  it("lists physical Timescale chunks in a bounded window", () => {
    const sql = buildChunkListSql({ startDate: "2021-07-01", endDate: "2021-08-01" });

    expect(sql).toContain("hypertable_schema = 'fitness'");
    expect(sql).toContain("hypertable_name = 'metric_stream'");
    expect(sql).toContain("range_start < '2021-08-01'::timestamptz");
    expect(sql).toContain("range_end > '2021-07-01'::timestamptz");
    expect(sql).toContain("chunk_schema || '.' || chunk_name");
  });

  it("builds chunk-scoped migration SQL with guarded legacy deletion", () => {
    const sql = buildChunkMigrationSql({
      chunkSchema: "_timescaledb_internal",
      chunkName: "_hyper_1_160_chunk",
      statementTimeout: "360min",
      write: true,
      recompress: true,
    });

    expect(sql).toContain('ONLY "_timescaledb_internal"."_hyper_1_160_chunk"');
    expect(sql).toContain(
      'SELECT decompress_chunk(\'"_timescaledb_internal"."_hyper_1_160_chunk"\'::regclass',
    );
    expect(sql).toContain("INSERT INTO fitness.metric_stream");
    expect(sql).toContain("DELETE FROM ONLY");
    expect(sql).toContain("channel IN ('lat', 'lng')");
    expect(sql).toContain("channel = 'gps_accuracy'");
    expect(sql).toContain("WHERE (SELECT count FROM missing_after) = 0");
    expect(sql).toContain("exact_missing_after=");
    expect(sql).toContain("SELECT compress_chunk");
    expect(sql).not.toContain("fitness.metric_stream\n  WHERE channel IN ('lat', 'lng')");
  });

  it("defaults to validation-only dry-run mode", () => {
    const options = parseCliOptions(["--start", "2021-07-01", "--end", "2021-08-01"]);

    expect(options).toMatchObject({
      dryRun: true,
      endDate: "2021-08-01",
      execute: false,
      maxChunks: 1,
      recompress: false,
      sshHost: "dofek-server",
      startDate: "2021-07-01",
      statementTimeout: "15min",
      write: false,
    });
  });

  it("can target a specific physical chunk directly", () => {
    const options = parseCliOptions([
      "--chunk-schema",
      "_timescaledb_internal",
      "--chunk-name",
      "_hyper_1_150_chunk",
      "--execute",
    ]);

    expect(options).toMatchObject({
      chunkSchema: "_timescaledb_internal",
      chunkName: "_hyper_1_150_chunk",
      dryRun: false,
      execute: true,
      maxChunks: 1,
    });
  });

  it("rejects impossible calendar dates", () => {
    expect(() => parseCliOptions(["--start", "2026-02-31", "--end", "2026-03-02"])).toThrow(
      "Invalid YYYY-MM-DD date",
    );
  });
});
