import { describe, expect, it, vi } from "vitest";
import {
  buildActivitySourceSummary,
  buildEquivalenceEvidence,
  buildMovingDuration,
  buildRouteContext,
  buildSampleSourceSummary,
  cyclingEffortRequest,
  hasObservedCyclingSensorData,
  type SourceRawPerformanceEvidence,
} from "./performance-comparison-context.ts";

const ACTIVITY_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_ID = "00000000-0000-4000-8000-000000000011";

function source(
  provider: string,
  raw: Record<string, unknown>,
  sourceActivityId = SOURCE_ID,
): SourceRawPerformanceEvidence {
  return {
    provider,
    providerType: "cycling",
    sourceActivityName: "Morning ride",
    raw,
    sourceActivityId,
  };
}

describe("cyclingEffortRequest", () => {
  const activity = {
    activity_id: ACTIVITY_ID,
    member_activity_ids: [ACTIVITY_ID],
    started_at: "2026-01-01T12:00:00.000Z",
    ended_at: "2026-01-01T12:30:00.000Z",
    local_date: "2026-01-01",
    source_providers: ["strava"],
    source_raw_evidence: [],
  };

  it("derives elapsed seconds from valid activity timestamps", () => {
    expect(cyclingEffortRequest(activity)).toMatchObject({ durationSeconds: 1800 });
  });

  it("rejects a missing end timestamp before parsing timestamps", () => {
    const parse = vi.spyOn(Date, "parse").mockImplementation(() => {
      throw new Error("timestamp parsing should not run");
    });
    try {
      expect(() => cyclingEffortRequest({ ...activity, ended_at: null })).toThrow(
        `Cycling activity ${ACTIVITY_ID} requires a valid elapsed duration`,
      );
    } finally {
      parse.mockRestore();
    }
  });

  it.each([
    ["a non-finite timestamp", { started_at: "not-a-timestamp" }],
    ["a negative duration", { ended_at: "2026-01-01T11:59:59.000Z" }],
  ])("rejects %s", (_case, timestamps) => {
    expect(() => cyclingEffortRequest({ ...activity, ...timestamps })).toThrow(
      `Cycling activity ${ACTIVITY_ID} requires a valid elapsed duration`,
    );
  });

  it("accepts a zero-second elapsed duration", () => {
    expect(cyclingEffortRequest({ ...activity, ended_at: activity.started_at })).toMatchObject({
      durationSeconds: 0,
    });
  });
});

describe("buildMovingDuration", () => {
  it("returns a provider-reported duration with source evidence", () => {
    expect(buildMovingDuration([source("strava", { moving_time: 1750 })])).toEqual({
      seconds: 1750,
      status: "available",
      evidence: [
        {
          provider: "strava",
          source_activity_id: SOURCE_ID,
          raw_field: "moving_time",
          seconds: 1750,
          value_kind: "provider_reported",
        },
      ],
      evidence_count: 1,
      evidence_truncated: false,
    });
  });

  it("does not choose between conflicting provider durations", () => {
    expect(
      buildMovingDuration([
        source("strava", { moving_time: 1750 }),
        source("ride-with-gps", { moving_time: 1800 }, "00000000-0000-4000-8000-000000000012"),
      ]),
    ).toMatchObject({ seconds: null, status: "conflicting", evidence_count: 2 });
  });
});

describe("hasObservedCyclingSensorData", () => {
  const missing = {
    sample_count: null,
    power_sample_count: null,
    heart_rate_sample_count: null,
    average_power: null,
    normalized_power: null,
    average_heart_rate: null,
    max_heart_rate: null,
    average_cadence: null,
    distance_meters: null,
    elevation_gain_meters: null,
    average_temperature_c: 18,
  };

  it("does not count an all-null cycling summary or unrelated temperature as sensor coverage", () => {
    expect(hasObservedCyclingSensorData("cycling", missing)).toBe(false);
  });

  it("does not count zero samples or non-cycling activities as observed sensor coverage", () => {
    expect(hasObservedCyclingSensorData("cycling", { ...missing, sample_count: 0 })).toBe(false);
    expect(hasObservedCyclingSensorData("running", { ...missing, sample_count: 1 })).toBe(false);
  });

  it("counts a positive relevant sample count", () => {
    expect(hasObservedCyclingSensorData("cycling", { ...missing, power_sample_count: 1 })).toBe(
      true,
    );
  });
});

