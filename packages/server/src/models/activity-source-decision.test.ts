import { describe, expect, it } from "vitest";

import type { SourceLink } from "./activity-source-attribution.ts";
import { buildActivitySourceDecision } from "./activity-source-decision.ts";

const wahooLink: SourceLink = {
  providerId: "wahoo",
  externalId: "42",
  subsource: null,
  label: "Wahoo",
  url: "https://example.com/wahoo/42",
  providerAbsentAt: null,
};

const stravaLink: SourceLink = {
  providerId: "strava",
  externalId: "99999",
  subsource: null,
  label: "Strava",
  url: "https://example.com/strava/99999",
  providerAbsentAt: null,
};

describe("buildActivitySourceDecision", () => {
  it("returns null when there are fewer than two source links", () => {
    expect(buildActivitySourceDecision("wahoo", null, [])).toBeNull();
    expect(buildActivitySourceDecision("wahoo", null, [wahooLink])).toBeNull();
  });

  it("explains the priority decision for multi-source activities", () => {
    expect(buildActivitySourceDecision("wahoo", null, [wahooLink, stravaLink])).toEqual({
      sourceCount: 2,
      primarySourceLabel: "Wahoo",
      explanation:
        "Wahoo was selected as the primary record by source priority. Missing details may come from the other matched sources.",
    });
  });

  it("uses the matching source link label for the primary when available", () => {
    const strongLink: SourceLink = {
      providerId: "apple_health",
      externalId: "hk:workout:strong",
      subsource: "Strong",
      label: "Strong (via Apple Health)",
      url: null,
      providerAbsentAt: null,
      memberActivityId: "strong-member",
    };
    const whoopCloudLink: SourceLink = {
      providerId: "whoop",
      externalId: "whoop-cloud",
      subsource: null,
      label: "WHOOP (Cloud)",
      url: null,
      providerAbsentAt: null,
      memberActivityId: "whoop-cloud-member",
    };

    expect(
      buildActivitySourceDecision("apple_health", "Strong", [strongLink, whoopCloudLink]),
    ).toEqual({
      sourceCount: 2,
      primarySourceLabel: "Strong (via Apple Health)",
      explanation:
        "Strong (via Apple Health) was selected as the primary record by source priority. Missing details may come from the other matched sources.",
    });
  });

  it("falls back to a provider label when no source link matches the primary", () => {
    expect(
      buildActivitySourceDecision("garmin", null, [wahooLink, stravaLink], (id) =>
        id === "garmin" ? { name: "Garmin" } : undefined,
      ),
    ).toEqual({
      sourceCount: 2,
      primarySourceLabel: "Garmin",
      explanation:
        "Garmin was selected as the primary record by source priority. Missing details may come from the other matched sources.",
    });
  });
});
