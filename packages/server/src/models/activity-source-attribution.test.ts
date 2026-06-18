import { describe, expect, it } from "vitest";

import {
  ActivitySourceAttribution,
  type ProviderLookup,
} from "./activity-source-attribution.ts";

const mockLookup: ProviderLookup = (id: string) => {
  const providers: Record<string, { name: string; activityUrl: (externalId: string) => string }> = {
    strava: {
      name: "Strava",
      activityUrl: (externalId: string) => `https://www.strava.com/activities/${externalId}`,
    },
    garmin: {
      name: "Garmin",
      activityUrl: (externalId: string) =>
        `https://connect.garmin.com/modern/activity/${externalId}`,
    },
  };
  return providers[id];
};

describe("ActivitySourceAttribution", () => {
  it("merges active and absent providers into source links", () => {
    const attribution = ActivitySourceAttribution.fromEntries(
      [{ providerId: "garmin", externalId: "123" }],
      [
        {
          providerId: "strava",
          externalId: "99999",
          memberActivityId: "member-strava",
          providerAbsentAt: "2026-03-05T14:30:00.000Z",
        },
      ],
    );

    expect(attribution.providerIds()).toEqual(["garmin", "strava"]);
    expect(attribution.toSourceLinks(mockLookup)).toEqual([
      {
        providerId: "garmin",
        label: "Garmin",
        url: "https://connect.garmin.com/modern/activity/123",
        providerAbsentAt: null,
      },
      {
        providerId: "strava",
        label: "Strava",
        url: "https://www.strava.com/activities/99999",
        providerAbsentAt: "2026-03-05T14:30:00.000Z",
        memberActivityId: "member-strava",
      },
    ]);
  });

  it("builds a partial absence summary only when active and absent sources coexist", () => {
    const partial = ActivitySourceAttribution.fromEntries(
      [{ providerId: "garmin", externalId: "123" }],
      [
        {
          providerId: "strava",
          externalId: "99999",
          providerAbsentAt: "2026-03-05T14:30:00.000Z",
        },
      ],
    );
    const full = ActivitySourceAttribution.fromEntries(
      [],
      [
        {
          providerId: "strava",
          externalId: "99999",
          providerAbsentAt: "2026-03-05T14:30:00.000Z",
        },
      ],
    );

    expect(partial.hasPartialAbsence).toBe(true);
    expect(partial.partialAbsenceSummary(mockLookup)).toMatch(/Strava removed · Mar 5,/);
    expect(full.hasPartialAbsence).toBe(false);
    expect(full.partialAbsenceSummary(mockLookup)).toBeNull();
  });

  it("parses ClickHouse absent source maps", () => {
    const attribution = ActivitySourceAttribution.fromClickHouseAbsentMaps([
      {
        providerId: "strava",
        externalId: "99999",
        memberActivityId: "member-strava",
        providerAbsentAt: "2026-03-05T14:30:00.000Z",
      },
    ]);

    expect(attribution.providerIds()).toEqual(["strava"]);
    expect(attribution.toSourceLinks(mockLookup)[0]?.providerAbsentAt).toBe(
      "2026-03-05T14:30:00.000Z",
    );
  });

  it("builds a tombstone summary for fully hidden activities", () => {
    const attribution = ActivitySourceAttribution.fromEntries([], []);

    expect(
      attribution.tombstoneSummary(null, "strava", "2026-03-05T14:30:00.000Z"),
    ).toMatch(/Removed from Strava · Mar 5,/);
  });
});
