import { describe, expect, it } from "vitest";
import { hasProviderActivityListSyncErrors } from "./provider-activity-absence.ts";

describe("hasProviderActivityListSyncErrors", () => {
  it("returns true when an activity list fetch failed", () => {
    expect(
      hasProviderActivityListSyncErrors(
        [{ message: "workouts: rate limited" }],
        ["workouts:", "sessions:"],
      ),
    ).toBe(true);
  });

  it("returns false when only per-record insert errors exist", () => {
    expect(
      hasProviderActivityListSyncErrors(
        [{ message: "workout abc123: insert failed" }],
        ["workouts:", "sessions:"],
      ),
    ).toBe(false);
  });
});
