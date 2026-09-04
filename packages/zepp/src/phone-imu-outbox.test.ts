import { describe, expect, it } from "vitest";
import { createImuChunkEnvelope } from "./imu-upload.ts";
import {
  acknowledgePhoneImuOutboxEntries,
  persistImuEnvelope,
  quarantinePhoneImuOutboxEntry,
  readPhoneImuOutbox,
  readPhoneImuPendingBatch,
  recordPhoneImuOutboxAttempts,
} from "./phone-imu-outbox.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";
import { createSettingsStorage } from "./test-helpers.ts";

describe("phone IMU outbox", () => {
  it("returns an empty outbox when no index has been persisted", () => {
    expect(readPhoneImuOutbox(createSettingsStorage())).toEqual({ pending: [], quarantine: [] });
  });

  it("persists before acknowledging and deduplicates replayed chunks", () => {
    const storage = createSettingsStorage();
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
    const storage = createSettingsStorage();
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
    const storage = createSettingsStorage();
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

  it("bounds the sharded scan used to assemble a same-source upload batch", () => {
    const storage = createSettingsStorage();
    for (let index = 0; index <= 100; index += 1) {
      persistImuEnvelope(
        storage,
        createImuChunkEnvelope({
          connectionType: "zepp",
          installId: index === 0 || index === 100 ? "target" : `other-${index}`,
          segmentId: `segment-${index}`,
          sessionStartMs: 1_720_000_000_000,
          samples: [{ tMs: index, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 }],
        }),
      );
    }
    storage.getItem.mockClear();

    expect(readPhoneImuPendingBatch(storage, 2)).toHaveLength(1);
    expect(storage.getItem).toHaveBeenCalledTimes(101);
  });

  it("selects only same-source entries up to the requested batch limit", () => {
    const storage = createSettingsStorage();
    for (const [segmentId, installId] of [
      ["segment-a", "target"],
      ["segment-b", "other"],
      ["segment-c", "target"],
    ] satisfies [string, string][]) {
      persistImuEnvelope(
        storage,
        createImuChunkEnvelope({
          connectionType: "zepp",
          installId,
          segmentId,
          sessionStartMs: 1_720_000_000_000,
          samples: [{ tMs: 0, ax: 1, ay: 2, az: 3, gx: 0, gy: 0, gz: 0 }],
        }),
      );
    }

    expect(readPhoneImuPendingBatch(storage, 2).map((entry) => entry.eventId)).toEqual([
      "segment-a:0:0",
      "segment-c:0:0",
    ]);
  });

  it("records attempts only for pending entries", () => {
    const storage = createSettingsStorage();
    const envelope = createImuChunkEnvelope({
      connectionType: "zepp",
      installId: "install-1",
      segmentId: "segment-attempt",
      sessionStartMs: 1_720_000_000_000,
      samples: [{ tMs: 0, ax: 1, ay: 2, az: 3, gx: 0, gy: 0, gz: 0 }],
    });
    persistImuEnvelope(storage, envelope);

    recordPhoneImuOutboxAttempts(storage, ["missing", "segment-attempt:0:0"], "offline");

    expect(readPhoneImuOutbox(storage).pending[0]).toMatchObject({
      attempts: 1,
      lastError: "offline",
    });
  });

  it("acknowledges pending entries and removes their sharded records", () => {
    const storage = createSettingsStorage();
    const envelope = createImuChunkEnvelope({
      connectionType: "zepp",
      installId: "install-1",
      segmentId: "segment-ack",
      sessionStartMs: 1_720_000_000_000,
      samples: [{ tMs: 0, ax: 1, ay: 2, az: 3, gx: 0, gy: 0, gz: 0 }],
    });
    persistImuEnvelope(storage, envelope);

    expect(acknowledgePhoneImuOutboxEntries(storage, ["missing"])).toBe(0);
    expect(acknowledgePhoneImuOutboxEntries(storage, ["segment-ack:0:0"])).toBe(1);
    expect(readPhoneImuOutbox(storage)).toEqual({ pending: [], quarantine: [] });
    expect(storage.removeItem).toHaveBeenCalledWith(
      `${STORAGE_KEYS.PHONE_IMU_OUTBOX}:pending:segment-ack%3A0%3A0`,
    );
  });

  it("moves rejected entries into quarantine exactly once", () => {
    const storage = createSettingsStorage();
    persistImuEnvelope(
      storage,
      createImuChunkEnvelope({
        connectionType: "zepp-workout",
        installId: "install-1",
        segmentId: "segment-rejected",
        sessionStartMs: 1_720_000_000_000,
        samples: [{ tMs: 0, ax: 1, ay: 2, az: 3, gx: 0, gy: 0, gz: 0 }],
      }),
    );
    const issues = [{ path: "samples.0.ax", message: "Expected finite number" }];

    expect(quarantinePhoneImuOutboxEntry(storage, "missing", issues)).toBe(false);
    expect(quarantinePhoneImuOutboxEntry(storage, "segment-rejected:0:0", issues)).toBe(true);
    expect(quarantinePhoneImuOutboxEntry(storage, "segment-rejected:0:0", issues)).toBe(false);
    expect(readPhoneImuOutbox(storage)).toMatchObject({
      pending: [],
      quarantine: [{ eventId: "segment-rejected:0:0", issues }],
    });
  });

  it.each([
    ["not JSON", "{"],
    ["an array index", "[]"],
    ["an unknown version", '{"version":3,"pending":[],"quarantine":[]}'],
    ["a non-array pending index", '{"version":2,"pending":{},"quarantine":[]}'],
    ["a blank pending identifier", '{"version":2,"pending":[" "],"quarantine":[]}'],
    ["a non-string quarantine identifier", '{"version":2,"pending":[],"quarantine":[1]}'],
  ])("rejects %s", (_description, serialized) => {
    const storage = createSettingsStorage({ [STORAGE_KEYS.PHONE_IMU_OUTBOX]: serialized });
    expect(() => readPhoneImuOutbox(storage)).toThrow();
  });

  it("rejects an index whose sharded entry is missing", () => {
    const storage = createSettingsStorage({
      [STORAGE_KEYS.PHONE_IMU_OUTBOX]: JSON.stringify({
        version: 2,
        pending: ["missing"],
        quarantine: [],
      }),
    });

    expect(() => readPhoneImuOutbox(storage)).toThrow("Phone IMU pending entry is missing.");
  });

  it.each([
    ["non-record", null],
    ["non-string event ID", { eventId: 1 }],
    ["non-string creation time", { eventId: "event-1", createdAt: 1 }],
    ["fractional attempts", { eventId: "event-1", createdAt: "now", attempts: 0.5 }],
    ["negative attempts", { eventId: "event-1", createdAt: "now", attempts: -1 }],
    ["missing payload", { eventId: "event-1", createdAt: "now", attempts: 0 }],
  ])("rejects a sharded entry with %s", (_description, entry) => {
    const eventId = "event-1";
    const storage = createSettingsStorage({
      [STORAGE_KEYS.PHONE_IMU_OUTBOX]: JSON.stringify({
        version: 2,
        pending: [eventId],
        quarantine: [],
      }),
      [`${STORAGE_KEYS.PHONE_IMU_OUTBOX}:pending:${eventId}`]: JSON.stringify(entry),
    });

    expect(() => readPhoneImuOutbox(storage)).toThrow("Phone IMU outbox is invalid.");
  });

  it("rejects malformed legacy queues and quarantine issues", () => {
    for (const serialized of [
      JSON.stringify({ version: 1, pending: {}, quarantine: [] }),
      JSON.stringify({ version: 1, pending: [], quarantine: [null] }),
      JSON.stringify({
        version: 1,
        pending: [],
        quarantine: [{ issues: [{ path: 1, message: "invalid" }] }],
      }),
    ]) {
      const storage = createSettingsStorage({ [STORAGE_KEYS.PHONE_IMU_OUTBOX]: serialized });
      expect(() => readPhoneImuOutbox(storage)).toThrow("Phone IMU outbox is invalid.");
    }
  });

  it("adopts a valid orphaned shard without overwriting it", () => {
    const storage = createSettingsStorage();
    const envelope = createImuChunkEnvelope({
      connectionType: "zepp",
      installId: "install-1",
      segmentId: "segment-orphan",
      sessionStartMs: 1_720_000_000_000,
      samples: [{ tMs: 0, ax: 1, ay: 2, az: 3, gx: 0, gy: 0, gz: 0 }],
    });
    persistImuEnvelope(storage, envelope);
    storage.removeItem(STORAGE_KEYS.PHONE_IMU_OUTBOX);
    storage.setItem.mockClear();

    persistImuEnvelope(storage, envelope);

    expect(storage.setItem).toHaveBeenCalledOnce();
    expect(readPhoneImuOutbox(storage).pending).toHaveLength(1);
  });
});
