import { describe, expect, it } from "vitest";
import {
  createHealthEnvelope,
  parseHealthEnvelope,
  parseHealthUploadResponse,
  validationIssuesFromDetails,
} from "./health-contract.ts";

describe("createHealthEnvelope", () => {
  it("creates the versioned envelope without changing stable identifiers", () => {
    expect(
      createHealthEnvelope({
        batchId: "batch-install-1-1720000000000",
        source: { connectionType: "zepp", installId: "install-1" },
        events: [
          {
            eventId: "install-1:background:2024-07-03T10:48:20.000Z",
            createdAt: "2024-07-03T10:48:20.000Z",
            payload: { backgroundSamples: [] },
          },
        ],
      }),
    ).toEqual({
      version: 1,
      batchId: "batch-install-1-1720000000000",
      source: { connectionType: "zepp", installId: "install-1" },
      events: [
        {
          eventId: "install-1:background:2024-07-03T10:48:20.000Z",
          createdAt: "2024-07-03T10:48:20.000Z",
          payload: { backgroundSamples: [] },
        },
      ],
    });
  });

  it("rejects blank batch, install, and event identifiers", () => {
    expect(() =>
      createHealthEnvelope({
        batchId: " ",
        source: { connectionType: "zepp-workout", installId: "" },
        events: [{ eventId: "", createdAt: "", payload: {} }],
      }),
    ).toThrow("Health envelope identifiers must not be blank.");
  });

  it.each([
    ["batch ID", { batchId: " ", installId: "install-1", eventId: "event-1", createdAt: "now" }],
    ["install ID", { batchId: "batch-1", installId: " ", eventId: "event-1", createdAt: "now" }],
    ["event ID", { batchId: "batch-1", installId: "install-1", eventId: " ", createdAt: "now" }],
    [
      "creation time",
      { batchId: "batch-1", installId: "install-1", eventId: "event-1", createdAt: " " },
    ],
  ])("rejects a blank %s independently", (_description, values) => {
    expect(() =>
      createHealthEnvelope({
        batchId: values.batchId,
        source: { connectionType: "zepp", installId: values.installId },
        events: [{ eventId: values.eventId, createdAt: values.createdAt, payload: {} }],
      }),
    ).toThrow("Health envelope identifiers must not be blank.");
  });
});

describe("validationIssuesFromDetails", () => {
  it("flattens form and field errors into stable path/message pairs", () => {
    expect(
      validationIssuesFromDetails({
        formErrors: ["Envelope is invalid"],
        fieldErrors: {
          restingHeartRate: ["Expected number"],
          backgroundSamples: ["Invalid input"],
        },
      }),
    ).toEqual([
      { path: "$", message: "Envelope is invalid" },
      { path: "backgroundSamples", message: "Invalid input" },
      { path: "restingHeartRate", message: "Expected number" },
    ]);
  });

  it("ignores malformed validation detail values", () => {
    expect(
      validationIssuesFromDetails({
        formErrors: "not-an-array",
        fieldErrors: { steps: ["", 42], other: null },
      }),
    ).toEqual([]);
  });
});

