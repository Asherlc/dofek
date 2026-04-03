import { describe, expect, it } from "vitest";

import { Activity, type ActivityRow, type ProviderLookup } from "./activity.ts";

const mockLookup: ProviderLookup = (id: string) => {
  const providers: Record<string, { name: string; activityUrl: (externalId: string) => string }> = {
    strava: {
      name: "Strava",
      activityUrl: (externalId: string) => `https://www.strava.com/activities/${externalId}`,
    },
    wahoo: {
      name: "Wahoo",
      activityUrl: (externalId: string) => `https://cloud.wahoo.com/workouts/${externalId}`,
    },
    garmin: {
      name: "Garmin",
      activityUrl: (externalId: string) =>
        `https://connect.garmin.com/modern/activity/${externalId}`,
    },
  };
  return providers[id];
};

const fullRow: ActivityRow = {
  id: "abc-123",
  activity_type: "cycling",
  started_at: "2026-03-01T10:00:00+00:00",
  ended_at: "2026-03-01T11:30:00+00:00",
  name: "Morning Ride",
  notes: "Felt good",
  provider_id: "wahoo",
  source_providers: ["wahoo", "strava"],
  source_external_ids: [
    { providerId: "strava", externalId: "99999" },
    { providerId: "wahoo", externalId: "42" },
  ],
  avg_hr: 145,
  max_hr: 175,
  avg_power: 220,
  max_power: 450,
  avg_speed: 8.5,
  max_speed: 15.2,
  avg_cadence: 85,
  total_distance: 42000,
  elevation_gain_m: 350,
  elevation_loss_m: 340,
  sample_count: 5400,
};

describe("Activity", () => {
  it("exposes all scalar fields as getters", () => {
    const activity = new Activity(fullRow, mockLookup);

    expect(activity.id).toBe("abc-123");
    expect(activity.activityType).toBe("cycling");
    expect(activity.startedAt).toBe("2026-03-01T10:00:00+00:00");
    expect(activity.endedAt).toBe("2026-03-01T11:30:00+00:00");
    expect(activity.name).toBe("Morning Ride");
    expect(activity.notes).toBe("Felt good");
    expect(activity.providerId).toBe("wahoo");
    expect(activity.sourceProviders).toEqual(["wahoo", "strava"]);
    expect(activity.avgHr).toBe(145);
    expect(activity.maxHr).toBe(175);
    expect(activity.avgPower).toBe(220);
    expect(activity.maxPower).toBe(450);
    expect(activity.avgSpeed).toBe(8.5);
    expect(activity.maxSpeed).toBe(15.2);
    expect(activity.avgCadence).toBe(85);
    expect(activity.totalDistance).toBe(42000);
    expect(activity.elevationGain).toBe(350);
    expect(activity.elevationLoss).toBe(340);
    expect(activity.sampleCount).toBe(5400);
  });

  it("computes source links from provider lookup", () => {
    const activity = new Activity(fullRow, mockLookup);

    expect(activity.sourceLinks).toEqual([
      { providerId: "strava", label: "Strava", url: "https://www.strava.com/activities/99999" },
      { providerId: "wahoo", label: "Wahoo", url: "https://cloud.wahoo.com/workouts/42" },
    ]);
  });

  it("skips providers without activityUrl", () => {
    const row: ActivityRow = {
      ...fullRow,
      source_external_ids: [
        { providerId: "strava", externalId: "12345" },
        { providerId: "apple_health", externalId: "ah:workout:2024-01-01" },
      ],
    };
    const activity = new Activity(row, mockLookup);

    expect(activity.sourceLinks).toHaveLength(1);
    expect(activity.sourceLinks[0]?.providerId).toBe("strava");
  });

  it("returns empty source links for null source_external_ids", () => {
    const row: ActivityRow = { ...fullRow, source_external_ids: null };
    const activity = new Activity(row, mockLookup);

    expect(activity.sourceLinks).toEqual([]);
  });

  it("returns null for all nullable fields when null", () => {
    const row: ActivityRow = {
      ...fullRow,
      ended_at: null,
      name: null,
      notes: null,
      source_external_ids: null,
      avg_hr: null,
      max_hr: null,
      avg_power: null,
      max_power: null,
      avg_speed: null,
      max_speed: null,
      avg_cadence: null,
      total_distance: null,
      elevation_gain_m: null,
      elevation_loss_m: null,
      sample_count: null,
    };
    const activity = new Activity(row, mockLookup);

    expect(activity.endedAt).toBeNull();
    expect(activity.name).toBeNull();
    expect(activity.notes).toBeNull();
    expect(activity.avgHr).toBeNull();
    expect(activity.maxHr).toBeNull();
    expect(activity.avgPower).toBeNull();
    expect(activity.maxPower).toBeNull();
    expect(activity.avgSpeed).toBeNull();
    expect(activity.maxSpeed).toBeNull();
    expect(activity.avgCadence).toBeNull();
    expect(activity.totalDistance).toBeNull();
    expect(activity.elevationGain).toBeNull();
    expect(activity.elevationLoss).toBeNull();
    expect(activity.sampleCount).toBeNull();
  });

  it("defaults source_providers to empty array when null", () => {
    const row: ActivityRow = { ...fullRow, source_providers: null };
    const activity = new Activity(row, mockLookup);

    expect(activity.sourceProviders).toEqual([]);
  });

  describe("toDetail", () => {
    it("serializes to ActivityDetail shape", () => {
      const activity = new Activity(fullRow, mockLookup);
      const detail = activity.toDetail();

      expect(detail).toEqual({
        id: "abc-123",
        activityType: "cycling",
        startedAt: "2026-03-01T10:00:00+00:00",
        endedAt: "2026-03-01T11:30:00+00:00",
        name: "Morning Ride",
        notes: "Felt good",
        providerId: "wahoo",
        sourceProviders: ["wahoo", "strava"],
        sourceLinks: [
          {
            providerId: "strava",
            label: "Strava",
            url: "https://www.strava.com/activities/99999",
          },
          { providerId: "wahoo", label: "Wahoo", url: "https://cloud.wahoo.com/workouts/42" },
        ],
        avgHr: 145,
        maxHr: 175,
        avgPower: 220,
        maxPower: 450,
        avgSpeed: 8.5,
        maxSpeed: 15.2,
        avgCadence: 85,
        totalDistance: 42000,
        elevationGain: 350,
        elevationLoss: 340,
        sampleCount: 5400,
      });
    });
  });
});
