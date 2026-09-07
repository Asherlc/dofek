import { describe, expect, it, vi } from "vitest";
import {
  assignLegacyPhoneImuOutbox,
  persistImuEnvelope,
  readPhoneImuOutbox,
} from "./phone-imu-outbox.ts";
import { drainPhoneImuOutbox, type PostImuEnvelope } from "./phone-imu-sync.ts";
import { createImuChunkEnvelope, createSettingsStorage } from "./test-helpers.ts";

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
  it("does nothing while disconnected when no recording is retained", async () => {
    const post = vi.fn();

    await expect(drainPhoneImuOutbox(createSettingsStorage(), null, post)).resolves.toEqual({
      uploaded: 0,
      quarantined: 0,
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("requires reconnection for a bound recording when there is no active connection", async () => {
    const storage = createSettingsStorage();
    persistImuEnvelope(storage, envelope("segment-1", 0));
    const post = vi.fn();

    await expect(drainPhoneImuOutbox(storage, null, post)).rejects.toThrow(
      "Reconnect Dofek to upload retained motion recordings",
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("returns without uploading when retained recordings belong to another account", async () => {
    const storage = createSettingsStorage();
    persistImuEnvelope(storage, envelope("segment-1", 0));
    const post = vi.fn();

    await expect(
      drainPhoneImuOutbox(
        storage,
        { serverUrl: "https://dofek.test", accountId: "account-2" },
        post,
      ),
    ).resolves.toEqual({ uploaded: 0, quarantined: 0 });
    expect(post).not.toHaveBeenCalled();
    expect(readPhoneImuOutbox(storage).pending).toHaveLength(1);
  });

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

  it("uses the first and last event IDs in a multi-event upload batch", async () => {
    const storage = createSettingsStorage();
    for (const offset of [0, 100, 200]) {
      persistImuEnvelope(storage, envelope("segment-batch", offset));
    }
    const post = vi.fn<PostImuEnvelope>(async (batch) => ({
      acceptedEventIds: batch.events.map((event) => event.eventId),
      rejected: [],
    }));

    await drainPhoneImuOutbox(storage, binding, post);

    expect(post.mock.calls[0]?.[0].batchId).toBe("phone-imu:segment-batch:0:segment-batch:200");
  });

  it("quarantines rejected batch entries and ignores foreign response IDs", async () => {
    const storage = createSettingsStorage();
    persistImuEnvelope(storage, envelope("segment-accepted", 0));
    persistImuEnvelope(storage, envelope("segment-rejected", 0));
    persistImuEnvelope(storage, {
      ...envelope("other-account-accepted", 0),
      destination: { ...binding, accountId: "account-2" },
    });
    persistImuEnvelope(storage, {
      ...envelope("other-account-rejected", 0),
      destination: { ...binding, accountId: "account-2" },
    });
    const issues = [{ path: "samples.0", message: "Invalid sample" }];

    await expect(
      drainPhoneImuOutbox(storage, binding, async () => ({
        acceptedEventIds: ["segment-accepted:0", "other-account-accepted:0", "foreign:0"],
        rejected: [
          { eventId: "other-account-rejected:0", issues },
          { eventId: "foreign-rejected:0", issues },
          { eventId: "segment-rejected:0", issues },
        ],
      })),
    ).resolves.toEqual({ uploaded: 1, quarantined: 1 });
    expect(readPhoneImuOutbox(storage)).toMatchObject({
      pending: [{ eventId: "other-account-accepted:0" }, { eventId: "other-account-rejected:0" }],
      quarantine: [{ eventId: "segment-rejected:0", issues }],
    });
  });

  it("retains and marks every entry omitted from the server response", async () => {
    const storage = createSettingsStorage();
    persistImuEnvelope(storage, envelope("segment-unresolved-a", 0));
    persistImuEnvelope(storage, envelope("segment-unresolved-b", 0));

    await expect(
      drainPhoneImuOutbox(storage, binding, async () => ({
        acceptedEventIds: [],
        rejected: [],
      })),
    ).rejects.toThrow("Server did not acknowledge 2 IMU chunks");
    expect(readPhoneImuOutbox(storage).pending).toEqual([
      expect.objectContaining({
        attempts: 1,
        lastError: "Server did not acknowledge 2 IMU chunks.",
      }),
      expect.objectContaining({
        attempts: 1,
        lastError: "Server did not acknowledge 2 IMU chunks.",
      }),
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

  it("does not rescan an older account prefix for every current-account batch", async () => {
    const storage = createSettingsStorage();
    for (let index = 0; index < 50; index += 1) {
      persistImuEnvelope(storage, {
        ...envelope(`foreign-${index}`, 0),
        destination: { ...binding, accountId: "account-2" },
      });
    }
    for (let index = 0; index < 30; index += 1) {
      persistImuEnvelope(storage, envelope(`current-${index}`, 0));
    }
    storage.getItem.mockClear();
    const post = vi.fn<PostImuEnvelope>(async (batch) => ({
      acceptedEventIds: batch.events.map((event) => event.eventId),
      rejected: [],
    }));

    await drainPhoneImuOutbox(storage, binding, post);

    expect(post).toHaveBeenCalledTimes(3);
    const foreignShardReads = storage.getItem.mock.calls.filter(([key]) =>
      key.includes(":pending:foreign-"),
    );
    expect(foreignShardReads.length).toBeLessThanOrEqual(150);
  });

  it("wraps the scan when an earlier retained entry becomes eligible during upload", async () => {
    const storage = createSettingsStorage();
    persistImuEnvelope(storage, {
      ...envelope("earlier", 0),
      destination: { ...binding, accountId: "account-2" },
    });
    persistImuEnvelope(storage, envelope("current", 0));
    let requestCount = 0;

    await expect(
      drainPhoneImuOutbox(storage, binding, async (batch) => {
        requestCount += 1;
        if (requestCount === 1) {
          const earlierKey = [...storage.persisted.keys()].find((key) =>
            key.includes(":pending:earlier"),
          );
          if (!earlierKey) throw new Error("Expected the retained earlier entry.");
          const earlier = JSON.parse(storage.persisted.get(earlierKey) ?? "{}");
          earlier.payload.connection = binding;
          storage.persisted.set(earlierKey, JSON.stringify(earlier));
        }
        return {
          acceptedEventIds: batch.events.map((event) => event.eventId),
          rejected: [],
        };
      }),
    ).resolves.toEqual({ uploaded: 2, quarantined: 0 });
    expect(requestCount).toBe(2);
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
    ).rejects.toMatchObject({
      name: "LegacyImuAccountBindingRequiredError",
      message: "Choose the account for retained motion recordings in Zepp settings.",
    });
  });
});
