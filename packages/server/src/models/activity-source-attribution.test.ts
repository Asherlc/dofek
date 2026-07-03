import { describe, expect, it } from "vitest";
import { ActivitySourceAttribution, type ProviderLookup } from "./activity-source-attribution.ts";

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

  it("keeps an active source link when the same provider also has an absent entry", () => {
    const attribution = ActivitySourceAttribution.fromEntries(
      [{ providerId: "strava", externalId: "active-123" }],
      [
        {
          providerId: "strava",
          externalId: "removed-999",
          memberActivityId: "member-strava",
          providerAbsentAt: "2026-03-05T14:30:00.000Z",
        },
      ],
    );

    expect(attribution.toSourceLinks(mockLookup)).toEqual([
      {
        providerId: "strava",
        label: "Strava",
        url: "https://www.strava.com/activities/active-123",
        providerAbsentAt: null,
      },
    ]);
  });

  it("exposes partial absent sources for client-side formatting", () => {
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

    expect(partial.partialAbsentSources()).toEqual([
      {
        providerId: "strava",
        providerAbsentAt: "2026-03-05T14:30:00.000Z",
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

    expect(attribution.tombstoneSummary(null, "strava", "2026-03-05T14:30:00.000Z")).toMatch(
      /Removed from Strava · Mar 5,/,
    );
    expect(attribution.tombstoneSummary(null, "strava", null)).toBeNull();
    expect(ActivitySourceAttribution.hiddenActivityTombstoneSummary("strava", null)).toBeNull();
    expect(
      ActivitySourceAttribution.hiddenActivityTombstoneSummary(
        "strava",
        "2026-03-05T14:30:00.000Z",
      ),
    ).toMatch(/Removed from Strava · Mar 5,/);
  });

  it("parses ClickHouse active and absent source maps together", () => {
    const attribution = ActivitySourceAttribution.fromClickHouseRow(
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

    expect(attribution.hasPartialAbsence).toBe(true);
    expect(attribution.hasFullAbsence).toBe(false);
    expect(attribution.providerIds()).toEqual(["garmin", "strava"]);
    expect(attribution.partialAbsenceSummary(mockLookup)).toMatch(/Strava removed · Mar 5,/);
  });

  it("treats absent-only ClickHouse rows as fully absent", () => {
    const attribution = ActivitySourceAttribution.fromClickHouseRow(null, [
      { providerId: "strava", externalId: "99999", providerAbsentAt: "2026-03-05T14:30:00.000Z" },
    ]);

    expect(attribution.hasFullAbsence).toBe(true);
    expect(attribution.hasPartialAbsence).toBe(false);
    expect(attribution.partialAbsenceSummary(mockLookup)).toBeNull();
  });

  it("ignores ClickHouse source maps without provider ids or external ids", () => {
    const attribution = ActivitySourceAttribution.fromClickHouseRow(
      [
        { providerId: "", externalId: "123" },
        { providerId: "garmin", externalId: "" },
      ],
      [{ providerId: "strava", externalId: null }],
    );

    expect(attribution.providerIds()).toEqual([]);
    expect(attribution.toSourceLinks(mockLookup)).toEqual([]);
  });

  it("sorts provider ids and source links deterministically", () => {
    const attribution = ActivitySourceAttribution.fromEntries(
      [
        { providerId: "strava", externalId: "2" },
        { providerId: "garmin", externalId: "1" },
      ],
      [],
    );

    expect(attribution.providerIds()).toEqual(["garmin", "strava"]);
    expect(attribution.toSourceLinks(mockLookup).map((link) => link.providerId)).toEqual([
      "garmin",
      "strava",
    ]);
  });

  it("falls back to provider ids when lookup has no display name", () => {
    const attribution = ActivitySourceAttribution.fromEntries(
      [{ providerId: "garmin", externalId: "123" }],
      [
        {
          providerId: "unknown_provider",
          externalId: "99999",
          providerAbsentAt: "2026-03-05T14:30:00.000Z",
        },
      ],
    );

    expect(attribution.partialAbsenceSummary(mockLookup)).toMatch(
      /unknown_provider removed · Mar 5,/,
    );
    expect(attribution.toSourceLinks(mockLookup)).toEqual([
      {
        providerId: "garmin",
        label: "Garmin",
        url: "https://connect.garmin.com/modern/activity/123",
        providerAbsentAt: null,
      },
      {
        providerId: "unknown_provider",
        label: "unknown_provider",
        url: null,
        providerAbsentAt: "2026-03-05T14:30:00.000Z",
      },
    ]);
  });

  it("omits absent source urls when the provider has no activity url", () => {
    const attribution = ActivitySourceAttribution.fromEntries(
      [],
      [{ providerId: "apple_health", externalId: "ah:workout:1" }],
    );

    expect(attribution.toSourceLinks(mockLookup)).toEqual([
      {
        providerId: "apple_health",
        label: "Apple Health",
        url: null,
        providerAbsentAt: null,
      },
    ]);
  });
});
