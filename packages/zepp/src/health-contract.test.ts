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
});
