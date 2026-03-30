import { describe, expect, it, vi } from "vitest";
import type { SensorSampleInsert } from "./sensor-sample-writer.ts";
import { metricStreamRowToSensorSamples, writeSensorSamples } from "./sensor-sample-writer.ts";

// ── metricStreamRowToSensorSamples ──────────────────────────

describe("metricStreamRowToSensorSamples", () => {
  const base = {
    recordedAt: new Date("2026-03-30T12:00:00Z"),
    providerId: "wahoo",
    activityId: "act-1",
    sourceType: "file",
  } as const;

  it("produces one row per non-null scalar column", () => {
    const rows = metricStreamRowToSensorSamples(base, {
      heart_rate: 142,
      power: 250,
      cadence: 90,
    });

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.channel).sort()).toEqual(["cadence", "heart_rate", "power"]);
    expect(rows.find((row) => row.channel === "heart_rate")?.scalar).toBe(142);
    expect(rows.find((row) => row.channel === "power")?.scalar).toBe(250);
    expect(rows.find((row) => row.channel === "cadence")?.scalar).toBe(90);
  });

  it("skips null and undefined values", () => {
    const rows = metricStreamRowToSensorSamples(base, {
      heart_rate: 142,
      power: null,
      cadence: undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel).toBe("heart_rate");
  });

  it("skips columns that have no channel mapping", () => {
    const rows = metricStreamRowToSensorSamples(base, {
      heart_rate: 142,
      unknown_column: 99,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel).toBe("heart_rate");
  });

  it("returns empty array when all columns are null", () => {
    const rows = metricStreamRowToSensorSamples(base, {
      heart_rate: null,
      power: null,
    });

    expect(rows).toHaveLength(0);
  });

  it("preserves base fields on every row", () => {
    const rows = metricStreamRowToSensorSamples(
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        userId: "user-1",
        providerId: "strava",
        activityId: "act-2",
        sourceName: "Wahoo TICKR",
        sourceType: "file",
      },
      { heart_rate: 150 },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recordedAt: new Date("2026-03-30T12:00:00Z"),
      userId: "user-1",
      providerId: "strava",
      activityId: "act-2",
      deviceId: "Wahoo TICKR",
      sourceType: "file",
      channel: "heart_rate",
      scalar: 150,
    });
  });

  it("handles all metric_stream column names", () => {
    const allColumns: Record<string, number> = {
      heart_rate: 1,
      power: 2,
      cadence: 3,
      speed: 4,
      lat: 5,
      lng: 6,
      altitude: 7,
      temperature: 8,
      grade: 9,
      vertical_speed: 10,
      spo2: 11,
      respiratory_rate: 12,
      gps_accuracy: 13,
      accumulated_power: 14,
      stress: 15,
      left_right_balance: 16,
      vertical_oscillation: 17,
      stance_time: 18,
      stance_time_percent: 19,
      step_length: 20,
      vertical_ratio: 21,
      stance_time_balance: 22,
      ground_contact_time: 23,
      stride_length: 24,
      form_power: 25,
      leg_spring_stiff: 26,
      air_power: 27,
      left_torque_effectiveness: 28,
      right_torque_effectiveness: 29,
      left_pedal_smoothness: 30,
      right_pedal_smoothness: 31,
      combined_pedal_smoothness: 32,
      blood_glucose: 33,
      audio_exposure: 34,
      skin_temperature: 35,
      electrodermal_activity: 36,
    };

    const rows = metricStreamRowToSensorSamples(base, allColumns);
    expect(rows).toHaveLength(36);
  });
});

// ── writeSensorSamples ──────────────────────────────────────

describe("writeSensorSamples", () => {
  it("returns 0 for empty input", async () => {
    const insertBatch = vi.fn();
    const count = await writeSensorSamples(insertBatch, []);
    expect(count).toBe(0);
    expect(insertBatch).not.toHaveBeenCalled();
  });

  it("inserts rows in batches", async () => {
    const insertedBatches: SensorSampleInsert[][] = [];
    const insertBatch = vi.fn(async (batch: SensorSampleInsert[]) => {
      insertedBatches.push(batch);
    });

    const rows: SensorSampleInsert[] = Array.from({ length: 7 }, (_, index) => ({
      recordedAt: new Date(),
      providerId: "test",
      sourceType: "api",
      channel: "heart_rate",
      scalar: index,
    }));

    const count = await writeSensorSamples(insertBatch, rows, 3);

    expect(count).toBe(7);
    expect(insertedBatches).toHaveLength(3); // 3 + 3 + 1
    expect(insertedBatches[0]).toHaveLength(3);
    expect(insertedBatches[1]).toHaveLength(3);
    expect(insertedBatches[2]).toHaveLength(1);
  });
});
