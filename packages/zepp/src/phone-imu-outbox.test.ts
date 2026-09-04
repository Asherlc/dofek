import { describe, expect, it, vi } from "vitest";
import { createImuChunkEnvelope } from "./imu-upload.ts";
import { persistImuEnvelope, readPhoneImuOutbox } from "./phone-imu-outbox.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";

function createStorage() {
  const persisted = new Map<string, string>();
  return {
    persisted,
    getItem: vi.fn((key: string) => persisted.get(key) ?? null),
    removeItem: vi.fn((key: string) => persisted.delete(key)),
    setItem: vi.fn((key: string, value: string) => persisted.set(key, value)),
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

  it("stores high-rate chunk payloads independently from the compact queue index", () => {
    const storage = createStorage();
    for (const tMs of [0, 100, 200]) {
      persistImuEnvelope(
        storage,
        createImuChunkEnvelope({
          connectionType: "zepp",
          installId: "install-1",
          segmentId: "segment-1",
          sessionStartMs: 1_720_000_000_000,
          samples: [{ tMs, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 }],
        }),
      );
    }

    const index = storage.persisted.get("phone_imu_outbox") ?? "";
    expect(index).not.toContain('"samples"');
    expect(
      [...storage.persisted.keys()].filter((key) => key.startsWith("phone_imu_outbox:pending:")),
    ).toHaveLength(3);
    expect(readPhoneImuOutbox(storage).pending).toHaveLength(3);
  });

  it("migrates the existing monolithic queue without losing pending chunks", () => {
    const storage = createStorage();
    const envelope = createImuChunkEnvelope({
      connectionType: "zepp",
      installId: "install-1",
      segmentId: "segment-legacy",
      sessionStartMs: 1_720_000_000_000,
      samples: [{ tMs: 0, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 }],
    });
    persistImuEnvelope(storage, envelope);
    const [entry] = readPhoneImuOutbox(storage).pending;
    if (!entry) throw new Error("Expected a pending legacy fixture entry.");
    storage.persisted.clear();
    storage.persisted.set(
      STORAGE_KEYS.PHONE_IMU_OUTBOX,
      JSON.stringify({ version: 1, pending: [entry], quarantine: [] }),
    );

    expect(readPhoneImuOutbox(storage).pending).toEqual([entry]);
    expect(storage.persisted.get(STORAGE_KEYS.PHONE_IMU_OUTBOX)).not.toContain('"samples"');
    expect(
      [...storage.persisted.keys()].filter((key) =>
        key.startsWith(`${STORAGE_KEYS.PHONE_IMU_OUTBOX}:pending:`),
      ),
    ).toHaveLength(1);
  });
});
