import { describe, expect, it, vi } from "vitest";
import { createHealthEnvelope, type HealthEnvelopeV1 } from "./health-contract.ts";
import type { HealthUploadPayload } from "./health-upload.ts";
import { persistHealthEnvelope, readPhoneHealthOutbox } from "./phone-health-outbox.ts";
import { drainPhoneHealthOutbox } from "./phone-health-sync.ts";

function createStorage() {
  let persisted: string | null = null;
  return {
    getItem: vi.fn(() => persisted),
    setItem: vi.fn((_key: string, value: string) => {
      persisted = value;
    }),
  };
}

const envelope = createHealthEnvelope({
  batchId: "watch-batch",
  source: { connectionType: "zepp" as const, installId: "install-1" },
  events: [
    {
      eventId: "event-1",
      createdAt: "2024-07-03T10:00:00.000Z",
      payload: { backgroundSamples: [{ recordedAt: "2024-07-03T10:00:00.000Z" }] },
    },
    {
      eventId: "event-2",
      createdAt: "2024-07-03T10:01:00.000Z",
      payload: {
        watchSummary: { collectedAt: 1, date: "2024-07-03", timezoneOffsetMinutes: 0 },
      },
    },
  ],
});

describe("drainPhoneHealthOutbox", () => {
  it("acknowledges accepted events and quarantines individually rejected siblings", async () => {
    const storage = createStorage();
    persistHealthEnvelope(storage, envelope);
    const post = vi.fn(async (_batch: HealthEnvelopeV1<HealthUploadPayload>) => ({
      acceptedEventIds: ["event-1"],
      rejected: [
        {
          eventId: "event-2",
          issues: [{ path: "watchSummary.collectedAt", message: "Expected timestamp" }],
        },
      ],
    }));

    await expect(drainPhoneHealthOutbox(storage, post)).resolves.toEqual({
      uploaded: 1,
      quarantined: 1,
    });
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      version: 1,
      source: envelope.source,
      events: envelope.events,
    });
    expect(readPhoneHealthOutbox(storage)).toMatchObject({
      pending: [],
      quarantine: [
        {
          eventId: "event-2",
          issues: [{ path: "watchSummary.collectedAt", message: "Expected timestamp" }],
        },
      ],
    });
  });

  it("records attempts and retains events when transport fails", async () => {
    const storage = createStorage();
    persistHealthEnvelope(storage, envelope);
    const transportError = new Error("network unavailable");

    await expect(
      drainPhoneHealthOutbox(storage, async () => {
        throw transportError;
      }),
    ).rejects.toThrow(transportError);
    expect(readPhoneHealthOutbox(storage).pending).toEqual([
      expect.objectContaining({
        eventId: "event-1",
        attempts: 1,
        lastError: "network unavailable",
      }),
      expect.objectContaining({
        eventId: "event-2",
        attempts: 1,
        lastError: "network unavailable",
      }),
    ]);
  });

  it("preserves events appended while a successful upload is in flight", async () => {
    const storage = createStorage();
    persistHealthEnvelope(storage, envelope);
    const concurrentEnvelope = createHealthEnvelope({
      batchId: "concurrent-watch-batch",
      source: envelope.source,
      events: [
        {
          eventId: "event-3",
          createdAt: "2024-07-03T10:02:00.000Z",
          payload: { backgroundSamples: [{ recordedAt: "2024-07-03T10:02:00.000Z" }] },
        },
      ],
    });

    const post = vi.fn(async (batch: HealthEnvelopeV1<HealthUploadPayload>) => {
      if (batch.events.some((event) => event.eventId === "event-1")) {
        persistHealthEnvelope(storage, concurrentEnvelope);
      }
      return { acceptedEventIds: batch.events.map((event) => event.eventId), rejected: [] };
    });

    await expect(drainPhoneHealthOutbox(storage, post)).resolves.toEqual({
      uploaded: 3,
      quarantined: 0,
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(readPhoneHealthOutbox(storage).pending).toEqual([]);
  });

  it("preserves concurrent events when an upload fails", async () => {
    const storage = createStorage();
    persistHealthEnvelope(storage, envelope);
    const concurrentEnvelope = createHealthEnvelope({
      batchId: "concurrent-watch-batch",
      source: envelope.source,
      events: [
        {
          eventId: "event-3",
          createdAt: "2024-07-03T10:02:00.000Z",
          payload: { backgroundSamples: [{ recordedAt: "2024-07-03T10:02:00.000Z" }] },
        },
      ],
    });

    await expect(
      drainPhoneHealthOutbox(storage, async () => {
        persistHealthEnvelope(storage, concurrentEnvelope);
        throw new Error("network unavailable");
      }),
    ).rejects.toThrow("network unavailable");

    expect(readPhoneHealthOutbox(storage).pending).toEqual([
      expect.objectContaining({ eventId: "event-1", attempts: 1 }),
      expect.objectContaining({ eventId: "event-2", attempts: 1 }),
      expect.objectContaining({ eventId: "event-3", attempts: 0 }),
    ]);
  });

  it("retains and marks events omitted from a successful server acknowledgement", async () => {
    const storage = createStorage();
    persistHealthEnvelope(storage, envelope);

    await expect(
      drainPhoneHealthOutbox(storage, async () => ({ acceptedEventIds: [], rejected: [] })),
    ).rejects.toThrow("Server did not acknowledge 2 health events.");
    expect(readPhoneHealthOutbox(storage).pending.every((entry) => entry.attempts === 1)).toBe(
      true,
    );
  });
});
