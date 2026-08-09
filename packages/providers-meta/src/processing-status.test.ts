import { describe, expect, it } from "vitest";
import {
  processingAggregateProgress,
  processingDatasetErrorMessage,
  processingDatasetStatusLabel,
  processingFailureGroups,
  processingHeading,
  processingPollInterval,
  processingStatusMessage,
  processingTarget,
} from "./processing-status.ts";

describe("processing status presentation", () => {
  const firstOperationId = "10000000-0000-4000-8000-000000000001";
  const secondOperationId = "10000000-0000-4000-8000-000000000002";

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

  it("uses import copy for provider file imports", () => {
    const target = processingTarget({
      providerId: "apple_health",
      operationKind: "file_import",
      datasets: [{ key: "sleep", label: "Sleep", status: "active" }],
    });

    expect(target).toEqual({ action: "import", label: "Apple Health" });
    expect(processingHeading("active", target)).toBe("Importing Apple Health");
  });

  it.each([
    ["blocked", "Sleep recompute didn’t finish"],
    ["delayed", "Recomputing sleep is taking longer than expected"],
    ["waiting", "Preparing to recompute sleep"],
    ["cancelled", "Sleep recompute was cancelled"],
    ["ready", "Sleep recompute complete"],
  ] as const)("uses area-specific recomputation copy for %s", (status, heading) => {
    expect(processingHeading(status, { action: "recompute", label: "sleep" })).toBe(heading);
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

  it("formats empty, single, and three-area recomputation targets", () => {
    expect(processingTarget({ providerId: null, datasets: [] })).toEqual({
      action: "recompute",
      label: "your data",
    });
    expect(
      processingTarget({
        providerId: null,
        datasets: [{ key: "sleep", label: "Sleep", status: "ready" }],
      }),
    ).toEqual({ action: "recompute", label: "sleep" });
    expect(
      processingTarget({
        providerId: null,
        datasets: [
          { key: "sleep", label: "Sleep", status: "active" },
          { key: "recovery", label: "Recovery", status: "waiting" },
          { key: "training", label: "Training", status: "waiting" },
        ],
      }),
    ).toEqual({ action: "recompute", label: "sleep, recovery, and training" });
  });

  it("uses customer-facing copy for provider summary recomputation", () => {
    expect(
      processingTarget({
        providerId: null,
        datasets: [{ key: "providers", label: "Providers", status: "active" }],
      }),
    ).toEqual({ action: "recompute", label: "provider summaries" });
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
    expect(processingAggregateProgress([])).toBeNull();
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

  it("groups current failed datasets by operation in server dataset order", () => {
    const groups = processingFailureGroups({
      datasets: [
        {
          key: "activity",
          label: "Activities",
          status: "failed",
          lastFailedAt: "2026-07-22T14:00:00.000Z",
          lastReadyAt: "2026-07-21T10:00:00.000Z",
        },
        {
          key: "recovery",
          label: "Recovery",
          status: "blocked",
          lastFailedAt: "2026-07-22T16:00:00.000Z",
          lastReadyAt: "2026-07-21T12:00:00.000Z",
        },
        {
          key: "sleep",
          label: "Sleep",
          status: "failed",
          lastFailedAt: "2026-07-22T15:00:00.000Z",
          lastReadyAt: "2026-07-21T11:00:00.000Z",
        },
      ],
      operations: [
        {
          id: firstOperationId,
          providerId: "whoop",
          status: "failed",
          datasets: ["sleep", "activity", "recovery"],
          dismissed: false,
          errorMessage: "Reconnect WHOOP.",
        },
      ],
    });

    expect(groups).toEqual([
      {
        operationId: firstOperationId,
        providerLabel: "WHOOP (Cloud)",
        datasetLabels: ["Activities", "Recovery", "Sleep"],
        status: "failed",
        failedAt: "2026-07-22T16:00:00.000Z",
        lastReadyAt: "2026-07-21T12:00:00.000Z",
        errorMessage: "Reconnect WHOOP.",
        dismissed: false,
      },
    ]);
  });

  it("does not expose dismissed or later-ready operation groups", () => {
    expect(
      processingFailureGroups({
        datasets: [
          {
            key: "activity",
            label: "Activities",
            status: "failed",
            lastFailedAt: "2026-07-22T14:00:00.000Z",
            lastReadyAt: null,
          },
        ],
        operations: [
          {
            id: firstOperationId,
            providerId: "garmin",
            status: "failed",
            datasets: ["activity"],
            dismissed: true,
            errorMessage: "Reconnect Garmin.",
          },
        ],
      }),
    ).toEqual([]);

    expect(
      processingFailureGroups({
        datasets: [
          {
            key: "activity",
            label: "Activities",
            status: "ready",
            lastFailedAt: "2026-07-22T14:00:00.000Z",
            lastReadyAt: "2026-07-22T15:00:00.000Z",
          },
        ],
        operations: [
          {
            id: firstOperationId,
            providerId: "garmin",
            status: "failed",
            datasets: ["activity"],
            dismissed: false,
            errorMessage: "Old failure.",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("keeps separate failed operations separate", () => {
    expect(
      processingFailureGroups({
        datasets: [
          {
            key: "activity",
            label: "Activities",
            status: "failed",
            lastFailedAt: "2026-07-22T14:00:00.000Z",
            lastReadyAt: "2026-07-21T10:00:00.000Z",
          },
          {
            key: "sleep",
            label: "Sleep",
            status: "blocked",
            lastFailedAt: "2026-07-22T15:00:00.000Z",
            lastReadyAt: "2026-07-21T11:00:00.000Z",
          },
        ],
        operations: [
          {
            id: firstOperationId,
            providerId: "garmin",
            status: "failed",
            datasets: ["activity"],
            dismissed: false,
            errorMessage: "Activity failed.",
          },
          {
            id: secondOperationId,
            providerId: "whoop",
            status: "blocked",
            datasets: ["sleep"],
            dismissed: false,
            errorMessage: "Sleep blocked.",
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        operationId: firstOperationId,
        datasetLabels: ["Activities"],
        status: "failed",
        errorMessage: "Activity failed.",
      }),
      expect.objectContaining({
        operationId: secondOperationId,
        datasetLabels: ["Sleep"],
        status: "blocked",
        errorMessage: "Sleep blocked.",
      }),
    ]);
  });

  it("preserves a missing last-ready timestamp", () => {
    expect(
      processingFailureGroups({
        datasets: [
          {
            key: "providers",
            label: "Providers",
            status: "blocked",
            lastFailedAt: "2026-07-22T14:00:00.000Z",
            lastReadyAt: null,
          },
        ],
        operations: [
          {
            id: firstOperationId,
            providerId: null,
            status: "blocked",
            datasets: ["providers"],
            dismissed: false,
            errorMessage: null,
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        operationId: firstOperationId,
        providerLabel: null,
        lastReadyAt: null,
      }),
    ]);
  });

  it("uses the latest matching failed event as the dataset error", () => {
    expect(
      processingDatasetErrorMessage(
        [
          {
            datasets: ["activity"],
            timeline: [
              {
                datasetKey: "sleep",
                status: "failed",
                occurredAt: "2026-07-22T10:00:00.000Z",
                message: "Sleep failed",
                errorMessage: "Old sleep error",
              },
              {
                datasetKey: null,
                status: "failed",
                occurredAt: "2026-07-22T11:00:00.000Z",
                message: null,
                errorMessage: "Reconnect the provider.",
              },
              {
                datasetKey: "activity",
                status: "succeeded",
                occurredAt: "2026-07-22T12:00:00.000Z",
                message: "Ignore success",
                errorMessage: null,
              },
            ],
          },
        ],
        "activity",
      ),
    ).toBe("Reconnect the provider.");
  });

  it("falls back to a failed event message and ignores other datasets", () => {
    expect(
      processingDatasetErrorMessage(
        [
          {
            datasets: ["activity", "sleep"],
            timeline: [
              {
                datasetKey: "sleep",
                status: "failed",
                occurredAt: "2026-07-22T12:00:00.000Z",
                message: "Sleep failed",
                errorMessage: null,
              },
              {
                datasetKey: "activity",
                status: "failed",
                occurredAt: "2026-07-22T11:00:00.000Z",
                message: "Try the activity sync again.",
                errorMessage: null,
              },
            ],
          },
        ],
        "activity",
      ),
    ).toBe("Try the activity sync again.");
  });

  it("ignores failures from older and unrelated operations", () => {
    expect(
      processingDatasetErrorMessage(
        [
          {
            datasets: ["activity"],
            timeline: [
              {
                datasetKey: "activity",
                status: "succeeded",
                occurredAt: "2026-07-22T12:00:00.000Z",
                message: "Activity ready",
                errorMessage: null,
              },
            ],
          },
          {
            datasets: ["activity"],
            timeline: [
              {
                datasetKey: "activity",
                status: "failed",
                occurredAt: "2026-07-22T11:00:00.000Z",
                message: null,
                errorMessage: "Old activity failure",
              },
            ],
          },
        ],
        "activity",
      ),
    ).toBeNull();

    expect(
      processingDatasetErrorMessage(
        [
          {
            datasets: ["sleep"],
            timeline: [
              {
                datasetKey: null,
                status: "failed",
                occurredAt: "2026-07-22T12:00:00.000Z",
                message: null,
                errorMessage: "Sleep operation failed",
              },
            ],
          },
        ],
        "activity",
      ),
    ).toBeNull();
  });

  it.each([
    ["ready", "Ready"],
    ["waiting", "Waiting"],
    ["active", "Updating"],
    ["partial", "Finishing"],
    ["delayed", "Delayed"],
    ["blocked", "Blocked"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
  ] as const)("labels a %s dataset for display", (status, label) => {
    expect(processingDatasetStatusLabel(status)).toBe(label);
  });
});
