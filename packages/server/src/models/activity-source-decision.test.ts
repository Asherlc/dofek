import type { ActivityOrigin } from "@dofek/providers/activity-origin";
import { describe, expect, it } from "vitest";
import type { SourceLink } from "./activity-source-attribution.ts";
import {
  buildActivityListSource,
  buildActivitySourceDecision,
} from "./activity-source-decision.ts";

const origin: ActivityOrigin = {
  status: "resolved",
  memberActivityId: "00000000-0000-4000-8000-000000000001",
  providerId: "garmin",
  sourceName: "Garmin Edge 530",
};
const links: SourceLink[] = ["garmin", "strava"].map((providerId) => ({
  providerId,
  externalId: "external",
  subsource: null,
  label: providerId,
  url: null,
  providerAbsentAt: null,
}));
describe("provenance-based source attribution", () => {
  it("explains the actual closest available record independently of field providers", () => {
    expect(buildActivitySourceDecision(origin, links)).toEqual({
      origin,
      sourceCount: 2,
      primarySourceLabel: "Garmin",
      explanation:
        "Garmin is the closest available record to the original recording. Individual details may come from other matched sources.",
    });
  });
  it("leaves primary attribution unresolved instead of using source priority", () => {
    const unresolved: ActivityOrigin = {
      status: "unresolved",
      candidateMemberActivityIds: [origin.memberActivityId],
    };
    expect(buildActivityListSource(unresolved, links)).toMatchObject({
      origin: unresolved,
      sourceCount: 2,
      primarySourceLabel: null,
      overlapSummary: "2 matched source records",
      tree: { primary: null, otherSources: [{ providerId: "garmin" }, { providerId: "strava" }] },
    });
    expect(buildActivitySourceDecision(unresolved, links)?.explanation).toBe(
      "The available source information does not establish which record is closest to the original recording.",
    );
  });
  it("labels an Apple Health copy with its actual provider, not an unavailable source app", () => {
    expect(
      buildActivityListSource(
        { ...origin, providerId: "apple_health", sourceName: "Garmin" },
        undefined,
      ),
    ).toMatchObject({
      origin: { ...origin, providerId: "apple_health", sourceName: "Garmin" },
      sourceCount: 1,
      primarySourceLabel: "Apple Health",
      overlapSummary: null,
      tree: { primary: null, otherSources: [] },
    });
  });
  it("has no multi-source explanation for one source", () => {
    expect(buildActivitySourceDecision(origin, links.slice(0, 1))).toBeNull();
  });
  it("uses the actual provider display name supplied by the provider registry", () => {
    expect(
      buildActivityListSource(origin, links, () => ({ name: "Garmin Connect" })).primarySourceLabel,
    ).toBe("Garmin Connect");
  });
});
