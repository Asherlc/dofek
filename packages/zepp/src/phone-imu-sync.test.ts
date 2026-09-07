import { describe, expect, it, vi } from "vitest";
import { createImuChunkEnvelope as createChunk } from "./imu-upload.ts";
import {
  assignLegacyPhoneImuOutbox,
  persistImuEnvelope,
  readPhoneImuOutbox,
} from "./phone-imu-outbox.ts";
import { drainPhoneImuOutbox, type PostImuEnvelope } from "./phone-imu-sync.ts";
import { createSettingsStorage } from "./test-helpers.ts";

function createImuChunkEnvelope(
  input: Omit<
    Parameters<typeof createChunk>[0],
    "sampleOffset" | "hasGyroscope" | "accelFreqMode" | "gyroFreqMode"
  >,
) {
  return createChunk({
    ...input,
    sampleOffset: input.samples[0]?.tMs ?? 0,
    hasGyroscope: false,
    accelFreqMode: 1,
    gyroFreqMode: 0,
  });
}

const binding = { serverUrl: "https://dofek.test", accountId: "account-1" };

function envelope(segmentId: string, tMs: number) {
  return createImuChunkEnvelope({
    destination: binding,
    connectionType: "zepp",
    installId: "install-1",
    segmentId,
    sessionStartMs: 1_720_000_000_000,
    samples: [{ tMs, sensor: "accelerometer", x: 1, y: 2, z: 3 }],
  });
}

describe("phone IMU outbox drain", () => {
  it("preserves a chunk appended while the server request is in flight", async () => {
    const storage = createSettingsStorage();
    persistImuEnvelope(storage, envelope("segment-1", 0));
    const post: PostImuEnvelope = async (batch) => {
      if (batch.events[0]?.eventId === "segment-1:0") {
        persistImuEnvelope(storage, envelope("segment-2", 0));
      }
      return {
        acceptedEventIds: batch.events.map((event) => event.eventId),
        rejected: [],
      };
    };

    await expect(drainPhoneImuOutbox(storage, binding, post)).resolves.toEqual({
      uploaded: 2,
      quarantined: 0,
    });
    expect(readPhoneImuOutbox(storage).pending).toEqual([]);
  });

  it("retains and marks a chunk after transport failure", async () => {
    const storage = createSettingsStorage();
    persistImuEnvelope(storage, envelope("segment-1", 0));

    await expect(
      drainPhoneImuOutbox(storage, binding, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(readPhoneImuOutbox(storage).pending[0]).toMatchObject({
      eventId: "segment-1:0",
      attempts: 1,
      lastError: "offline",
    });
  });

  it("updates only the bounded upload batch when a long offline queue fails", async () => {
    const storage = createSettingsStorage();
    for (let index = 0; index < 12; index += 1) {
      persistImuEnvelope(storage, envelope("segment-long", index * 100));
    }
    storage.setItem.mockClear();

    await expect(
      drainPhoneImuOutbox(storage, binding, async () => {
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

  it("publishes and retries with the immutable capture-time account", async () => {
    const storage = createSettingsStorage();
    persistImuEnvelope(storage, envelope("segment-1", 0));
    const post = vi.fn<PostImuEnvelope>(async (_envelope, connection) => {
      expect(connection).toEqual(binding);
      expect(readPhoneImuOutbox(storage).pending[0]?.payload.connection).toEqual(binding);
      throw new Error("offline");
    });
    await expect(drainPhoneImuOutbox(storage, binding, post)).rejects.toThrow("offline");

    post.mockImplementation(async (batch, connection) => {
      expect(connection).toEqual(binding);
      return { acceptedEventIds: batch.events.map((event) => event.eventId), rejected: [] };
    });
    await expect(drainPhoneImuOutbox(storage, binding, post)).resolves.toEqual({
      uploaded: 1,
      quarantined: 0,
    });
  });

  it("uploads only the current account and leaves other-account recordings retained", async () => {
    const storage = createSettingsStorage();
    persistImuEnvelope(storage, envelope("segment-1", 0));
    persistImuEnvelope(
      storage,
      createImuChunkEnvelope({
        connectionType: "zepp",
        installId: "install-1",
        destination: { serverUrl: "https://dofek.test", accountId: "account-2" },
        segmentId: "segment-2",
        sessionStartMs: 1_720_000_000_000,
        samples: [{ tMs: 0, sensor: "accelerometer", x: 1, y: 2, z: 3 }],
      }),
    );
    const post = vi.fn<PostImuEnvelope>(async (batch) => ({
      acceptedEventIds: batch.events.map((event) => event.eventId),
      rejected: [],
    }));

    const accountTwo = { serverUrl: "https://dofek.test", accountId: "account-2" };
    await drainPhoneImuOutbox(storage, accountTwo, post);

    expect(post.mock.calls.map(([, connection]) => connection.accountId)).toEqual(["account-2"]);
    expect(readPhoneImuOutbox(storage).pending.map((entry) => entry.eventId)).toEqual([
      "segment-1:0",
    ]);

    await drainPhoneImuOutbox(storage, binding, post);
    expect(readPhoneImuOutbox(storage).pending).toEqual([]);
  });

  it("retains legacy entries until the user explicitly assigns their account", async () => {
    const storage = createSettingsStorage();
    persistImuEnvelope(storage, envelope("segment-1", 0));
    for (const [key, value] of storage.persisted) {
      if (!key.includes(":pending:")) continue;
      const entry = JSON.parse(value);
      delete entry.payload.connection;
      storage.persisted.set(key, JSON.stringify(entry));
    }
    const post = vi.fn();
    await expect(drainPhoneImuOutbox(storage, binding, post)).rejects.toThrow(
      "Choose the account for retained motion recordings",
    );
    expect(post).not.toHaveBeenCalled();
    expect(readPhoneImuOutbox(storage)).toMatchObject({
      pending: [{ eventId: "segment-1:0" }],
      quarantine: [],
    });

    expect(assignLegacyPhoneImuOutbox(storage, binding)).toBe(1);
    post.mockImplementation(async (batch: Parameters<PostImuEnvelope>[0]) => ({
      acceptedEventIds: batch.events.map((event) => event.eventId),
      rejected: [],
    }));
    await expect(drainPhoneImuOutbox(storage, binding, post)).resolves.toEqual({
      uploaded: 1,
      quarantined: 0,
    });
  });

  it("surfaces legacy recovery behind an older entry for another account", async () => {
    const storage = createSettingsStorage();
    persistImuEnvelope(storage, envelope("account-one", 0));
    persistImuEnvelope(
      storage,
      createImuChunkEnvelope({
        destination: { serverUrl: "https://dofek.test", accountId: "legacy-placeholder" },
        connectionType: "zepp",
        installId: "install-1",
        segmentId: "legacy",
        sessionStartMs: 1_720_000_000_000,
        samples: [{ tMs: 0, sensor: "accelerometer", x: 1, y: 2, z: 3 }],
      }),
    );
    for (const [key, value] of storage.persisted) {
      if (!key.includes(encodeURIComponent("legacy:0"))) continue;
      const entry = JSON.parse(value);
      delete entry.payload.connection;
      storage.persisted.set(key, JSON.stringify(entry));
    }

    await expect(
      drainPhoneImuOutbox(
        storage,
        { serverUrl: "https://dofek.test", accountId: "account-2" },
        vi.fn(),
      ),
    ).rejects.toThrow("Choose the account for retained motion recordings");
  });
});
