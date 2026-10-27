import { describe, expect, it } from "vitest";
import { ActivityRowSchema } from "./api";

describe("ActivityRowSchema", () => {
  it("retains the primary activity type used for missing titles", () => {
    expect(
      ActivityRowSchema.parse({
        id: "activity-1",
        started_at: "2026-03-18T07:00:00Z",
        canonical_type: "walking",
        primary_canonical_type: "running",
        name: null,
      }),
    ).toMatchObject({ primary_canonical_type: "running" });
  });

  it("normalizes legacy rows without a distance state", () => {
    expect(
      ActivityRowSchema.parse({
        id: "activity-1",
        primary_canonical_type: null,
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
        primary_canonical_type: null,
        started_at: "2026-07-01T08:00:00.000Z",
        distance_meters: 0,
      }).distance_state,
    ).toEqual({ status: "available" });
  });
});
