import { describe, expect, it } from "vitest";
import { bannerHeading, freshnessLabel } from "./data-readiness-banner.ts";

describe("bannerHeading", () => {
  it("returns non-syncing headings from overall status", () => {
    expect(bannerHeading({ overallStatus: "stale" })).toBe("Dashboard summaries are catching up");
    expect(bannerHeading({ overallStatus: "missing" })).toBe("No data has synced yet");
    expect(bannerHeading({ overallStatus: "blocked" })).toBe("Data pipeline needs attention");
  });

  it("formats syncing headings for zero, one, two, and many providers", () => {
    expect(bannerHeading({ overallStatus: "syncing" })).toBe("Data is syncing now");
    expect(
      bannerHeading({
        overallStatus: "syncing",
        syncingProviders: [{ name: "Garmin" }],
      }),
    ).toBe("Syncing Garmin");
    expect(
      bannerHeading({
        overallStatus: "syncing",
        syncingProviders: [{ name: "Garmin" }, { name: "WHOOP" }],
      }),
    ).toBe("Syncing Garmin and WHOOP");
    expect(
      bannerHeading({
        overallStatus: "syncing",
        syncingProviders: [{ name: "Garmin" }, { name: "WHOOP" }, { name: "Strava" }],
      }),
    ).toBe("Syncing Garmin, WHOOP, and Strava");
  });

  it("returns an empty heading for healthy status", () => {
    expect(bannerHeading({ overallStatus: "healthy" })).toBe("");
  });
});

describe("freshnessLabel", () => {
  it("formats the server-generated timestamp in UTC", () => {
    expect(
      freshnessLabel({ overallStatus: "stale", generatedAt: "2026-06-30T08:00:00.000Z" }),
    ).toBe("Last checked 2026-06-30 08:00 UTC");
  });
});