describe("buildEquivalenceEvidence", () => {
  it("returns an empty evidence summary for exact identity without source evidence", () => {
    expect(
      buildEquivalenceEvidence(
        { kind: "provider_workout", provider: "wahoo", value: "workout-template-1" },
        {
          activityId: ACTIVITY_ID,
          activityName: null,
          sourceRawEvidence: [],
          climbingRows: [],
          strengthRows: [],
        },
      ),
    ).toEqual({ items: [], count: 0, truncated: false });
  });

  it("returns only exact provider-scoped cycling route name and type evidence", () => {
    const result = buildEquivalenceEvidence(
      {
        kind: "cycling_route",
        provider: "strava",
        activityName: "Morning ride",
        providerType: "Outdoor Ride",
      },
      {
        activityId: ACTIVITY_ID,
        activityName: "Morning ride",
        sourceRawEvidence: [
          { ...source("strava", {}), providerType: " outdoor   ride " },
          { ...source("ride-with-gps", {}), providerType: "Outdoor Ride" },
        ],
        climbingRows: [],
        strengthRows: [],
      },
    );

    expect(result).toEqual({
      items: [
        {
          evidence_type: "cycling_route_name_provider_type",
          provider: "strava",
          value: "Morning ride",
          field: "fitness.activity.name + fitness.activity.provider_type",
          provider_type: " outdoor   ride ",
          source_activity_id: SOURCE_ID,
          source_record_id: null,
        },
      ],
      count: 1,
      truncated: false,
    });
  });

  it("matches a standardized test by normalized provider-scoped name and provider type", () => {
    const result = buildEquivalenceEvidence(
      {
        kind: "standardized_test",
        provider: "wahoo",
        activityName: "20 minute FTP test",
        providerType: "Cycling Test",
      },
      {
        activityId: ACTIVITY_ID,
        activityName: "20 minute FTP test",
        sourceRawEvidence: [
          {
            ...source("wahoo", {}),
            sourceActivityName: " 20 MINUTE ftp TEST ",
            providerType: " cycling   test ",
          },
        ],
        climbingRows: [],
        strengthRows: [],
      },
    );

    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({
      count: 1,
      items: [
        {
          evidence_type: "standardized_test_name_provider_type",
          provider: "wahoo",
          value: " 20 MINUTE ftp TEST ",
          provider_type: " cycling   test ",
        },
      ],
    });
  });
});

describe("buildRouteContext", () => {
  it("only claims route context for a caller-asserted provider-scoped cycling route", () => {
    expect(
      buildRouteContext(
        {
          kind: "cycling_route",
          provider: "strava",
          activityName: "Morning ride",
          providerType: "outdoor_ride",
        },
        "Morning ride",
      ),
    ).toMatchObject({
      status: "caller_asserted",
      provider: "strava",
      activity_name: "Morning ride",
      provider_type: "outdoor_ride",
    });
    expect(
      buildRouteContext(
        { kind: "activity_name", canonicalType: "cycling", value: "Morning ride" },
        "Morning ride",
      ),
    ).toMatchObject({ status: "not_available", provider: null });
  });
});

describe("bounded provenance", () => {
  it("caps activity and sensor source arrays while retaining total counts", () => {
    const values = Array.from({ length: 101 }, (_, index) => `source-${index}`);
    const activity = buildActivitySourceSummary(values, values, values);
    expect(activity).toMatchObject({
      source_provider_count: 101,
      source_external_id_count: 101,
      member_activity_id_count: 101,
      activity_source_evidence_truncated: true,
    });
    expect(activity.source_providers).toHaveLength(100);
    expect(activity.source_external_ids).toHaveLength(100);
    expect(activity.member_activity_ids).toHaveLength(100);
    const samples = buildSampleSourceSummary(values, values);
    expect(samples).toMatchObject({
      sample_source_provider_count: 101,
      sample_device_id_count: 101,
      sample_source_evidence_truncated: true,
    });
    expect(samples.sample_source_providers).toHaveLength(100);
    expect(samples.sample_device_ids).toHaveLength(100);
  });
});
