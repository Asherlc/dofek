import { describe, expect, it } from "vitest";
import { activitySourceUrl } from "./source-links.ts";

describe("activitySourceUrl", () => {
  it("returns Strava activity URL", () => {
    expect(activitySourceUrl("strava", "12345")).toBe("https://www.strava.com/activities/12345");
  });

  it("returns Garmin Connect activity URL", () => {
    expect(activitySourceUrl("garmin", "98765")).toBe(
      "https://connect.garmin.com/modern/activity/98765",
    );
  });

  it("returns Wahoo cloud workout URL", () => {
    expect(activitySourceUrl("wahoo", "42")).toBe("https://cloud.wahoo.com/workouts/42");
  });

  it("returns Peloton workout URL", () => {
    expect(activitySourceUrl("peloton", "abc-123")).toBe(
      "https://members.onepeloton.com/classes/cycling?modal=classDetailsModal&classId=abc-123",
    );
  });

  it("returns Polar Flow training URL", () => {
    expect(activitySourceUrl("polar", "abc-123")).toBe(
      "https://flow.polar.com/training/analysis/abc-123",
    );
  });

  it("returns Zwift activity URL", () => {
    expect(activitySourceUrl("zwift", "55555")).toBe("https://www.zwift.com/activity/55555");
  });

  it("returns Fitbit exercise URL", () => {
    expect(activitySourceUrl("fitbit", "12345678")).toBe(
      "https://www.fitbit.com/activities/exercise/12345678",
    );
  });

  it("returns Komoot tour URL", () => {
    expect(activitySourceUrl("komoot", "999")).toBe("https://www.komoot.com/tour/999");
  });

  it("returns Suunto app workout URL", () => {
    expect(activitySourceUrl("suunto", "suunto-w-123")).toBe(
      "https://www.sports-tracker.com/workout/suunto-w-123",
    );
  });

  it("returns Ride with GPS trip URL", () => {
    expect(activitySourceUrl("ride-with-gps", "7777")).toBe("https://ridewithgps.com/trips/7777");
  });

  it("returns Concept2 logbook URL", () => {
    expect(activitySourceUrl("concept2", "1234")).toBe("https://log.concept2.com/results/1234");
  });

  it("returns Cycling Analytics ride URL", () => {
    expect(activitySourceUrl("cycling-analytics", "111")).toBe(
      "https://www.cyclinganalytics.com/ride/111",
    );
  });

  it("returns Cycling Analytics ride URL for underscore variant", () => {
    expect(activitySourceUrl("cycling_analytics", "111")).toBe(
      "https://www.cyclinganalytics.com/ride/111",
    );
  });

  it("returns TrainerRoad ride URL", () => {
    expect(activitySourceUrl("trainerroad", "222")).toBe(
      "https://www.trainerroad.com/app/cycling/rides/222",
    );
  });

  it("returns Decathlon activity URL", () => {
    expect(activitySourceUrl("decathlon", "333")).toBe(
      "https://www.decathlon.com/sports-tracking/activity/333",
    );
  });

  it("returns Intervals.icu activity URL", () => {
    expect(activitySourceUrl("intervals.icu", "i444")).toBe(
      "https://intervals.icu/activities/i444",
    );
  });

  it("returns Xert activity URL", () => {
    expect(activitySourceUrl("xert", "555")).toBe("https://www.xertonline.com/activities/555");
  });

  it("returns VeloHero training URL", () => {
    expect(activitySourceUrl("velohero", "666")).toBe("https://app.velohero.com/workouts/show/666");
  });

  it("returns null for providers without activity URLs", () => {
    expect(activitySourceUrl("apple-health", "ah:workout:2024-01-01")).toBeNull();
    expect(activitySourceUrl("apple_health", "ah:workout:2024-01-01")).toBeNull();
    expect(activitySourceUrl("whoop", "12345")).toBeNull();
    expect(activitySourceUrl("oura", "12345")).toBeNull();
    expect(activitySourceUrl("withings", "12345")).toBeNull();
  });

  it("returns null for unknown providers", () => {
    expect(activitySourceUrl("unknown-provider", "123")).toBeNull();
  });

  it("returns null when externalId is null or empty", () => {
    expect(activitySourceUrl("strava", null)).toBeNull();
    expect(activitySourceUrl("strava", undefined)).toBeNull();
    expect(activitySourceUrl("strava", "")).toBeNull();
  });
});
