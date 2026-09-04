import { describe, expect, it, vi } from "vitest";
import { createImuChunkEnvelope } from "./imu-upload.ts";
import { persistImuEnvelope, readPhoneImuOutbox } from "./phone-imu-outbox.ts";
import { drainPhoneImuOutbox } from "./phone-imu-sync.ts";

function createStorage() {
  const persisted = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => persisted.get(key) ?? null),
    removeItem: vi.fn((key: string) => persisted.delete(key)),
    setItem: vi.fn((key: string, value: string) => persisted.set(key, value)),
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

  it("updates only the bounded upload batch when a long offline queue fails", async () => {
    const storage = createStorage();
    for (let index = 0; index < 12; index += 1) {
      persistImuEnvelope(storage, envelope("segment-long", index * 100));
    }
    storage.setItem.mockClear();

    await expect(
      drainPhoneImuOutbox(storage, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");

    expect(storage.setItem).toHaveBeenCalledTimes(10);
    expect(storage.setItem).not.toHaveBeenCalledWith("phone_imu_outbox", expect.any(String));
    expect(readPhoneImuOutbox(storage).pending.slice(0, 10)).toEqual(
      expect.arrayContaining([expect.objectContaining({ attempts: 1, lastError: "offline" })]),
    );
    expect(readPhoneImuOutbox(storage).pending.slice(10)).toEqual([
      expect.objectContaining({ attempts: 0 }),
      expect.objectContaining({ attempts: 0 }),
    ]);
  });
});
