import { describe, expect, it } from "vitest";
import {
  buildManifest,
  buildTimeFilter,
  computeProgress,
  type ImuRow,
  imuCsvHeader,
  imuRowToCsv,
  imuRowsToCsvContent,
  type MetricStreamRow,
  metricStreamCsvHeader,
  metricStreamRowToCsv,
  metricStreamRowsToCsvContent,
} from "./process-training-export-job.ts";

describe("metricStreamCsvHeader", () => {
  it("returns a comma-separated header string", () => {
    const header = metricStreamCsvHeader();
    expect(header).toContain("recorded_at");
    expect(header).toContain("heart_rate");
    expect(header).toContain("activity_type");
    expect(header).toContain("source_name");
    expect(header.split(",").length).toBeGreaterThan(10);
  });

  it("starts with recorded_at", () => {
    const header = metricStreamCsvHeader();
    expect(header.startsWith("recorded_at")).toBe(true);
  });

  it("ends with source_name", () => {
    const header = metricStreamCsvHeader();
    expect(header.endsWith("source_name")).toBe(true);
  });
});

describe("metricStreamRowToCsv", () => {
  const fullRow: MetricStreamRow = {
    recorded_at: "2026-03-30T15:00:00Z",
    user_id: "user-1",
    activity_id: "act-1",
    provider_id: "wahoo",
    heart_rate: 142,
    power: 200,
    cadence: 85,
    speed: 8.5,
    lat: 40.7128,
    lng: -74.006,
    altitude: 50.0,
    temperature: 22.0,
    grade: 3.5,
    vertical_speed: 0.5,
    spo2: 98,
    respiratory_rate: 20,
    gps_accuracy: 5,
    accumulated_power: 10000,
    stress: 30,
    left_right_balance: 50.5,
    vertical_oscillation: 8.2,
    stance_time: 250,
    stance_time_percent: 35,
    step_length: 1.2,
    vertical_ratio: 7.8,
    stance_time_balance: 49.5,
    ground_contact_time: 245,
    stride_length: 2.4,
    form_power: 45,
    leg_spring_stiff: 10.5,
    air_power: 15,
    left_torque_effectiveness: 72,
    right_torque_effectiveness: 70,
    left_pedal_smoothness: 18,
    right_pedal_smoothness: 17,
    combined_pedal_smoothness: 17.5,
    blood_glucose: null,
    audio_exposure: null,
    skin_temperature: null,
    electrodermal_activity: null,
    source_name: "Wahoo ELEMNT",
    activity_type: "cycling",
  };

  it("outputs values in the same order as the header", () => {
    const csv = metricStreamRowToCsv(fullRow);
    const values = csv.split(",");
    expect(values[0]).toBe("2026-03-30T15:00:00Z");
    expect(values[1]).toBe("user-1");
    expect(values[4]).toBe("cycling");
    expect(values[5]).toBe("142");
  });

  it("represents null values as empty strings", () => {
    const csv = metricStreamRowToCsv(fullRow);
    const values = csv.split(",");
    const headerFields = metricStreamCsvHeader().split(",");
    const bloodGlucoseIndex = headerFields.indexOf("blood_glucose");
    expect(values[bloodGlucoseIndex]).toBe("");
  });

  it("has the same number of fields as the header", () => {
    const csv = metricStreamRowToCsv(fullRow);
    const headerCount = metricStreamCsvHeader().split(",").length;
    const valueCount = csv.split(",").length;
    expect(valueCount).toBe(headerCount);
  });
});

describe("imuCsvHeader", () => {
  it("returns correct columns", () => {
    const header = imuCsvHeader();
    const fields = header.split(",");
    expect(fields).toEqual([
      "recorded_at",
      "user_id",
      "device_id",
      "device_type",
      "provider_id",
      "x",
      "y",
      "z",
      "gyroscope_x",
      "gyroscope_y",
      "gyroscope_z",
    ]);
  });
});

