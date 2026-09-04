import { describe, expect, it } from "vitest";
import type { BackgroundHealthOutbox } from "./background-health.ts";
import { createWatchHealthBatches } from "./watch-health-batches.ts";

describe("createWatchHealthBatches", () => {
  it("preserves event IDs while converting each event to the server payload contract", () => {
    const outbox: BackgroundHealthOutbox = {
      pending: [
        {
          eventId: "install-1:summary:1",
          createdAt: "2024-07-03T10:48:20.000Z",
          payload: {
            kind: "summary",
            summary: { collectedAt: 1, date: "2024-07-03", timezoneOffsetMinutes: 0 },
          },
          attempts: 0,
        },
        {
          eventId: "install-1:sample:1",
          createdAt: "2024-07-03T10:49:20.000Z",
          payload: {
            kind: "sample",
            sample: { recordedAt: "2024-07-03T10:49:20.000Z", heartRate: 72 },
          },
          attempts: 0,
        },
      ],
      quarantine: [],
    };

    expect(createWatchHealthBatches(outbox, "install-1", 100)).toEqual([
      {
        version: 1,
        batchId: "install-1:install-1:summary:1:install-1:sample:1",
        source: { connectionType: "zepp", installId: "install-1" },
        events: [
          {
            eventId: "install-1:summary:1",
            createdAt: "2024-07-03T10:48:20.000Z",
            payload: {
              watchSummary: { collectedAt: 1, date: "2024-07-03", timezoneOffsetMinutes: 0 },
            },
          },
          {
            eventId: "install-1:sample:1",
            createdAt: "2024-07-03T10:49:20.000Z",
            payload: {
              backgroundSamples: [{ recordedAt: "2024-07-03T10:49:20.000Z", heartRate: 72 }],
            },
          },
        ],
      },
    ]);
  });

  it("starts a new batch before a second summary and honors the maximum size", () => {
    const outbox: BackgroundHealthOutbox = {
      pending: [
        {
          eventId: "summary-1",
          createdAt: "2024-07-03T10:00:00.000Z",
          payload: {
            kind: "summary",
            summary: { collectedAt: 1, date: "2024-07-03", timezoneOffsetMinutes: 0 },
          },
          attempts: 0,
        },
        {
          eventId: "sample-1",
          createdAt: "2024-07-03T10:01:00.000Z",
          payload: { kind: "sample", sample: { recordedAt: "2024-07-03T10:01:00.000Z" } },
          attempts: 0,
        },
        {
          eventId: "summary-2",
          createdAt: "2024-07-03T10:02:00.000Z",
          payload: {
            kind: "summary",
            summary: { collectedAt: 2, date: "2024-07-03", timezoneOffsetMinutes: 0 },
          },
          attempts: 0,
        },
      ],
      quarantine: [],
    };

    expect(
      createWatchHealthBatches(outbox, "install-1", 3).map((batch) =>
        batch.events.map((event) => event.eventId),
      ),
    ).toEqual([["summary-1", "sample-1"], ["summary-2"]]);
  });
});
