import { describe, expect, it } from "vitest";
import {
  bannerHeading,
  DATA_READINESS_ERROR_MESSAGE,
  dataReadinessMessage,
  freshnessLabel,
} from "./data-readiness-banner.ts";

describe("bannerHeading", () => {
  it("returns non-syncing headings from overall status", () => {
    expect(bannerHeading({ overallStatus: "stale" })).toBe("Dashboard summaries are catching up");
    expect(bannerHeading({ overallStatus: "missing" })).toBe("No data has synced yet");
    expect(bannerHeading({ overallStatus: "blocked" })).toBe(
      "Some data is temporarily unavailable",
    );
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

  it("returns empty string when generatedAt is missing", () => {
    expect(freshnessLabel({ overallStatus: "stale" })).toBe("");
  });

  it("returns empty string when generatedAt is an invalid date", () => {
    expect(freshnessLabel({ overallStatus: "stale", generatedAt: "not-a-date" })).toBe("");
  });
});

describe("dataReadinessMessage", () => {
  it("describes readiness without exposing implementation details", () => {
    expect(dataReadinessMessage({ label: "Activities", status: "healthy" })).toBe(
      "Activities summaries are current.",
    );
    expect(dataReadinessMessage({ label: "Activities", status: "syncing" })).toBe(
      "Activities data is syncing now.",
    );
    expect(dataReadinessMessage({ label: "Activities", status: "stale" })).toBe(
      "Activities data is synced, but dashboard summaries are still catching up.",
    );
    expect(dataReadinessMessage({ label: "Activities", status: "missing" })).toBe(
      "No activities data has been synced yet.",
    );
    expect(dataReadinessMessage({ label: "Activities", status: "blocked" })).toBe(
      "Activities data is still being prepared. Please check back soon.",
    );
    expect(DATA_READINESS_ERROR_MESSAGE).toBe(
      "We couldn't check your data status. Please try again.",
    );
  });
});
