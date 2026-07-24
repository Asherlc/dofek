import { describe, expect, it } from "vitest";
import {
  processingAggregateProgress,
  processingCurrentFailure,
  processingHeading,
  processingPollInterval,
  processingStatusMessage,
} from "./processing-status.ts";

describe("processing status presentation", () => {
  it("gives failures and delays actionable copy", () => {
    expect(processingHeading("failed")).toBe("Your data update didn’t finish");
    expect(processingStatusMessage({ status: "failed", errorMessage: "Reconnect WHOOP." })).toBe(
      "Reconnect WHOOP.",
    );
    expect(processingStatusMessage({ status: "delayed", errorMessage: null })).toContain(
      "taking longer",
    );
  });

  it.each([
    ["blocked", "Your data update didn’t finish"],
    ["delayed", "Processing is taking longer than expected"],
    ["active", "Updating your data"],
    ["partial", "Some data is ready"],
    ["waiting", "Preparing to update your data"],
    ["cancelled", "Processing was cancelled"],
    ["ready", "Data is ready"],
  ] as const)("uses the expected heading for %s", (status, heading) => {
    expect(processingHeading(status)).toBe(heading);
  });

  it.each([
    ["blocked", "Try the update again. If it still fails, reconnect the data source."],
    ["partial", "Ready sections are available while the remaining data finishes updating."],
    ["active", "Your existing data stays available while this update finishes."],
    ["waiting", "Your existing data stays available while this update finishes."],
    ["cancelled", "Start the update again when you are ready."],
    ["ready", "Everything is up to date."],
  ] as const)("uses the expected fallback message for %s", (status, message) => {
    expect(processingStatusMessage({ status, errorMessage: null })).toBe(message);
  });

  it("only displays server errors for failed or blocked states", () => {
    expect(processingStatusMessage({ status: "blocked", errorMessage: "Reconnect Garmin." })).toBe(
      "Reconnect Garmin.",
    );
    expect(processingStatusMessage({ status: "active", errorMessage: "Ignore this." })).toBe(
      "Your existing data stays available while this update finishes.",
    );
  });

  it("polls active work frequently and recoverable snapshots at a lower frequency", () => {
    expect(processingPollInterval("active")).toBe(3_000);
    expect(processingPollInterval("partial")).toBe(3_000);
    expect(processingPollInterval("waiting")).toBe(3_000);
    expect(processingPollInterval("delayed")).toBe(15_000);
    expect(processingPollInterval("ready")).toBe(15_000);
    expect(processingPollInterval("failed")).toBe(15_000);
    expect(processingPollInterval("blocked")).toBe(15_000);
    expect(processingPollInterval("cancelled")).toBe(15_000);
  });

  it("keeps aggregate progress unknown until every non-ready dataset reports progress", () => {
    expect(
      processingAggregateProgress([
        { status: "active", progressPercentage: 80 },
        { status: "waiting", progressPercentage: null },
      ]),
    ).toBeNull();
    expect(
      processingAggregateProgress([
        { status: "active", progressPercentage: 80 },
        { status: "ready", progressPercentage: null },
      ]),
    ).toBe(80);
  });

  it("selects failures only from the current operation for each dataset", () => {
    expect(
      processingCurrentFailure({
        datasets: [{ key: "activity" }, { key: "sleep" }],
        operations: [
          {
            id: "current-activity",
            datasets: ["activity"],
            timeline: [],
          },
          {
            id: "historical-activity",
            datasets: ["activity"],
            timeline: [
              {
                status: "failed",
                occurredAt: "2026-07-23T12:00:00.000Z",
                errorMessage: "Historical failure",
              },
            ],
          },
          {
            id: "current-sleep",
            datasets: ["sleep"],
            timeline: [
              {
                status: "failed",
                occurredAt: "2026-07-22T12:00:00.000Z",
                errorMessage: "Current failure",
              },
            ],
          },
        ],
      }),
    ).toBe("Current failure");
  });
});
