import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs before importing the module under test
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { mkdirSync, writeFileSync } from "node:fs";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { processTrainingExportJob } from "./process-training-export-job.ts";

const mockExecuteWithSchema = vi.mocked(executeWithSchema);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

function createMockJob(data: { since?: string; until?: string } = {}) {
  return {
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockDb(): Parameters<typeof processTrainingExportJob>[1] {
  // The DB is fully mocked via vi.mock("../lib/typed-sql.ts")
  // so the actual object doesn't matter — executeWithSchema is intercepted.
  return Object.create(null);
}

describe("processTrainingExportJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports metric_stream and IMU data when both have rows", async () => {
    const job = createMockJob();
    const db = createMockDb();

    // Call sequence:
    // 1. metric_stream COUNT
    // 2. metric_stream rows batch 1
    // 3. IMU COUNT
    // 4. IMU rows batch 1
    mockExecuteWithSchema
      .mockResolvedValueOnce([{ count: "1" }])
      .mockResolvedValueOnce([
        {
          recorded_at: "2026-03-30T15:00:00Z",
          user_id: "user-1",
          activity_id: null,
          provider_id: "wahoo",
          activity_type: "cycling",
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
        },
      ])
      .mockResolvedValueOnce([{ count: "1" }])
      .mockResolvedValueOnce([
        {
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
        },
      ]);

    await processTrainingExportJob(job, db);

    // Should create directories
    expect(mockMkdirSync).toHaveBeenCalled();

    // Should write CSV files and manifest
    expect(mockWriteFileSync).toHaveBeenCalledTimes(3); // metric CSV + IMU CSV + manifest

    // Should update progress
    expect(job.updateProgress).toHaveBeenCalled();

    // Manifest should be valid JSON with both files
    const manifestCall = mockWriteFileSync.mock.calls.find((call) =>
      String(call[0]).includes("manifest.json"),
    );
    expect(manifestCall).toBeDefined();
    const manifest = JSON.parse(String(manifestCall?.[1]));
    expect(manifest.files).toHaveLength(2);
    expect(manifest.totalRows).toBe(2);
  });

  it("handles zero metric_stream rows gracefully", async () => {
    const job = createMockJob();
    const db = createMockDb();

    mockExecuteWithSchema
      .mockResolvedValueOnce([{ count: "0" }]) // metric count = 0
      .mockResolvedValueOnce([{ count: "1" }]) // IMU count = 1
      .mockResolvedValueOnce([
        {
          recorded_at: "2026-03-30T15:00:00.020Z",
          user_id: "user-1",
          device_id: "Watch",
          device_type: "apple_watch",
          provider_id: "apple_health",
          x: 0.1,
          y: 0.2,
          z: 0.3,
          gyroscope_x: null,
          gyroscope_y: null,
          gyroscope_z: null,
        },
      ]);

    await processTrainingExportJob(job, db);

    const manifestCall = mockWriteFileSync.mock.calls.find((call) =>
      String(call[0]).includes("manifest.json"),
    );
    const manifest = JSON.parse(String(manifestCall?.[1]));
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].table).toBe("inertial_measurement_unit_sample");
  });

  it("handles zero IMU rows gracefully", async () => {
    const job = createMockJob();
    const db = createMockDb();

    mockExecuteWithSchema
      .mockResolvedValueOnce([{ count: "1" }])
      .mockResolvedValueOnce([
        {
          recorded_at: "2026-03-30T15:00:00Z",
          user_id: "u",
          activity_id: null,
          provider_id: "p",
          activity_type: null,
          heart_rate: 72,
          power: null,
          cadence: null,
          speed: null,
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
          source_name: null,
        },
      ])
      .mockResolvedValueOnce([{ count: "0" }]); // IMU count = 0

    await processTrainingExportJob(job, db);

    const manifestCall = mockWriteFileSync.mock.calls.find((call) =>
      String(call[0]).includes("manifest.json"),
    );
    const manifest = JSON.parse(String(manifestCall?.[1]));
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].table).toBe("metric_stream");
  });

  it("passes since and until to manifest", async () => {
    const job = createMockJob({ since: "2026-03-01T00:00:00Z", until: "2026-03-31T00:00:00Z" });
    const db = createMockDb();

    mockExecuteWithSchema
      .mockResolvedValueOnce([{ count: "0" }])
      .mockResolvedValueOnce([{ count: "0" }]);

    await processTrainingExportJob(job, db);

    const manifestCall = mockWriteFileSync.mock.calls.find((call) =>
      String(call[0]).includes("manifest.json"),
    );
    const manifest = JSON.parse(String(manifestCall?.[1]));
    expect(manifest.since).toBe("2026-03-01T00:00:00Z");
    expect(manifest.until).toBe("2026-03-31T00:00:00Z");
  });

  it("reports progress through the job", async () => {
    const job = createMockJob();
    const db = createMockDb();

    mockExecuteWithSchema
      .mockResolvedValueOnce([{ count: "0" }])
      .mockResolvedValueOnce([{ count: "0" }]);

    await processTrainingExportJob(job, db);

    // Should report start, and completion
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ percentage: 0 }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ percentage: 100 }));
  });
});
