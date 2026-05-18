import { describe, expect, it } from "vitest";
import {
  buildBackfillSql,
  buildWindows,
  formatSqlLiteral,
  parseCliOptions,
} from "./backfill-location-points.ts";

describe("backfill-location-points", () => {
  it("builds bounded daily windows", () => {
    const windows = buildWindows({
      startDate: "2026-05-09",
      endDate: "2026-05-12",
      windowDays: 1,
    });

    expect(windows).toEqual([
      { startDate: "2026-05-09", endDate: "2026-05-10" },
      { startDate: "2026-05-10", endDate: "2026-05-11" },
      { startDate: "2026-05-11", endDate: "2026-05-12" },
    ]);
  });

  it("quotes SQL literals", () => {
    expect(formatSqlLiteral("2026-05-09")).toBe("'2026-05-09'");
    expect(formatSqlLiteral("watch's gps")).toBe("'watch''s gps'");
  });

  it("builds insert-only SQL scoped to the requested window", () => {
    const sql = buildBackfillSql({
      startDate: "2026-05-09",
      endDate: "2026-05-10",
      statementTimeout: "15min",
      recompress: true,
    });

    expect(sql).toContain("recorded_at >= '2026-05-09'::timestamptz");
    expect(sql).toContain("recorded_at < '2026-05-10'::timestamptz");
    expect(sql).toContain("INSERT INTO fitness.metric_stream");
    expect(sql).toContain("CREATE TEMPORARY TABLE pg_temp.existing_location_rows");
    expect(sql).toContain("public.ST_Y(point)::real AS latitude");
    expect(sql).toContain("public.ST_X(point)::real AS longitude");
    expect(sql).toContain("AND point IS NOT NULL");
    expect(sql).toContain("CREATE INDEX existing_location_rows_lookup_idx");
    expect(sql).toContain("WHERE NOT EXISTS");
    expect(sql).toContain("SELECT compress_chunk");
    expect(sql).not.toContain("  latitude,\n  longitude\nFROM fitness.metric_stream");
    expect(sql).not.toContain("  latitude,\n  longitude,\n  metadata");
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bpg_advisory_lock\b/i);
  });

  it("parses conservative CLI defaults", () => {
    const options = parseCliOptions(["--start", "2026-05-09", "--end", "2026-05-11"]);

    expect(options).toMatchObject({
      dryRun: true,
      execute: false,
      maxWindows: 1,
      recompress: false,
      sshHost: "dofek-server",
      statementTimeout: "15min",
      windowDays: 1,
    });
  });
});
