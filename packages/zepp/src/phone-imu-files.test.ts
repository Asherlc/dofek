import { describe, expect, it } from "vitest";
import {
  parseReceivedImuFile,
  persistReceivedImuFile,
  readReceivedImuFiles,
} from "./phone-imu-files.ts";
import { createSettingsStorage } from "./test-helpers.ts";

describe("received IMU file registry", () => {
  const validFile = {
    segmentId: "install-1:normal-imu:1720000000000",
    source: "zepp" as const,
    path: "data://inbox/normal_a.bin",
    sampleCount: 120,
    receivedAt: "2024-07-03T10:00:00.000Z",
  };

  it("durably retains a received binary backup and deduplicates its transfer replay", () => {
    const storage = createSettingsStorage();

    persistReceivedImuFile(storage, validFile);
    persistReceivedImuFile(storage, validFile);

    expect(readReceivedImuFiles(storage)).toEqual([validFile]);
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
      persistReceivedImuFile(storage, {
        ...validFile,
        sampleCount: Number.NaN,
      }),
    ).toThrow("Received IMU file registry is invalid.");
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
