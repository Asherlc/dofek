import { describe, expect, it } from "vitest";

import { Activity, type ActivityRow, type ProviderLookup } from "./activity.ts";

const mockLookup: ProviderLookup = (id: string) => {
  const providers: Record<string, { name: string; activityUrl?: (externalId: string) => string }> =
    {
      apple_health: {
        name: "Apple Health",
      },
      strava: {
        name: "Strava",
        activityUrl: (externalId: string) => `https://www.strava.com/activities/${externalId}`,
      },
      wahoo: {
        name: "Wahoo",
        activityUrl: (externalId: string) =>
          `https://systm.wahoofitness.com/history/activity-details/${externalId}`,
      },
      whoop: {
        name: "WHOOP (Cloud)",
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
  timezone: null,
  start_utc_offset_minutes: null,
  end_utc_offset_minutes: null,
  local_time_source: "unknown",
  name: "Morning Ride",
  notes: "Felt good",
  provider_id: "wahoo",
  subsource: null,
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
  provider_absent_at: null,
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
    expect(activity.subsource).toBeNull();
    expect(activity.sourceProviders).toEqual(["strava", "wahoo"]);
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
      {
        providerId: "strava",
        externalId: "99999",
        subsource: null,
        label: "Strava",
        url: "https://www.strava.com/activities/99999",
        providerAbsentAt: null,
      },
      {
        providerId: "wahoo",
        externalId: "42",
        subsource: null,
        label: "Wahoo",
        url: "https://systm.wahoofitness.com/history/activity-details/42",
        providerAbsentAt: null,
      },
    ]);
  });

  it("includes absent providers in source links and source providers", () => {
    const row: ActivityRow = {
      ...fullRow,
      source_providers: ["garmin"],
      source_external_ids: [{ providerId: "garmin", externalId: "123" }],
      absent_source_external_ids: [
        {
          providerId: "strava",
          externalId: "99999",
          memberActivityId: "member-strava",
          providerAbsentAt: "2026-03-05T14:30:00.000Z",
        },
      ],
    };
    const activity = new Activity(row, mockLookup);

    expect(activity.sourceProviders).toEqual(["garmin", "strava"]);
    expect(activity.sourceLinks).toEqual([
      {
        providerId: "garmin",
        externalId: "123",
        subsource: null,
        label: "Garmin",
        url: "https://connect.garmin.com/modern/activity/123",
        providerAbsentAt: null,
      },
      {
        providerId: "strava",
        externalId: "99999",
        subsource: null,
        label: "Strava",
        url: "https://www.strava.com/activities/99999",
        providerAbsentAt: "2026-03-05T14:30:00.000Z",
        memberActivityId: "member-strava",
      },
    ]);
  });

  it("labels providers without activityUrl", () => {
    const row: ActivityRow = {
      ...fullRow,
      source_external_ids: [
        { providerId: "strava", externalId: "12345" },
        { providerId: "apple_health", externalId: "ah:workout:2024-01-01" },
      ],
    };
    const activity = new Activity(row, mockLookup);

    expect(activity.sourceLinks).toEqual([
      {
        providerId: "apple_health",
        externalId: "ah:workout:2024-01-01",
        subsource: null,
        label: "Apple Health",
        url: null,
        providerAbsentAt: null,
      },
      {
        providerId: "strava",
        externalId: "12345",
        subsource: null,
        label: "Strava",
        url: "https://www.strava.com/activities/12345",
        providerAbsentAt: null,
      },
    ]);
  });

  it("labels multiple Apple Health upstream apps in one deduped activity", () => {
    const row: ActivityRow = {
      ...fullRow,
      provider_id: "whoop",
      subsource: "WHOOP",
      source_providers: ["apple_health", "whoop"],
      source_external_ids: [
        {
          providerId: "apple_health",
          externalId: "hk:workout:strong",
          memberActivityId: "strong-member",
          subsource: "Strong",
        },
        {
          providerId: "apple_health",
          externalId: "hk:workout:whoop",
          memberActivityId: "whoop-apple-member",
          subsource: "WHOOP",
        },
        {
          providerId: "whoop",
          externalId: "whoop-cloud",
          memberActivityId: "whoop-cloud-member",
        },
      ],
    };
    const activity = new Activity(row, mockLookup);

    expect(activity.sourceLinks).toEqual([
      {
        providerId: "apple_health",
        externalId: "hk:workout:strong",
        subsource: "Strong",
        label: "Strong (via Apple Health)",
        url: null,
        providerAbsentAt: null,
        memberActivityId: "strong-member",
      },
      {
        providerId: "apple_health",
        externalId: "hk:workout:whoop",
        subsource: "WHOOP",
        label: "WHOOP (via Apple Health)",
        url: null,
        providerAbsentAt: null,
        memberActivityId: "whoop-apple-member",
      },
      {
        providerId: "whoop",
        externalId: "whoop-cloud",
        subsource: null,
        label: "WHOOP (Cloud)",
        url: null,
        providerAbsentAt: null,
        memberActivityId: "whoop-cloud-member",
      },
    ]);
  });

  it("keeps source providers when source_external_ids is null", () => {
    const row: ActivityRow = { ...fullRow, source_external_ids: null };
    const activity = new Activity(row, mockLookup);

    expect(activity.sourceLinks).toEqual([]);
    expect(activity.sourceProviders).toEqual(["strava", "wahoo"]);
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

  it("derives source providers from source links when source_providers is null", () => {
    const row: ActivityRow = { ...fullRow, source_providers: null };
    const activity = new Activity(row, mockLookup);

    expect(activity.sourceProviders).toEqual(["strava", "wahoo"]);
  });

  it("exposes the subsource when present", () => {
    const row: ActivityRow = { ...fullRow, provider_id: "apple_health", subsource: "Strong" };
    const activity = new Activity(row, mockLookup);

    expect(activity.subsource).toBe("Strong");
  });

  it("serializes provider tombstone metadata in toDetail", () => {
    const activity = new Activity(
      {
        ...fullRow,
        provider_absent_at: "2026-03-05T14:30:00.000Z",
      },
      mockLookup,
    );

    expect(activity.toDetail().providerAbsentAt).toBe("2026-03-05T14:30:00.000Z");
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
        localTimeContext: {
          timezone: null,
          startUtcOffsetMinutes: null,
          endUtcOffsetMinutes: null,
          source: "unknown",
        },
        name: "Morning Ride",
        notes: "Felt good",
        providerId: "wahoo",
        subsource: null,
        sourceProviders: ["strava", "wahoo"],
        sourceLinks: [
          {
            providerId: "strava",
            externalId: "99999",
            subsource: null,
            label: "Strava",
            url: "https://www.strava.com/activities/99999",
            providerAbsentAt: null,
          },
          {
            providerId: "wahoo",
            externalId: "42",
            subsource: null,
            label: "Wahoo",
            url: "https://systm.wahoofitness.com/history/activity-details/42",
            providerAbsentAt: null,
          },
        ],
        avgHr: 145,
        avgHrState: { status: "available" },
        maxHr: 175,
        maxHrState: { status: "available" },
        avgPower: 220,
        avgPowerState: { status: "available" },
        maxPower: 450,
        maxPowerState: { status: "available" },
        avgSpeed: 8.5,
        avgSpeedState: { status: "available" },
        maxSpeed: 15.2,
        maxSpeedState: { status: "available" },
        avgCadence: 85,
        avgCadenceState: { status: "available" },
        totalDistance: 42000,
        totalDistanceState: { status: "available" },
        elevationGain: 350,
        elevationGainState: { status: "available" },
        elevationLoss: 340,
        elevationLossState: { status: "available" },
        sampleCount: 5400,
        sampleCountState: { status: "available" },
        providerAbsentAt: null,
        sourceDecision: {
          sourceCount: 2,
          primarySourceLabel: "Wahoo",
          explanation:
            "Wahoo was selected as the primary record by source priority. Missing details may come from the other matched sources.",
        },
      });
    });

    it("omits sourceDecision when there is only one source link", () => {
      const activity = new Activity(
        {
          ...fullRow,
          source_providers: ["wahoo"],
          source_external_ids: [{ providerId: "wahoo", externalId: "42" }],
        },
        mockLookup,
      );

      expect(activity.toDetail().sourceDecision).toBeNull();
    });
  });
});