describe("health transport parsing", () => {
  it("accepts a structurally valid health envelope without inspecting private payload fields", () => {
    expect(
      parseHealthEnvelope({
        version: 1,
        batchId: "batch-1",
        source: { connectionType: "zepp", installId: "install-1" },
        events: [
          {
            eventId: "event-1",
            createdAt: "2024-07-03T10:48:20.000Z",
            payload: { watchSummary: { steps: 10 } },
          },
        ],
      }),
    ).toEqual({
      version: 1,
      batchId: "batch-1",
      source: { connectionType: "zepp", installId: "install-1" },
      events: [
        {
          eventId: "event-1",
          createdAt: "2024-07-03T10:48:20.000Z",
          payload: { watchSummary: { steps: 10 } },
        },
      ],
    });
  });

  it("rejects malformed envelopes before they can be acknowledged", () => {
    expect(() =>
      parseHealthEnvelope({
        version: 1,
        batchId: "batch-1",
        source: { connectionType: "unknown", installId: "install-1" },
        events: [],
      }),
    ).toThrow("Health envelope is invalid.");
  });

  it.each([
    ["null root", null],
    ["array root", []],
    ["wrong version", { version: 2 }],
    ["numeric batch ID", { version: 1, batchId: 1 }],
    ["blank batch ID", { version: 1, batchId: " " }],
    ["missing source", { version: 1, batchId: "batch-1" }],
    [
      "unknown connection type",
      { version: 1, batchId: "batch-1", source: { connectionType: "other" } },
    ],
    [
      "numeric install ID",
      {
        version: 1,
        batchId: "batch-1",
        source: { connectionType: "zepp", installId: 1 },
      },
    ],
    [
      "blank install ID",
      {
        version: 1,
        batchId: "batch-1",
        source: { connectionType: "zepp", installId: " " },
      },
    ],
    [
      "non-array events",
      {
        version: 1,
        batchId: "batch-1",
        source: { connectionType: "zepp", installId: "install-1" },
        events: {},
      },
    ],
    [
      "empty events",
      {
        version: 1,
        batchId: "batch-1",
        source: { connectionType: "zepp", installId: "install-1" },
        events: [],
      },
    ],
  ])("rejects an envelope with %s", (_description, value) => {
    expect(() => parseHealthEnvelope(value)).toThrow("Health envelope is invalid.");
  });

  it.each([
    ["non-record event", null],
    ["numeric event ID", { eventId: 1 }],
    ["blank event ID", { eventId: " " }],
    ["numeric creation time", { eventId: "event-1", createdAt: 1 }],
    ["blank creation time", { eventId: "event-1", createdAt: " " }],
    ["non-record payload", { eventId: "event-1", createdAt: "now", payload: [] }],
  ])("rejects an envelope event with %s", (_description, event) => {
    expect(() =>
      parseHealthEnvelope({
        version: 1,
        batchId: "batch-1",
        source: { connectionType: "zepp-workout", installId: "install-1" },
        events: [event],
      }),
    ).toThrow("Health envelope is invalid.");
  });

  it("parses accepted and individually rejected event IDs", () => {
    expect(
      parseHealthUploadResponse({
        status: "ok",
        acceptedEventIds: ["event-1"],
        rejected: [
          {
            eventId: "event-2",
            issues: [{ path: "watchSummary.steps", message: "Expected number" }],
          },
        ],
      }),
    ).toEqual({
      acceptedEventIds: ["event-1"],
      rejected: [
        {
          eventId: "event-2",
          issues: [{ path: "watchSummary.steps", message: "Expected number" }],
        },
      ],
    });
  });

  it("rejects malformed upload acknowledgements", () => {
    expect(() => parseHealthUploadResponse({ status: "ok" })).toThrow(
      "Health upload response is invalid.",
    );
  });

  it.each([
    ["null root", null],
    ["array root", []],
    ["wrong status", { status: "error" }],
    ["non-array accepted IDs", { status: "ok", acceptedEventIds: {} }],
    ["numeric accepted ID", { status: "ok", acceptedEventIds: [1], rejected: [] }],
    ["blank accepted ID", { status: "ok", acceptedEventIds: [" "], rejected: [] }],
    ["non-array rejected list", { status: "ok", acceptedEventIds: [], rejected: {} }],
  ])("rejects an upload response with %s", (_description, value) => {
    expect(() => parseHealthUploadResponse(value)).toThrow("Health upload response is invalid.");
  });

  it.each([
    ["non-record rejected event", null],
    ["numeric rejected ID", { eventId: 1 }],
    ["blank rejected ID", { eventId: " " }],
    ["non-array issues", { eventId: "event-1", issues: {} }],
    ["non-record issue", { eventId: "event-1", issues: [null] }],
    ["numeric issue path", { eventId: "event-1", issues: [{ path: 1, message: "bad" }] }],
    ["numeric issue message", { eventId: "event-1", issues: [{ path: "$", message: 1 }] }],
  ])("rejects a response containing %s", (_description, rejected) => {
    expect(() =>
      parseHealthUploadResponse({ status: "ok", acceptedEventIds: [], rejected: [rejected] }),
    ).toThrow("Health upload response is invalid.");
  });
});
