import { describe, expect, it } from "vitest";

import type { SourceLink } from "./activity-source-attribution.ts";
import {
  buildActivityListSource,
  buildActivitySourceDecision,
} from "./activity-source-decision.ts";

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

const garminLink: SourceLink = {
  providerId: "garmin",
  externalId: "7",
  subsource: null,
  label: "Garmin Connect",
  url: null,
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

  it("reports the actual source count for more than two sources", () => {
    const decision = buildActivitySourceDecision("wahoo", null, [
      wahooLink,
      stravaLink,
      garminLink,
    ]);
    expect(decision?.sourceCount).toBe(3);
    expect(decision?.primarySourceLabel).toBe("Wahoo");
  });

  it("prefers the matching source link label over the default provider label", () => {
    const customPrimary: SourceLink = {
      providerId: "apple_health",
      externalId: "hk:workout:strong",
      subsource: "Strong",
      label: "Strong App (custom)",
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
      buildActivitySourceDecision("apple_health", "Strong", [customPrimary, whoopCloudLink]),
    ).toEqual({
      sourceCount: 2,
      primarySourceLabel: "Strong App (custom)",
      explanation:
        "Strong App (custom) was selected as the primary record by source priority. Missing details may come from the other matched sources.",
    });
  });

  it("does not treat a same-provider link with a different subsource as the primary", () => {
    const whoopViaApple: SourceLink = {
      providerId: "apple_health",
      externalId: "hk:workout:whoop",
      subsource: "WHOOP",
      label: "WHOOP App (custom)",
      url: null,
      providerAbsentAt: null,
    };
    const strongViaApple: SourceLink = {
      providerId: "apple_health",
      externalId: "hk:workout:strong",
      subsource: "Strong",
      label: "Strong App (custom)",
      url: null,
      providerAbsentAt: null,
    };

    expect(
      buildActivitySourceDecision("apple_health", "Strong", [whoopViaApple, strongViaApple]),
    ).toEqual({
      sourceCount: 2,
      primarySourceLabel: "Strong App (custom)",
      explanation:
        "Strong App (custom) was selected as the primary record by source priority. Missing details may come from the other matched sources.",
    });
  });

  it("falls back to a provider label when no source link matches the primary", () => {
    expect(
      buildActivitySourceDecision("garmin", null, [wahooLink, stravaLink], (id) =>
        id === "garmin" ? { name: "Garmin Connect Custom" } : undefined,
      ),
    ).toEqual({
      sourceCount: 2,
      primarySourceLabel: "Garmin Connect Custom",
      explanation:
        "Garmin Connect Custom was selected as the primary record by source priority. Missing details may come from the other matched sources.",
    });
  });

  it("falls back to the provider source label when lookup is omitted", () => {
    expect(buildActivitySourceDecision("unknown_provider", null, [wahooLink, stravaLink])).toEqual({
      sourceCount: 2,
      primarySourceLabel: "unknown_provider",
      explanation:
        "unknown_provider was selected as the primary record by source priority. Missing details may come from the other matched sources.",
    });
  });

  it("falls back to the provider source label when lookup has no name for the primary", () => {
    expect(
      buildActivitySourceDecision(
        "unknown_provider",
        null,
        [wahooLink, stravaLink],
        () => undefined,
      ),
    ).toEqual({
      sourceCount: 2,
      primarySourceLabel: "unknown_provider",
      explanation:
        "unknown_provider was selected as the primary record by source priority. Missing details may come from the other matched sources.",
    });
  });

  it("uses the subsource-aware provider label when the primary has a subsource but no matching link", () => {
    expect(buildActivitySourceDecision("apple_health", "Strong", [wahooLink, stravaLink])).toEqual({
      sourceCount: 2,
      primarySourceLabel: "Strong (via Apple Health)",
      explanation:
        "Strong (via Apple Health) was selected as the primary record by source priority. Missing details may come from the other matched sources.",
    });
  });
});

describe("buildActivityListSource", () => {
  it("labels a single-source activity without claiming overlap", () => {
    expect(buildActivityListSource("wahoo", null, [wahooLink])).toEqual({
      primarySourceLabel: "Wahoo",
      sourceCount: 1,
      overlapSummary: null,
    });
  });

  it("summarizes only the matched source records proved by attribution", () => {
    expect(buildActivityListSource("wahoo", null, [wahooLink, stravaLink])).toEqual({
      primarySourceLabel: "Wahoo",
      sourceCount: 2,
      overlapSummary: "2 matched source records · Wahoo selected by source priority",
    });
  });

  it("uses the same primary source lookup semantics as the detail decision", () => {
    const customPrimary: SourceLink = {
      providerId: "apple_health",
      externalId: "hk:workout:strong",
      subsource: "Strong",
      label: "Strong App (custom)",
      url: null,
      providerAbsentAt: null,
    };

    expect(buildActivityListSource("apple_health", "Strong", [customPrimary, wahooLink])).toEqual({
      primarySourceLabel: "Strong App (custom)",
      sourceCount: 2,
      overlapSummary: "2 matched source records · Strong App (custom) selected by source priority",
    });
  });

  it("still attributes a canonical activity when no external source link is available", () => {
    expect(
      buildActivityListSource("garmin", null, undefined, (id) =>
        id === "garmin" ? { name: "Garmin Connect Custom" } : undefined,
      ),
    ).toEqual({
      primarySourceLabel: "Garmin Connect Custom",
      sourceCount: 1,
      overlapSummary: null,
    });
  });
});
