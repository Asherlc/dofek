import { describe, expect, it } from "vitest";
import { activityOriginSchema } from "./activity-origin.ts";

describe("activityOriginSchema", () => {
  it("accepts the actual available primary record", () => {
    const origin = {
      status: "resolved",
      memberActivityId: "00000000-0000-4000-8000-000000000001",
      providerId: "apple_health",
      sourceName: "Strava",
    };
    expect(activityOriginSchema.parse(origin)).toEqual(origin);
  });

  it("does not invent a provider for unresolved attribution", () => {
    const origin = {
      status: "unresolved",
      candidateMemberActivityIds: ["00000000-0000-4000-8000-000000000001"],
    };
    expect(activityOriginSchema.parse(origin)).toEqual(origin);
  });

  it("rejects a resolved primary without a member or provider", () => {
    expect(activityOriginSchema.safeParse({ status: "resolved", sourceName: null }).success).toBe(
      false,
    );
  });
});
