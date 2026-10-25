import { describe, expect, it } from "vitest";
import type { ActivityOrigin } from "./activity-origin.ts";
import { activitySourceDetails } from "./activity-source-details.ts";

function origin(providerId: string, sourceName: string | null = null): ActivityOrigin {
  return {
    status: "resolved",
    memberActivityId: "00000000-0000-4000-8000-000000000001",
    providerId,
    sourceName,
  };
}

describe("activitySourceDetails", () => {
  it.each(["strava", "suunto"])("preserves exact device metadata reported by %s", (provider) => {
    expect(activitySourceDetails(origin(provider, "Garmin Edge 530"))).toEqual({
      recordingApp: { provider: "garmin", label: "Garmin Edge 530" },
      importedVia: {
        provider,
        label: provider === "strava" ? "Strava" : provider === "garmin" ? "Garmin" : "Suunto",
      },
    });
  });

  it("retains Garmin model labels without inventing an imported copy", () => {
    expect(activitySourceDetails(origin("garmin", "Forerunner 965"))).toEqual({
      recordingApp: { provider: "garmin", label: "Forerunner 965" },
      importedVia: null,
    });
  });

  it("preserves the exact Apple Watch name", () => {
    expect(
      activitySourceDetails(origin("apple_health", "Asher’s Apple Watch"))?.recordingApp,
    ).toEqual({ provider: "apple-watch", label: "Asher’s Apple Watch" });
  });
  it("keeps a direct WHOOP recording in one role", () => {
    expect(activitySourceDetails(origin("whoop"))).toEqual({
      recordingApp: { provider: "whoop", label: "WHOOP (Cloud)" },
      importedVia: null,
    });
  });

  it.each(["Hang Ten", "Hang Ten Training", "hang-ten", "  hang ten training  "])(
    "resolves %s through Apple Health",
    (source) => {
      expect(activitySourceDetails(origin("apple_health", source))).toEqual({
        recordingApp: { provider: "hang-ten", label: "Hang Ten" },
        importedVia: { provider: "apple_health", label: "Apple Health" },
      });
    },
  );

  it("resolves Strong through the Apple Health alias", () => {
    expect(activitySourceDetails(origin("apple-health", "Strong"))).toEqual({
      recordingApp: { provider: "strong-csv", label: "Strong" },
      importedVia: { provider: "apple_health", label: "Apple Health" },
    });
  });

  it("retains an unrecognized recording app without claiming a known brand", () => {
    expect(activitySourceDetails(origin("apple_health", "  My Workout App  "))).toEqual({
      recordingApp: { provider: "My Workout App", label: "My Workout App" },
      importedVia: { provider: "apple_health", label: "Apple Health" },
    });
  });

  it.each([null, "Apple Health", "HealthKit", "   "])(
    "does not repeat Apple Health for %s",
    (source) => {
      expect(activitySourceDetails(origin("apple_health", source))).toEqual({
        recordingApp: { provider: "apple_health", label: "Apple Health" },
        importedVia: null,
      });
    },
  );

  it("does not invent an app for unresolved origin", () => {
    expect(
      activitySourceDetails({ status: "unresolved", candidateMemberActivityIds: [] }),
    ).toBeNull();
  });
});
