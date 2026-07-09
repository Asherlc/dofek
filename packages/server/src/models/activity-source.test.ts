import { describe, expect, it } from "vitest";
import { parseClickHouseActivitySourceMaps } from "./activity-source.ts";

describe("ActivitySource", () => {
  it("parses typed ClickHouse source maps with source identity fields", () => {
    expect(
      parseClickHouseActivitySourceMaps([
        {
          providerId: "apple_health",
          externalId: "hk:workout:strong",
          memberActivityId: "strong-member",
          providerAbsentAt: null,
          subsource: "Strong",
        },
      ]),
    ).toEqual([
      {
        providerId: "apple_health",
        externalId: "hk:workout:strong",
        memberActivityId: "strong-member",
        providerAbsentAt: null,
        subsource: "Strong",
      },
    ]);
  });

  it("drops malformed source maps instead of exposing incomplete source entries", () => {
    expect(
      parseClickHouseActivitySourceMaps([
        { providerId: "", externalId: "activity-1" },
        { providerId: "garmin", externalId: "" },
        { providerId: null, externalId: "activity-2" },
        { providerId: "whoop", externalId: null },
        { externalId: "activity-3" },
        { providerId: "strava" },
      ]),
    ).toEqual([]);
  });
});
