import { describe, expect, it } from "vitest";
import { createHealthEnvelope, type HealthEnvelopeV1 } from "./health-contract.ts";
import type { HealthUploadPayload } from "./health-upload.ts";
import {
  parsePhoneHealthOutbox,
  persistHealthEnvelope,
  readPhoneHealthOutbox,
} from "./phone-health-outbox.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";
import { createSettingsStorage } from "./test-helpers.ts";

function createStorage(initial: string | null = null) {
  return createSettingsStorage(
    initial === null ? {} : { [STORAGE_KEYS.PHONE_HEALTH_OUTBOX]: initial },
  );
}

const envelope: HealthEnvelopeV1<HealthUploadPayload> = createHealthEnvelope({
  batchId: "batch-1",
  source: { connectionType: "zepp", installId: "install-1" },
  events: [
    {
      eventId: "install-1:background:1",
      createdAt: "2024-07-03T10:48:20.000Z",
      payload: { backgroundSamples: [{ recordedAt: "2024-07-03T10:48:20.000Z" }] },
    },
    {
      eventId: "install-1:activity:1",
      createdAt: "2024-07-03T10:30:00.000Z",
      payload: {
        activities: [
          {
            externalId: "activity-1",
            activityType: "other",
            startedAt: "2024-07-03T10:00:00.000Z",
            endedAt: "2024-07-03T10:30:00.000Z",
          },
        ],
      },
    },
  ],
});

