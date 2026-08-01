import { describe, expect, it } from "vitest";
import { activityDataStateSchema } from "./activity-data-state.ts";

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
});
