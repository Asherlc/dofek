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
});
