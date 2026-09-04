import { describe, expect, it, vi } from "vitest";
import type { BackgroundHealthOutbox } from "./background-health.ts";
import { appendOutboxEntry } from "./durable-outbox.ts";
import { deliverWatchHealthOutbox } from "./watch-health-sync.ts";

function sampleOutbox(): BackgroundHealthOutbox {
  return {
    pending: [
      {
        eventId: "event-1",
        createdAt: "2024-07-03T10:00:00.000Z",
        payload: { kind: "sample", sample: { recordedAt: "2024-07-03T10:00:00.000Z" } },
        attempts: 0,
      },
    ],
    quarantine: [],
  };
}

describe("deliverWatchHealthOutbox", () => {
  it("removes only events durably acknowledged by the phone", async () => {
    let stored = sampleOutbox();
    const write = vi.fn((outbox: BackgroundHealthOutbox) => {
      stored = outbox;
    });
    const request = vi.fn(async () => ({
      status: "ok",
      acceptedEventIds: ["event-1"],
      rejected: [],
    }));

    await deliverWatchHealthOutbox({
      installId: "install-1",
      initialOutbox: stored,
      request,
      readLatest: () => stored,
      write,
    });

    expect(request).toHaveBeenCalledOnce();
    expect(stored.pending).toEqual([]);
  });

  it("preserves events appended while an upload is in flight", async () => {
    let stored = sampleOutbox();
    const request = vi.fn(async () => {
      stored = appendOutboxEntry(stored, {
        eventId: "event-2",
        createdAt: "2024-07-03T10:01:00.000Z",
        payload: { kind: "sample", sample: { recordedAt: "2024-07-03T10:01:00.000Z" } },
        attempts: 0,
      });
      return { status: "ok", acceptedEventIds: ["event-1"], rejected: [] };
    });

    await deliverWatchHealthOutbox({
      installId: "install-1",
      initialOutbox: stored,
      request,
      readLatest: () => stored,
      write: (outbox) => {
        stored = outbox;
      },
    });

    expect(stored.pending.map((entry) => entry.eventId)).toEqual(["event-2"]);
  });

  it("retains events when the phone response does not acknowledge them", async () => {
    let stored = sampleOutbox();

    await deliverWatchHealthOutbox({
      installId: "install-1",
      initialOutbox: stored,
      request: async () => ({ status: "ok", acceptedEventIds: [], rejected: [] }),
      readLatest: () => stored,
      write: (outbox) => {
        stored = outbox;
      },
    });

    expect(stored.pending.map((entry) => entry.eventId)).toEqual(["event-1"]);
  });
});
