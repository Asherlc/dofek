import { describe, expect, it, vi } from "vitest";
import { createImuChunkEnvelope } from "./imu-upload.ts";
import { persistImuEnvelope, readPhoneImuOutbox } from "./phone-imu-outbox.ts";
import { drainPhoneImuOutbox } from "./phone-imu-sync.ts";

function createStorage() {
  let persisted: string | null = null;
  return {
    getItem: vi.fn(() => persisted),
    setItem: vi.fn((_key: string, value: string) => {
      persisted = value;
    }),
  };
}

function envelope(segmentId: string, tMs: number) {
  return createImuChunkEnvelope({
    connectionType: "zepp",
    installId: "install-1",
    segmentId,
    sessionStartMs: 1_720_000_000_000,
    samples: [{ tMs, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 }],
  });
}

describe("phone IMU outbox drain", () => {
  it("preserves a chunk appended while the server request is in flight", async () => {
    const storage = createStorage();
    persistImuEnvelope(storage, envelope("segment-1", 0));
    const post = vi.fn(async (batch) => {
      if (batch.events[0]?.eventId === "segment-1:0:0") {
        persistImuEnvelope(storage, envelope("segment-2", 0));
      }
      return {
        acceptedEventIds: batch.events.map((event: { eventId: string }) => event.eventId),
        rejected: [],
      };
    });

    await expect(drainPhoneImuOutbox(storage, post)).resolves.toEqual({
      uploaded: 2,
      quarantined: 0,
    });
    expect(readPhoneImuOutbox(storage).pending).toEqual([]);
  });

  it("retains and marks a chunk after transport failure", async () => {
    const storage = createStorage();
    persistImuEnvelope(storage, envelope("segment-1", 0));

    await expect(
      drainPhoneImuOutbox(storage, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(readPhoneImuOutbox(storage).pending[0]).toMatchObject({
      eventId: "segment-1:0:0",
      attempts: 1,
      lastError: "offline",
    });
  });
});
