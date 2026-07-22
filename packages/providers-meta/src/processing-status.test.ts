import { describe, expect, it } from "vitest";
import {
  processingHeading,
  processingPollInterval,
  processingStageLabel,
  processingStatusMessage,
} from "./processing-status.ts";

describe("processing status presentation", () => {
  it("uses plain-language stage labels", () => {
    expect(processingStageLabel("ingest")).toBe("Receiving data");
    expect(processingStageLabel("canonical_commit")).toBe("Saving data");
    expect(processingStageLabel("cdc")).toBe("Preparing data");
    expect(processingStageLabel("analytics")).toBe("Updating insights");
    expect(processingStageLabel("cache_refresh")).toBe("Refreshing screens");
  });

  it("gives failures and delays actionable copy", () => {
    expect(processingHeading("failed")).toBe("Processing needs attention");
    expect(processingStatusMessage({ status: "failed", errorMessage: "Reconnect WHOOP." })).toBe(
      "Reconnect WHOOP.",
    );
    expect(processingStatusMessage({ status: "delayed", errorMessage: null })).toContain(
      "taking longer",
    );
  });

  it.each([
    ["blocked", "Processing needs attention"],
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

  it("polls adaptively and stops for terminal state", () => {
    expect(processingPollInterval("active")).toBe(3_000);
    expect(processingPollInterval("partial")).toBe(3_000);
    expect(processingPollInterval("waiting")).toBe(3_000);
    expect(processingPollInterval("delayed")).toBe(15_000);
    expect(processingPollInterval("ready")).toBe(false);
    expect(processingPollInterval("failed")).toBe(false);
  });
});
