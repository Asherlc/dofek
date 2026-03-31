import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildManifest,
  buildTimeFilter,
  computeProgress,
  type SensorSampleRow,
  writeParquet,
} from "./process-training-export-job.ts";

// ── Helper to build a sensor sample row with defaults ──

function makeSensorSampleRow(overrides: Partial<SensorSampleRow> = {}): SensorSampleRow {
  return {
    recorded_at: "2026-03-30T15:00:00Z",
    user_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    provider_id: "wahoo",
    device_id: null,
    source_type: "ble",
    channel: "heart_rate",
    activity_id: null,
    activity_type: "cycling",
    scalar: 142,
    vector: null,
    ...overrides,
  };
}

// ── Parquet writer tests ──

describe("writeParquet", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `dofek-parquet-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("writes a valid Parquet file for scalar rows", async () => {
    const rows: SensorSampleRow[] = [
      makeSensorSampleRow({ scalar: 142, channel: "heart_rate" }),
      makeSensorSampleRow({ scalar: 200, channel: "power" }),
    ];
    const outputPath = join(testDir, "test.parquet");

    await writeParquet(rows, outputPath);

    expect(existsSync(outputPath)).toBe(true);
    // Parquet files start with the magic bytes "PAR1"
    const buffer = readFileSync(outputPath);
    expect(buffer.slice(0, 4).toString("ascii")).toBe("PAR1");
  });

  it("writes a valid Parquet file for vector rows", async () => {
    const rows: SensorSampleRow[] = [
      makeSensorSampleRow({
        channel: "imu",
        scalar: null,
        vector: [0.012, 0.138, -0.987],
        device_id: "Apple Watch",
      }),
    ];
    const outputPath = join(testDir, "vector.parquet");

    await writeParquet(rows, outputPath);

    expect(existsSync(outputPath)).toBe(true);
    const buffer = readFileSync(outputPath);
    expect(buffer.slice(0, 4).toString("ascii")).toBe("PAR1");
  });

  it("writes a valid Parquet file with mixed scalar and vector rows", async () => {
    const rows: SensorSampleRow[] = [
      makeSensorSampleRow({ scalar: 142, channel: "heart_rate" }),
      makeSensorSampleRow({
        channel: "imu",
        scalar: null,
        vector: [0.1, 0.2, 9.8],
        device_id: "Apple Watch",
        provider_id: "apple_health",
      }),
    ];
    const outputPath = join(testDir, "mixed.parquet");

    await writeParquet(rows, outputPath);

    expect(existsSync(outputPath)).toBe(true);
    const buffer = readFileSync(outputPath);
    expect(buffer.slice(0, 4).toString("ascii")).toBe("PAR1");
  });

  it("handles all nullable fields being null", async () => {
    const rows: SensorSampleRow[] = [
      makeSensorSampleRow({
        device_id: null,
        activity_id: null,
        activity_type: null,
        scalar: null,
        vector: null,
      }),
    ];
    const outputPath = join(testDir, "nulls.parquet");

    await writeParquet(rows, outputPath);

    expect(existsSync(outputPath)).toBe(true);
  });

  it("handles all nullable fields being populated", async () => {
    const rows: SensorSampleRow[] = [
      makeSensorSampleRow({
        device_id: "Edge 540",
        activity_id: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
        activity_type: "cycling",
        scalar: 250,
        vector: [1.0, 2.0, 3.0],
      }),
    ];
    const outputPath = join(testDir, "full.parquet");

    await writeParquet(rows, outputPath);

    expect(existsSync(outputPath)).toBe(true);
  });

  it("writes an empty Parquet file for zero rows", async () => {
    const outputPath = join(testDir, "empty.parquet");

    await writeParquet([], outputPath);

    expect(existsSync(outputPath)).toBe(true);
    const buffer = readFileSync(outputPath);
    expect(buffer.slice(0, 4).toString("ascii")).toBe("PAR1");
  });
});

// ── Time filter tests ──

describe("buildTimeFilter", () => {
  it("returns a SQL object for all four argument combinations", () => {
    const none = buildTimeFilter();
    const sinceOnly = buildTimeFilter("2026-03-01T00:00:00Z");
    const untilOnly = buildTimeFilter(undefined, "2026-03-31T00:00:00Z");
    const both = buildTimeFilter("2026-03-01T00:00:00Z", "2026-03-31T00:00:00Z");

    for (const result of [none, sinceOnly, untilOnly, both]) {
      expect(result).toHaveProperty("queryChunks");
    }
  });

  it("returns empty fragment when neither since nor until is provided", () => {
    const filter = buildTimeFilter();
    expect(filter.queryChunks.length).toBeLessThanOrEqual(1);
  });

  it("returns non-empty fragment when since is provided", () => {
    const filter = buildTimeFilter("2026-03-01T00:00:00Z");
    expect(filter.queryChunks.length).toBeGreaterThan(1);
  });

  it("returns non-empty fragment when until is provided", () => {
    const filter = buildTimeFilter(undefined, "2026-03-31T00:00:00Z");
    expect(filter.queryChunks.length).toBeGreaterThan(1);
  });

  it("returns non-empty fragment when both since and until are provided", () => {
    const filter = buildTimeFilter("2026-03-01T00:00:00Z", "2026-03-31T00:00:00Z");
    expect(filter.queryChunks.length).toBeGreaterThan(1);
  });
});

// ── Manifest tests ──

describe("buildManifest", () => {
  it("creates manifest with sensor_sample file when data exists", () => {
    const manifest = buildManifest("2026-03-30T15:00:00Z", undefined, undefined, 5000);
    expect(manifest.exportedAt).toBe("2026-03-30T15:00:00Z");
    expect(manifest.since).toBeNull();
    expect(manifest.until).toBeNull();
    expect(manifest.totalRows).toBe(5000);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]?.table).toBe("sensor_sample");
    expect(manifest.files[0]?.rowCount).toBe(5000);
  });

  it("returns empty files array when row count is zero", () => {
    const manifest = buildManifest("2026-03-30T15:00:00Z", undefined, undefined, 0);
    expect(manifest.files).toHaveLength(0);
    expect(manifest.totalRows).toBe(0);
  });

  it("includes since and until when provided", () => {
    const manifest = buildManifest(
      "2026-03-30T15:00:00Z",
      "2026-03-01T00:00:00Z",
      "2026-03-31T00:00:00Z",
      100,
    );
    expect(manifest.since).toBe("2026-03-01T00:00:00Z");
    expect(manifest.until).toBe("2026-03-31T00:00:00Z");
  });

  it("uses timestamp in file path with .parquet extension", () => {
    const manifest = buildManifest("2026-03-30T15:30:00Z", undefined, undefined, 100);
    expect(manifest.files[0]?.path).toBe("sensor_sample/2026-03-30T15:30:00Z.parquet");
  });
});

// ── Progress tests ──

describe("computeProgress", () => {
  it("returns base when nothing is exported", () => {
    expect(computeProgress(0, 1000, 0, 40)).toBe(0);
  });

  it("returns base + range when all exported", () => {
    expect(computeProgress(1000, 1000, 0, 40)).toBe(40);
  });

  it("returns halfway through range at 50% exported", () => {
    expect(computeProgress(500, 1000, 0, 40)).toBe(20);
  });

  it("respects base offset", () => {
    expect(computeProgress(1000, 1000, 40, 50)).toBe(90);
  });

  it("handles partial progress with base offset", () => {
    expect(computeProgress(500, 1000, 40, 50)).toBe(65);
  });
});
