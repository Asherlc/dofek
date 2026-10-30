import { describe, expect, it } from "vitest";
import {
  activityDataStateLabel,
  activityDataStateSchema,
  formatActivityMetric,
  groupActivityMetrics,
} from "./activity-data-state.ts";

describe("groupActivityMetrics", () => {
  const average: import("./activity-data-state.ts").ActivityMetric = {
    label: "Avg Power",
    status: "available",
    value: "149 W",
  };
  const maximum: import("./activity-data-state.ts").ActivityMetric = {
    label: "Max Power",
    status: "available",
    value: "202 W",
  };
  it("places a maximum with its average and preserves other metrics in order", () => {
    const duration = { label: "Duration", value: "26m" };
    expect(groupActivityMetrics([duration, average, maximum])).toEqual([
      { primary: duration, secondary: null },
      { primary: average, secondary: maximum },
    ]);
  });
  it("retains a maximum on its own when the average is missing", () => {
    expect(
      groupActivityMetrics([
        { label: "Avg Power", status: "missing", reason: "Not recorded" },
        maximum,
      ]),
    ).toEqual([{ primary: maximum, secondary: null }]);
  });
  it("preserves an unavailable maximum's status and reason in its group", () => {
    const failed = { label: "Max Power", status: "failed", reason: "Recompute this activity." };
    expect(groupActivityMetrics([average, failed])).toEqual([
      { primary: average, secondary: failed },
    ]);
  });
});

describe("activityDataStateSchema", () => {
  it.each(["missing", "stale", "failed", "processing", "conflicting"] as const)(
    "requires a reason for %s values",
    (status) => {
      expect(
        activityDataStateSchema.parse({ status, reason: "Sync the source and retry." }),
      ).toEqual({ status, reason: "Sync the source and retry." });
      expect(activityDataStateSchema.safeParse({ status }).success).toBe(false);
    },
  );

  it("accepts an available value without a fallback reason", () => {
    expect(activityDataStateSchema.parse({ status: "available" })).toEqual({
      status: "available",
    });
  });

  it("rejects whitespace-only unavailable reasons", () => {
    expect(activityDataStateSchema.safeParse({ status: "missing", reason: "   " }).success).toBe(
      false,
    );
  });

  it("formats zero as an available value", () => {
    expect(
      formatActivityMetric("Distance", 0, { status: "available" }, (value) => `${value} m`),
    ).toEqual({
      status: "available",
      label: "Distance",
      value: "0 m",
    });
  });

  it.each([
    ["missing", "Distance not recorded"],
    ["stale", "Distance data is stale"],
    ["failed", "Distance processing failed"],
    ["processing", "Distance is still processing"],
    ["conflicting", "Distance sources conflict"],
  ] as const)("preserves the %s reason", (status, reason) => {
    expect(formatActivityMetric("Distance", null, { status, reason }, String)).toEqual({
      status,
      label: "Distance",
      reason,
    });
    expect(activityDataStateLabel(status)).toBe(status === "missing" ? "unavailable" : status);
  });

  it("surfaces an available-state value mismatch instead of masking it as missing", () => {
    expect(formatActivityMetric("Distance", null, { status: "available" }, String)).toEqual({
      status: "failed",
      label: "Distance",
      reason: "Distance was marked available but no value was returned.",
    });
  });

  it.each([null, undefined])("guards a missing state when the value is absent", (state) => {
    expect(formatActivityMetric("Distance", null, state, String)).toEqual({
      status: "missing",
      label: "Distance",
      reason: "Distance is unavailable.",
    });
  });

  it("preserves a value when a legacy payload has no state", () => {
    expect(formatActivityMetric("Distance", 12, undefined, (value) => `${value} m`)).toEqual({
      status: "available",
      label: "Distance",
      value: "12 m",
    });
  });
});