describe("imuRowToCsv", () => {
  const row: ImuRow = {
    recorded_at: "2026-03-30T15:00:00.020Z",
    user_id: "user-1",
    device_id: "Apple Watch",
    device_type: "apple_watch",
    provider_id: "apple_health",
    x: 0.012,
    y: 0.138,
    z: -0.987,
    gyroscope_x: null,
    gyroscope_y: null,
    gyroscope_z: null,
  };

  it("outputs values in correct order", () => {
    const csv = imuRowToCsv(row);
    const values = csv.split(",");
    expect(values[0]).toBe("2026-03-30T15:00:00.020Z");
    expect(values[3]).toBe("apple_watch");
    expect(values[5]).toBe("0.012");
  });

  it("represents null gyroscope values as empty strings", () => {
    const csv = imuRowToCsv(row);
    const values = csv.split(",");
    expect(values[8]).toBe("");
    expect(values[9]).toBe("");
    expect(values[10]).toBe("");
  });

  it("includes gyroscope values when present", () => {
    const rowWithGyro: ImuRow = {
      ...row,
      gyroscope_x: 1.5,
      gyroscope_y: -0.3,
      gyroscope_z: 0.8,
    };
    const csv = imuRowToCsv(rowWithGyro);
    const values = csv.split(",");
    expect(values[8]).toBe("1.5");
    expect(values[9]).toBe("-0.3");
    expect(values[10]).toBe("0.8");
  });

  it("has the same number of fields as the header", () => {
    const csv = imuRowToCsv(row);
    const headerCount = imuCsvHeader().split(",").length;
    const valueCount = csv.split(",").length;
    expect(valueCount).toBe(headerCount);
  });
});

describe("buildTimeFilter", () => {
  it("returns SQL objects for all four argument combinations", () => {
    const none = buildTimeFilter();
    const sinceOnly = buildTimeFilter("2026-03-01T00:00:00Z");
    const untilOnly = buildTimeFilter(undefined, "2026-03-31T00:00:00Z");
    const both = buildTimeFilter("2026-03-01T00:00:00Z", "2026-03-31T00:00:00Z");

    // All return objects with metricStreamFilter and imuFilter
    for (const result of [none, sinceOnly, untilOnly, both]) {
      expect(result).toHaveProperty("metricStreamFilter");
      expect(result).toHaveProperty("imuFilter");
    }
  });

  it("returns empty fragments when neither since nor until is provided", () => {
    const { metricStreamFilter, imuFilter } = buildTimeFilter();
    // Empty sql`` templates have no query chunks with content
    expect(metricStreamFilter.queryChunks.length).toBeLessThanOrEqual(1);
    expect(imuFilter.queryChunks.length).toBeLessThanOrEqual(1);
  });

  it("returns non-empty fragments when since is provided", () => {
    const { metricStreamFilter, imuFilter } = buildTimeFilter("2026-03-01T00:00:00Z");
    expect(metricStreamFilter.queryChunks.length).toBeGreaterThan(1);
    expect(imuFilter.queryChunks.length).toBeGreaterThan(1);
  });

  it("returns non-empty fragments when until is provided", () => {
    const { metricStreamFilter, imuFilter } = buildTimeFilter(undefined, "2026-03-31T00:00:00Z");
    expect(metricStreamFilter.queryChunks.length).toBeGreaterThan(1);
    expect(imuFilter.queryChunks.length).toBeGreaterThan(1);
  });

  it("returns non-empty fragments when both since and until are provided", () => {
    const { metricStreamFilter, imuFilter } = buildTimeFilter(
      "2026-03-01T00:00:00Z",
      "2026-03-31T00:00:00Z",
    );
    expect(metricStreamFilter.queryChunks.length).toBeGreaterThan(1);
    expect(imuFilter.queryChunks.length).toBeGreaterThan(1);
  });
});

// ── Helper to build a full metric row with defaults ──

function makeMetricRow(overrides: Partial<MetricStreamRow> = {}): MetricStreamRow {
  return {
    recorded_at: "2026-03-30T15:00:00Z",
    user_id: "user-1",
    activity_id: null,
    provider_id: "wahoo",
    heart_rate: 142,
    power: 200,
    cadence: 85,
    speed: 8.5,
    lat: null,
    lng: null,
    altitude: null,
    temperature: null,
    grade: null,
    vertical_speed: null,
    spo2: null,
    respiratory_rate: null,
    gps_accuracy: null,
    accumulated_power: null,
    stress: null,
    left_right_balance: null,
    vertical_oscillation: null,
    stance_time: null,
    stance_time_percent: null,
    step_length: null,
    vertical_ratio: null,
    stance_time_balance: null,
    ground_contact_time: null,
    stride_length: null,
    form_power: null,
    leg_spring_stiff: null,
    air_power: null,
    left_torque_effectiveness: null,
    right_torque_effectiveness: null,
    left_pedal_smoothness: null,
    right_pedal_smoothness: null,
    combined_pedal_smoothness: null,
    blood_glucose: null,
    audio_exposure: null,
    skin_temperature: null,
    electrodermal_activity: null,
    source_name: "Wahoo",
    activity_type: "cycling",
    ...overrides,
  };
}

