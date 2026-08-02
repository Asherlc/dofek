import { describe, expect, it } from "vitest";
import { ActivityRowSchema } from "./api";

describe("ActivityRowSchema", () => {
  it("normalizes legacy rows without a distance state", () => {
    expect(
      ActivityRowSchema.parse({
        id: "activity-1",
        started_at: "2026-07-01T08:00:00.000Z",
        ended_at: "2026-07-01T09:00:00.000Z",
        distance_meters: null,
      }).distance_state,
    ).toEqual({
      status: "missing",
      reason: "Distance not recorded",
    });
  });

  it("preserves a legacy recorded zero as available", () => {
    expect(
      ActivityRowSchema.parse({
        id: "activity-zero",
        started_at: "2026-07-01T08:00:00.000Z",
        distance_meters: 0,
      }).distance_state,
    ).toEqual({ status: "available" });
  });
});
