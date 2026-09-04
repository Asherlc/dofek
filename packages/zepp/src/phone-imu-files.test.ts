import { describe, expect, it } from "vitest";
import { persistReceivedImuFile, readReceivedImuFiles } from "./phone-imu-files.ts";
import { createSettingsStorage } from "./test-helpers.ts";

describe("received IMU file registry", () => {
  it("durably retains a received binary backup and deduplicates its transfer replay", () => {
    const storage = createSettingsStorage();
    const file = {
      segmentId: "install-1:normal-imu:1720000000000",
      source: "zepp" as const,
      path: "data://inbox/normal_a.bin",
      sampleCount: 120,
      receivedAt: "2024-07-03T10:00:00.000Z",
    };

    persistReceivedImuFile(storage, file);
    persistReceivedImuFile(storage, file);

    expect(readReceivedImuFiles(storage)).toEqual([file]);
  });

  it("validates normalized metadata before persisting it", () => {
    const storage = createSettingsStorage();

    expect(() =>
      persistReceivedImuFile(storage, {
        segmentId: "segment-1",
        source: "zepp",
        path: "data://inbox/normal_a.bin",
        sampleCount: Number.NaN,
        receivedAt: "2024-07-03T10:00:00.000Z",
      }),
    ).toThrow("Received IMU file registry is invalid.");
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
