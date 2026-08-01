import { describe, expect, it } from "vitest";
import {
  activityDataStateLabel,
  activityDataStateSchema,
  formatActivityMetric,
} from "./activity-data-state.ts";

describe("activityDataStateSchema", () => {
  it.each([
    "missing",
    "stale",
    "failed",
    "processing",
    "conflicting",
  ] as const)("requires a reason for %s values", (status) => {
    expect(activityDataStateSchema.parse({ status, reason: "Sync the source and retry." })).toEqual(
      { status, reason: "Sync the source and retry." },
    );
    expect(activityDataStateSchema.safeParse({ status }).success).toBe(false);
  });

  it("accepts an available value without a fallback reason", () => {
    expect(activityDataStateSchema.parse({ status: "available" })).toEqual({
      status: "available",
    });
  });

  it("formats zero as an available value", () => {
    expect(formatActivityMetric("Distance", 0, { status: "available" }, (value) => `${value} m`)).toEqual({
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
});
