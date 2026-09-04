import { describe, expect, it } from "vitest";
import { createHealthEnvelope, validationIssuesFromDetails } from "./health-contract.ts";

describe("createHealthEnvelope", () => {
  it("creates the versioned envelope without changing stable identifiers", () => {
    expect(
      createHealthEnvelope({
        batchId: "batch-install-1-1720000000000",
        source: { connectionType: "zepp", installId: "install-1" },
        events: [
          {
            eventId: "install-1:background:2024-07-03T10:48:20.000Z",
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
        events: [{ eventId: "", payload: {} }],
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