function makeImuRow(overrides: Partial<ImuRow> = {}): ImuRow {
  return {
    recorded_at: "2026-03-30T15:00:00.020Z",
    user_id: "user-1",
    device_id: "Apple Watch",
    device_type: "apple_watch",
    provider_id: "apple_health",
    x: 0.012,
    y: 0.138,
    z: -0.987,
    gyroscope_x: null,
    gyroscope_y: null,
    gyroscope_z: null,
    ...overrides,
  };
}

describe("metricStreamRowsToCsvContent", () => {
  it("returns header only for empty array", () => {
    const content = metricStreamRowsToCsvContent([]);
    const lines = content.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(metricStreamCsvHeader());
  });

  it("includes header and one row for single-element array", () => {
    const content = metricStreamRowsToCsvContent([makeMetricRow()]);
    const lines = content.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(metricStreamCsvHeader());
    expect(lines[1]).toContain("142"); // heart_rate
  });

  it("includes header and multiple rows", () => {
    const rows = [makeMetricRow({ heart_rate: 100 }), makeMetricRow({ heart_rate: 150 })];
    const content = metricStreamRowsToCsvContent(rows);
    const lines = content.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("100");
    expect(lines[2]).toContain("150");
  });
});

describe("imuRowsToCsvContent", () => {
  it("returns header only for empty array", () => {
    const content = imuRowsToCsvContent([]);
    const lines = content.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(imuCsvHeader());
  });

  it("includes header and rows", () => {
    const content = imuRowsToCsvContent([makeImuRow(), makeImuRow({ x: 0.5 })]);
    const lines = content.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("0.012");
    expect(lines[2]).toContain("0.5");
  });
});

describe("buildManifest", () => {
  it("creates manifest with both streams when both have data", () => {
    const manifest = buildManifest("2026-03-30T15:00:00Z", undefined, undefined, 1000, 5000);
    expect(manifest.exportedAt).toBe("2026-03-30T15:00:00Z");
    expect(manifest.since).toBeNull();
    expect(manifest.until).toBeNull();
    expect(manifest.totalRows).toBe(6000);
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files[0]?.table).toBe("metric_stream");
    expect(manifest.files[0]?.rowCount).toBe(1000);
    expect(manifest.files[1]?.table).toBe("inertial_measurement_unit_sample");
    expect(manifest.files[1]?.rowCount).toBe(5000);
  });

  it("omits metric_stream file when count is zero", () => {
    const manifest = buildManifest("2026-03-30T15:00:00Z", undefined, undefined, 0, 5000);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]?.table).toBe("inertial_measurement_unit_sample");
    expect(manifest.totalRows).toBe(5000);
  });

  it("omits IMU file when count is zero", () => {
    const manifest = buildManifest("2026-03-30T15:00:00Z", undefined, undefined, 1000, 0);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]?.table).toBe("metric_stream");
    expect(manifest.totalRows).toBe(1000);
  });

  it("returns empty files array when both counts are zero", () => {
    const manifest = buildManifest("2026-03-30T15:00:00Z", undefined, undefined, 0, 0);
    expect(manifest.files).toHaveLength(0);
    expect(manifest.totalRows).toBe(0);
  });

  it("includes since and until when provided", () => {
    const manifest = buildManifest(
      "2026-03-30T15:00:00Z",
      "2026-03-01T00:00:00Z",
      "2026-03-31T00:00:00Z",
      100,
      200,
    );
    expect(manifest.since).toBe("2026-03-01T00:00:00Z");
    expect(manifest.until).toBe("2026-03-31T00:00:00Z");
  });

  it("uses timestamp in file paths", () => {
    const manifest = buildManifest("2026-03-30T15:30:00Z", undefined, undefined, 100, 200);
    expect(manifest.files[0]?.path).toBe("metric_stream/2026-03-30T15:30:00Z.csv");
    expect(manifest.files[1]?.path).toBe("device_stream/2026-03-30T15:30:00Z.csv");
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
