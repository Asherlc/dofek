import { describe, expect, it } from "vitest";
import { activityOriginFromColumns } from "./activity-origin.ts";

describe("activity origin projection", () => {
  const identifier = "00000000-0000-4000-8000-000000000001";
  it("uses the available record's provider rather than its upstream source name", () => {
    expect(
      activityOriginFromColumns({
        primary_activity_id: identifier,
        primary_provider_id: "strava",
        primary_source_name: "Garmin Edge 530",
        origin_candidate_member_ids: [identifier],
      }),
    ).toEqual({
      status: "resolved",
      memberActivityId: identifier,
      providerId: "strava",
      sourceName: "Garmin Edge 530",
    });
  });
  it("does not claim a legacy field representative is proven origin before refresh", () => {
    expect(
      activityOriginFromColumns({
        primary_activity_id: identifier,
        primary_provider_id: null,
        primary_source_name: null,
        origin_candidate_member_ids: [identifier],
      }),
    ).toEqual({ status: "unresolved", candidateMemberActivityIds: [identifier] });
  });
});