describe("phone health outbox", () => {
  it("persists every received event before acknowledging it", () => {
    const storage = createStorage();

    expect(persistHealthEnvelope(storage, envelope)).toEqual({
      acceptedEventIds: envelope.events.map((event) => event.eventId),
    });
    expect(storage.setItem).toHaveBeenCalledOnce();
    expect(storage.setItem).toHaveBeenCalledWith(
      STORAGE_KEYS.PHONE_HEALTH_OUTBOX,
      expect.any(String),
    );
    expect(readPhoneHealthOutbox(storage).pending.map((entry) => entry.eventId)).toEqual(
      envelope.events.map((event) => event.eventId),
    );
    expect(readPhoneHealthOutbox(storage).pending[0]?.payload).toEqual({
      source: envelope.source,
      payload: envelope.events[0]?.payload,
    });
  });

  it("survives restart and accepts duplicate delivery idempotently", () => {
    const firstStorage = createStorage();
    persistHealthEnvelope(firstStorage, envelope);
    const persisted = firstStorage.setItem.mock.calls[0]?.[1];
    const restartedStorage = createStorage(persisted);

    persistHealthEnvelope(restartedStorage, envelope);

    expect(readPhoneHealthOutbox(restartedStorage).pending).toHaveLength(2);
  });

  it("fails before acknowledgement when durable storage fails", () => {
    const storage = createStorage();
    const storageError = new Error("settings storage full");
    storage.setItem.mockImplementation(() => {
      throw storageError;
    });

    expect(() => persistHealthEnvelope(storage, envelope)).toThrow(storageError);
  });

  it("rejects corrupt stored outbox data", () => {
    expect(() => parsePhoneHealthOutbox("not-json")).toThrow(
      "Phone health outbox is not valid JSON.",
    );
    expect(() => parsePhoneHealthOutbox('{"version":1,"pending":"invalid"}')).toThrow(
      "Phone health outbox has an invalid shape.",
    );
    expect(() =>
      parsePhoneHealthOutbox(
        JSON.stringify({
          version: 1,
          pending: [
            {
              eventId: "event-1",
              createdAt: "2024-07-03T10:48:20.000Z",
              attempts: 0,
              payload: {
                source: { connectionType: "zepp", installId: "install-1" },
                payload: { backgroundSamples: [{ recordedAt: 123 }] },
              },
            },
          ],
          quarantine: [],
        }),
      ),
    ).toThrow("Health upload payload is invalid.");
  });

  it("treats an empty stored value as corruption rather than an empty outbox", () => {
    expect(() => readPhoneHealthOutbox(createStorage(""))).toThrow(
      "Phone health outbox is not valid JSON.",
    );
  });

  it("round-trips workout-source pending and quarantine entries", () => {
    const entry = {
      eventId: "event-1",
      createdAt: "2024-07-03T10:48:20.000Z",
      attempts: 2,
      lastError: "offline",
      payload: {
        source: { connectionType: "zepp-workout", installId: "workout-install" },
        payload: { backgroundSamples: [{ recordedAt: "2024-07-03T10:48:20.000Z" }] },
      },
    };
    const issues = [{ path: "backgroundSamples.0", message: "invalid" }];

    expect(
      parsePhoneHealthOutbox(
        JSON.stringify({
          version: 1,
          pending: [entry],
          quarantine: [{ ...entry, issues }],
        }),
      ),
    ).toEqual({ pending: [entry], quarantine: [{ ...entry, issues }] });
  });

  it.each([
    ["a null root", null],
    ["an array root", []],
    ["an unknown version", { version: 2, pending: [], quarantine: [] }],
    ["a missing pending queue", { version: 1, quarantine: [] }],
    ["a missing quarantine queue", { version: 1, pending: [] }],
  ])("rejects %s", (_description, value) => {
    expect(() => parsePhoneHealthOutbox(JSON.stringify(value))).toThrow(
      "Phone health outbox has an invalid shape.",
    );
  });

  it.each([
    ["a non-record entry", null],
    ["a numeric event ID", { eventId: 1 }],
    ["a blank event ID", { eventId: " " }],
    ["a numeric creation time", { eventId: "event-1", createdAt: 1 }],
    ["a blank creation time", { eventId: "event-1", createdAt: " " }],
    ["fractional attempts", { eventId: "event-1", createdAt: "now", attempts: 0.5 }],
    ["negative attempts", { eventId: "event-1", createdAt: "now", attempts: -1 }],
    [
      "a non-string last error",
      { eventId: "event-1", createdAt: "now", attempts: 0, lastError: 1 },
    ],
  ])("rejects a pending entry with %s", (_description, entry) => {
    expect(() =>
      parsePhoneHealthOutbox(JSON.stringify({ version: 1, pending: [entry], quarantine: [] })),
    ).toThrow("Phone health outbox entry is invalid.");
  });

  it.each([
    ["a non-record source", null],
    ["an unknown connection type", { connectionType: "other", installId: "install-1" }],
    ["a non-string install ID", { connectionType: "zepp", installId: 1 }],
    ["a blank install ID", { connectionType: "zepp", installId: " " }],
  ])("rejects %s", (_description, source) => {
    const entry = {
      eventId: "event-1",
      createdAt: "2024-07-03T10:48:20.000Z",
      attempts: 0,
      payload: {
        source,
        payload: { backgroundSamples: [{ recordedAt: "2024-07-03T10:48:20.000Z" }] },
      },
    };
    expect(() =>
      parsePhoneHealthOutbox(JSON.stringify({ version: 1, pending: [entry], quarantine: [] })),
    ).toThrow("Phone health outbox source is invalid.");
  });

  it.each([
    ["a non-record quarantine entry", null],
    ["a non-array issue list", { issues: {} }],
    [
      "a malformed issue",
      {
        eventId: "event-1",
        createdAt: "2024-07-03T10:48:20.000Z",
        attempts: 0,
        payload: {
          source: { connectionType: "zepp", installId: "install-1" },
          payload: { backgroundSamples: [{ recordedAt: "2024-07-03T10:48:20.000Z" }] },
        },
        issues: [{ path: 1, message: "invalid" }],
      },
    ],
  ])("rejects %s", (_description, entry) => {
    expect(() =>
      parsePhoneHealthOutbox(JSON.stringify({ version: 1, pending: [], quarantine: [entry] })),
    ).toThrow();
  });
});
