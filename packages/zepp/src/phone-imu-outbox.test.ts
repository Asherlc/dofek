import { describe, expect, it, vi } from "vitest";
import { createImuChunkEnvelope } from "./imu-upload.ts";
import { persistImuEnvelope, readPhoneImuOutbox } from "./phone-imu-outbox.ts";

function createStorage() {
  let persisted: string | null = null;
  return {
    getItem: vi.fn(() => persisted),
    setItem: vi.fn((_key: string, value: string) => {
      persisted = value;
    }),
  };
}

describe("phone IMU outbox", () => {
  it("persists before acknowledging and deduplicates replayed chunks", () => {
    const storage = createStorage();
    const envelope = createImuChunkEnvelope({
      connectionType: "zepp",
      installId: "install-1",
      segmentId: "segment-1",
      sessionStartMs: 1_720_000_000_000,
      samples: [{ tMs: 0, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 }],
    });

    expect(persistImuEnvelope(storage, envelope)).toEqual({
      acceptedEventIds: ["segment-1:0:0"],
    });
    persistImuEnvelope(storage, envelope);
    expect(readPhoneImuOutbox(storage).pending).toHaveLength(1);
  });
});
