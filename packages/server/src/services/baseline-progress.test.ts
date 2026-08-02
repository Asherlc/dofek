import { describe, expect, it } from "vitest";
import {
  BASELINE_REQUIRED_OBSERVATION_DAYS,
  baselineProcessingStatus,
  buildBaselineProgress,
} from "./baseline-progress.ts";

const input = {
  label: "Resting Heart Rate",
  value: 56,
  sampleDeviation: 2,
  processingStatus: null,
};

describe("buildBaselineProgress", () => {
  it("reports the source-data requirement when the baseline window is empty", () => {
    expect(
      buildBaselineProgress({
        ...input,
        value: null,
        observedDays: 0,
      }),
    ).toEqual({
      requiredObservationDays: BASELINE_REQUIRED_OBSERVATION_DAYS,
      observedObservationDays: 0,
      hasMeasurableVariation: false,
      blocker: "missing_source_data",
      requirement: "A current value plus at least 2 more recorded days with measurable variation.",
      summary: "No Resting Heart Rate data is available in this baseline window.",
      action: "Connect or sync a source that records resting heart rate.",
    });
  });

  it("reports collection progress for a partial baseline", () => {
    const result = buildBaselineProgress({
      ...input,
      observedDays: 1,
      sampleDeviation: null,
    });

    expect(result).toMatchObject({
      observedObservationDays: 1,
      blocker: "collecting",
      summary:
        "Resting Heart Rate has 1 of 3 required days recorded; the baseline is still collecting observations.",
      action: "Keep syncing resting heart rate data for at least 2 more days.",
    });
  });

  it("distinguishes enough identical observations from missing observations", () => {
    expect(
      buildBaselineProgress({
        ...input,
        observedDays: BASELINE_REQUIRED_OBSERVATION_DAYS,
        sampleDeviation: 0,
      }),
    ).toMatchObject({
      blocker: "needs_variation",
      hasMeasurableVariation: false,
      summary: "Resting Heart Rate has enough observations, but they have not varied yet.",
      action: "Continue recording resting heart rate data until the values vary.",
    });
  });

  it("lets processing state take precedence over an empty canonical window", () => {
    expect(
      buildBaselineProgress({
        ...input,
        value: null,
        observedDays: 0,
        processingStatus: "syncing",
      }),
    ).toMatchObject({
      blocker: "syncing",
      summary: "Resting Heart Rate baseline data is still syncing.",
      action: "Wait for the sync to finish, then check your baseline again.",
    });

    expect(
      buildBaselineProgress({
        ...input,
        value: null,
        observedDays: 0,
        processingStatus: "sync_error",
      }),
    ).toMatchObject({
      blocker: "sync_error",
      summary: "Resting Heart Rate baseline data could not sync.",
      action: "Reconnect the data source and start the sync again.",
    });
  });

  it("reports a ready baseline after varied observations", () => {
    expect(
      buildBaselineProgress({
        ...input,
        observedDays: BASELINE_REQUIRED_OBSERVATION_DAYS,
      }),
    ).toEqual({
      requiredObservationDays: BASELINE_REQUIRED_OBSERVATION_DAYS,
      observedObservationDays: BASELINE_REQUIRED_OBSERVATION_DAYS,
      hasMeasurableVariation: true,
      blocker: null,
      requirement: "A current value plus at least 2 more recorded days with measurable variation.",
      summary: "Resting Heart Rate baseline is ready.",
      action: "No action needed.",
    });
  });
});

describe("baselineProcessingStatus", () => {
  it("maps dataset processing states to user-facing baseline blockers", () => {
    const snapshot = {
      overallStatus: "ready",
      datasets: [{ key: "recovery", status: "active" }],
    };

    expect(baselineProcessingStatus(snapshot, "recovery")).toBe("syncing");
    expect(
      baselineProcessingStatus(
        { overallStatus: "failed", datasets: [{ key: "recovery", status: "failed" }] },
        "recovery",
      ),
    ).toBe("sync_error");
    expect(
      baselineProcessingStatus(
        { overallStatus: "ready", datasets: [{ key: "activity", status: "ready" }] },
        "recovery",
      ),
    ).toBeNull();
  });
});
