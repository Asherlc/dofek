import { describe, expect, it } from "vitest";
import {
  buildTimeFilter,
  type ImuRow,
  imuCsvHeader,
  imuRowToCsv,
  type MetricStreamRow,
  metricStreamCsvHeader,
  metricStreamRowToCsv,
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
