import { describe, expect, it } from "vitest";
import {
  acknowledgeOutboxEntries,
  appendOutboxEntry,
  createEmptyOutbox,
  getOutboxBatch,
  type OutboxEntry,
  quarantineOutboxEntry,
  recordOutboxAttempt,
} from "./durable-outbox.ts";

interface Payload {
  value: number;
}

const first: OutboxEntry<Payload> = {
  eventId: "install:health:1",
  createdAt: "2024-07-03T10:48:20.000Z",
  payload: { value: 1 },
  attempts: 0,
};

const second: OutboxEntry<Payload> = {
  eventId: "install:health:2",
  createdAt: "2024-07-03T10:49:20.000Z",
  payload: { value: 2 },
  attempts: 0,
};

describe("durable outbox", () => {
  it("appends each stable event id once in insertion order", () => {
    const once = appendOutboxEntry(createEmptyOutbox<Payload>(), first);
    const twice = appendOutboxEntry(appendOutboxEntry(once, second), {
      ...first,
      payload: { value: 999 },
    });

    expect(twice.pending).toEqual([first, second]);
    expect(once.pending).toEqual([first]);
  });

  it("returns bounded batches without mutating pending entries", () => {
    const outbox = appendOutboxEntry(
      appendOutboxEntry(createEmptyOutbox<Payload>(), first),
      second,
    );

    expect(getOutboxBatch(outbox, 1)).toEqual([first]);
    expect(outbox.pending).toEqual([first, second]);
    expect(() => getOutboxBatch(outbox, 0)).toThrow("Outbox batch size must be positive.");
  });

  it("acknowledges only explicitly accepted event ids", () => {
    const outbox = appendOutboxEntry(
      appendOutboxEntry(createEmptyOutbox<Payload>(), first),
      second,
    );

    expect(acknowledgeOutboxEntries(outbox, [first.eventId, "unknown"])).toEqual({
      pending: [second],
      quarantine: [],
    });
  });

  it("records retry attempts without changing the event payload", () => {
    const outbox = appendOutboxEntry(createEmptyOutbox<Payload>(), first);

    expect(recordOutboxAttempt(outbox, first.eventId, "phone unavailable").pending).toEqual([
      { ...first, attempts: 1, lastError: "phone unavailable" },
    ]);
  });

  it("quarantines an invalid event with its field issues", () => {
    const outbox = appendOutboxEntry(
      appendOutboxEntry(createEmptyOutbox<Payload>(), first),
      second,
    );
    const issues = [{ path: "payload.value", message: "Expected a finite number" }];

    expect(quarantineOutboxEntry(outbox, first.eventId, issues)).toEqual({
      pending: [second],
      quarantine: [{ ...first, issues }],
    });
  });

  it("leaves the outbox unchanged when an event id is unknown", () => {
    const outbox = appendOutboxEntry(createEmptyOutbox<Payload>(), first);

    expect(recordOutboxAttempt(outbox, "unknown", "error")).toBe(outbox);
    expect(quarantineOutboxEntry(outbox, "unknown", [])).toBe(outbox);
  });
});
