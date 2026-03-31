import { describe, expect, it } from "vitest";
import {
  buildManifest,
  buildTimeFilter,
  computeProgress,
  loadContractValidator,
  type SensorSampleRow,
  sensorSampleCsvHeader,
  sensorSampleRowsToCsvContent,
  sensorSampleRowToCsv,
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

describe("sensorSampleCsvHeader", () => {
  it("returns a comma-separated header string with all columns", () => {
    const header = sensorSampleCsvHeader();
    expect(header).toContain("recorded_at");
    expect(header).toContain("channel");
    expect(header).toContain("scalar");
    expect(header).toContain("vector");
    expect(header.split(",").length).toBe(10);
  });

  it("starts with recorded_at", () => {
    const header = sensorSampleCsvHeader();
    expect(header.startsWith("recorded_at")).toBe(true);
  });

  it("ends with vector", () => {
    const header = sensorSampleCsvHeader();
    expect(header.endsWith("vector")).toBe(true);
  });

  it("includes all required columns in order", () => {
    const header = sensorSampleCsvHeader();
    const fields = header.split(",");
    expect(fields).toEqual([
      "recorded_at",
      "user_id",
      "provider_id",
      "device_id",
      "source_type",
      "channel",
      "activity_id",
      "activity_type",
      "scalar",
      "vector",
    ]);
  });
});

describe("sensorSampleRowToCsv", () => {
  it("outputs values in the same order as the header", () => {
    const row = makeSensorSampleRow({ scalar: 142 });
    const csv = sensorSampleRowToCsv(row);
    const values = csv.split(",");
    expect(values[0]).toBe("2026-03-30T15:00:00Z");
    expect(values[1]).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(values[2]).toBe("wahoo");
    expect(values[5]).toBe("heart_rate");
    expect(values[8]).toBe("142");
  });

  it("represents null values as empty strings", () => {
    const row = makeSensorSampleRow({ device_id: null, activity_id: null, vector: null });
    const csv = sensorSampleRowToCsv(row);
    const values = csv.split(",");
    expect(values[3]).toBe(""); // device_id
    expect(values[6]).toBe(""); // activity_id
    expect(values[9]).toBe(""); // vector
  });

  it("has the same number of fields as the header", () => {
    const csv = sensorSampleRowToCsv(makeSensorSampleRow());
    const headerCount = sensorSampleCsvHeader().split(",").length;
    const valueCount = csv.split(",").length;
    expect(valueCount).toBe(headerCount);
  });

  it("handles vector channel rows", () => {
    const row = makeSensorSampleRow({
      channel: "imu",
      scalar: null,
      vector: "{0.012,0.138,-0.987}",
      device_id: "Apple Watch",
      source_type: "ble",
    });
    const csv = sensorSampleRowToCsv(row);
    const values = csv.split(",");
    expect(values[5]).toBe("imu");
    expect(values[8]).toBe(""); // scalar is null
    // vector field contains commas in the array, so rejoin the remaining
    expect(values.slice(9).join(",")).toBe("{0.012,0.138,-0.987}");
  });
});

describe("sensorSampleRowsToCsvContent", () => {
  it("returns header only for empty array", () => {
    const content = sensorSampleRowsToCsvContent([]);
    const lines = content.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(sensorSampleCsvHeader());
  });

  it("includes header and one row for single-element array", () => {
    const content = sensorSampleRowsToCsvContent([makeSensorSampleRow()]);
    const lines = content.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(sensorSampleCsvHeader());
    expect(lines[1]).toContain("142"); // scalar value
  });

  it("includes header and multiple rows", () => {
    const rows = [
      makeSensorSampleRow({ scalar: 100, channel: "heart_rate" }),
      makeSensorSampleRow({ scalar: 200, channel: "power" }),
    ];
    const content = sensorSampleRowsToCsvContent(rows);
    const lines = content.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("100");
    expect(lines[2]).toContain("200");
  });
});

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

  it("uses timestamp in file path", () => {
    const manifest = buildManifest("2026-03-30T15:30:00Z", undefined, undefined, 100);
    expect(manifest.files[0]?.path).toBe("sensor_sample/2026-03-30T15:30:00Z.csv");
  });
});

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

describe("contract validation", () => {
  it("validates a valid scalar sensor sample row", () => {
    const validate = loadContractValidator();
    const row = {
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
    };
    expect(validate(row)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("validates a valid vector sensor sample row", () => {
    const validate = loadContractValidator();
    const row = {
      recorded_at: "2026-03-30T15:00:00.020Z",
      user_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      provider_id: "apple_health",
      device_id: "Apple Watch",
      source_type: "ble",
      channel: "imu",
      activity_id: null,
      activity_type: null,
      scalar: null,
      vector: "{0.012,0.138,-0.987}",
    };
    expect(validate(row)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("rejects a row with invalid source_type", () => {
    const validate = loadContractValidator();
    const row = {
      recorded_at: "2026-03-30T15:00:00Z",
      user_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      provider_id: "wahoo",
      device_id: null,
      source_type: "invalid_source",
      channel: "heart_rate",
      activity_id: null,
      activity_type: "cycling",
      scalar: 142,
      vector: null,
    };
    expect(validate(row)).toBe(false);
  });

  it("rejects a row with missing required fields", () => {
    const validate = loadContractValidator();
    const row = {
      recorded_at: "2026-03-30T15:00:00Z",
      // missing user_id and other required fields
    };
    expect(validate(row)).toBe(false);
  });

  it("rejects a row with extra properties", () => {
    const validate = loadContractValidator();
    const row = {
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
      extra_field: "should not be here",
    };
    expect(validate(row)).toBe(false);
  });
});
