import { describe, expect, it } from "vitest";
import {
  processingAggregateProgress,
  processingHeading,
  processingPollInterval,
  processingStatusMessage,
  processingTarget,
} from "./processing-status.ts";

describe("processing status presentation", () => {
  it("gives failures and delays actionable copy", () => {
    expect(processingHeading("failed")).toBe("Your data update didn’t finish");
    expect(processingStatusMessage({ status: "failed", errorMessage: "Reconnect WHOOP." })).toBe(
      "Reconnect WHOOP.",
    );
    expect(processingStatusMessage({ status: "delayed", errorMessage: null })).toContain(
      "existing data",
    );
  });

  it.each([
    ["blocked", "Your data update didn’t finish"],
    ["delayed", "Processing is taking longer than expected"],
    ["active", "Updating your data"],
    ["partial", "Finishing your data update"],
    ["waiting", "Preparing to update your data"],
    ["cancelled", "Processing was cancelled"],
    ["ready", "Data is ready"],
  ] as const)("uses the expected heading for %s", (status, heading) => {
    expect(processingHeading(status)).toBe(heading);
  });

  it.each([
    ["blocked", "Try the update again. If it still fails, reconnect the data source."],
    ["partial", null],
    ["active", null],
    ["waiting", null],
    ["cancelled", "Start the update again when you are ready."],
    ["ready", null],
  ] as const)("uses the expected fallback message for %s", (status, message) => {
    expect(processingStatusMessage({ status, errorMessage: null })).toBe(message);
  });

  it("only displays server errors for failed or blocked states", () => {
    expect(processingStatusMessage({ status: "blocked", errorMessage: "Reconnect Garmin." })).toBe(
      "Reconnect Garmin.",
    );
    expect(processingStatusMessage({ status: "active", errorMessage: "Ignore this." })).toBeNull();
  });

  it("names the provider and area when one area is updating", () => {
    const target = processingTarget({
      providerId: "garmin",
      datasets: [{ key: "activity", label: "Activities", status: "active" }],
    });

    expect(target).toEqual({ action: "sync", label: "Garmin" });
    expect(processingHeading("active", target)).toBe("Syncing Garmin");
    expect(processingHeading("partial", target)).toBe("Syncing Garmin");
  });

  it("names the provider when several areas are updating", () => {
    expect(
      processingTarget({
        providerId: "whoop",
        datasets: [
          { key: "sleep", label: "Sleep", status: "active" },
          { key: "recovery", label: "Recovery", status: "waiting" },
        ],
      }),
    ).toEqual({ action: "sync", label: "WHOOP (Cloud)" });
  });

  it("names every affected area when the update is not provider-scoped", () => {
    expect(
      processingTarget({
        providerId: null,
        datasets: [
          { key: "activity", label: "Activities", status: "ready" },
          { key: "sleep", label: "Sleep", status: "active" },
          { key: "training", label: "Training", status: "waiting" },
        ],
      }),
    ).toEqual({ action: "recompute", label: "sleep and training" });
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
});
