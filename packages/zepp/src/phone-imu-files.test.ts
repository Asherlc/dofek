import { describe, expect, it, vi } from "vitest";
import { persistReceivedImuFile, readReceivedImuFiles } from "./phone-imu-files.ts";

function createStorage() {
  let persisted: string | null = null;
  return {
    getItem: vi.fn(() => persisted),
    setItem: vi.fn((_key: string, value: string) => {
      persisted = value;
    }),
  };
}

describe("received IMU file registry", () => {
  it("durably retains a received binary backup and deduplicates its transfer replay", () => {
    const storage = createStorage();
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
});
