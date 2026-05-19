import { describe, expect, it } from "vitest";
import { buildValidationSql, parseCliOptions } from "./validate-location-backfill.ts";

describe("validate-location-backfill", () => {
  it("builds exact missing-location validation SQL without inserting rows", () => {
    const sql = buildValidationSql({
      startDate: "2021-07-01",
      endDate: "2021-08-01",
      statementTimeout: "360min",
      recompress: true,
    });

    expect(sql).toContain("recorded_at >= '2021-07-01'::timestamptz");
    expect(sql).toContain("recorded_at < '2021-08-01'::timestamptz");
    expect(sql).toContain("public.ST_Y(point)::real AS latitude");
    expect(sql).toContain("public.ST_X(point)::real AS longitude");
    expect(sql).toContain("exact_missing_rows=");
    expect(sql).toContain("source_pairs=");
    expect(sql).toContain("existing_location_rows=");
    expect(sql).toContain("SELECT compress_chunk");
    expect(sql).not.toMatch(/\bINSERT INTO fitness\.metric_stream\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
  });

  it("defaults to dry-run and no recompression", () => {
    const options = parseCliOptions(["--start", "2021-07-01", "--end", "2021-08-01"]);

    expect(options).toMatchObject({
      dryRun: true,
      execute: false,
      recompress: false,
      sshHost: "dofek-server",
      statementTimeout: "15min",
    });
  });
});
