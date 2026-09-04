import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeReceivedImuFile,
  parseReceivedImuFile,
  persistReceivedImuFile,
  readReceivedImuFiles,
} from "./phone-imu-files.ts";
import { createSettingsStorage } from "./test-helpers.ts";

describe("received IMU file registry", () => {
  const validFile = {
    segmentId: "install-1:normal-imu:1720000000000",
    source: "zepp",
    path: "data://inbox/normal_a.bin",
    sampleCount: 120,
    receivedAt: "2024-07-03T10:00:00.000Z",
  } satisfies Parameters<typeof persistReceivedImuFile>[1];

  it("durably retains a received binary backup and deduplicates its transfer replay", () => {
    const storage = createSettingsStorage();

    persistReceivedImuFile(storage, validFile, vi.fn());
    persistReceivedImuFile(storage, validFile, vi.fn());

    expect(readReceivedImuFiles(storage)).toEqual([validFile]);
  });

  it("keeps receipts from both sources when their segment IDs match", () => {
    const storage = createSettingsStorage();
    const workoutFile = {
      ...validFile,
      source: "zepp-workout",
      path: "data://inbox/workout_a.bin",
    } satisfies Parameters<typeof persistReceivedImuFile>[1];

    persistReceivedImuFile(storage, validFile, vi.fn());
    persistReceivedImuFile(storage, workoutFile, vi.fn());

    expect(readReceivedImuFiles(storage)).toEqual([validFile, workoutFile]);
  });

  it("normalizes both sources and strips unknown metadata", () => {
    expect(
      parseReceivedImuFile({ ...validFile, source: "zepp-workout", unknownField: true }),
    ).toEqual({ ...validFile, source: "zepp-workout" });
  });

  it.each([
    null,
    [],
    "invalid",
    { ...validFile, segmentId: 1 },
    { ...validFile, segmentId: " " },
    { ...validFile, source: "other" },
    { ...validFile, path: 1 },
    { ...validFile, path: " " },
    { ...validFile, sampleCount: "120" },
    { ...validFile, sampleCount: 1.5 },
    { ...validFile, sampleCount: -1 },
    { ...validFile, receivedAt: 1 },
    { ...validFile, receivedAt: " " },
  ])("rejects invalid received metadata %#", (file) => {
    expect(() => parseReceivedImuFile(file)).toThrow("Received IMU file registry is invalid.");
  });

  it.each([
    "null",
    "[]",
    JSON.stringify({ version: 2, files: [] }),
    JSON.stringify({ version: 1, files: {} }),
  ])("rejects invalid registry shape %#", (serialized) => {
    const storage = createSettingsStorage({ phone_imu_files: serialized });
    expect(() => readReceivedImuFiles(storage)).toThrow("Received IMU file registry is invalid.");
  });

  it("validates normalized metadata before persisting it", () => {
    const storage = createSettingsStorage();

    expect(() =>
      persistReceivedImuFile(
        storage,
        {
          ...validFile,
          sampleCount: Number.NaN,
        },
        vi.fn(),
      ),
    ).toThrow("Received IMU file registry is invalid.");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("replaces a corrupt registry when receiving the next valid file and reports corruption", () => {
    const storage = createSettingsStorage({ phone_imu_files: "not-json" });
    const reportCorruption = vi.fn();

    persistReceivedImuFile(storage, validFile, reportCorruption);

    expect(reportCorruption).toHaveBeenCalledOnce();
    expect(reportCorruption).toHaveBeenCalledWith(expect.any(Error));
    expect(readReceivedImuFiles(storage)).toEqual([validFile]);
  });

  it("removes a received file only after its matching acknowledgement", () => {
    const storage = createSettingsStorage();
    persistReceivedImuFile(storage, validFile, vi.fn());

    expect(acknowledgeReceivedImuFile(storage, validFile.segmentId, "zepp-workout")).toBe(false);
    expect(readReceivedImuFiles(storage)).toEqual([validFile]);
    expect(acknowledgeReceivedImuFile(storage, validFile.segmentId, validFile.source)).toBe(true);
    expect(readReceivedImuFiles(storage)).toEqual([]);
    expect(storage.removeItem).toHaveBeenCalledWith("phone_imu_files");
  });
});
