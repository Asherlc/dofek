import { describe, expect, it, vi } from "vitest";
import { EffortTrendRepository } from "./effort-trend-repository.ts";

const FIRST_ID = "00000000-0000-4000-8000-000000000010";
const SECOND_ID = "00000000-0000-4000-8000-000000000020";
const THIRD_ID = "00000000-0000-4000-8000-000000000030";
const FOURTH_ID = "00000000-0000-4000-8000-000000000040";

function performance(
  activityId: string,
  date: string,
  averagePowerWatts: number | null,
  flags: string[] = [],
) {
  return {
    activity_id: activityId,
    date,
    started_at: `${date}T12:00:00.000Z`,
    duration_seconds: 1800,
    moving_duration: { seconds: 1750, status: "available" },
    metrics: {
      cycling: {
        average_power_watts: averagePowerWatts,
        normalized_power_watts: null,
        average_heart_rate_bpm: null,
        average_cadence_rpm: null,
        power_to_heart_rate_ratio: null,
        distance_meters: null,
        elevation_gain_meters: null,
        sample_coverage: { status: "available" },
      },
      climbing: null,
      strength: null,
      environment: { average_temperature_c: null },
    },
    identity: { assumptions: ["Recorded workout identity"] },
    equivalence_evidence: [{ evidence_type: "identity_read_model" }],
    quality: { comparable: true, flags },
  };
}

function comparisonResult(performances: ReturnType<typeof performance>[]) {
  return {
    equivalence: {
      key: { kind: "provider_workout", provider: "zwift", value: "17" },
      identity: { kind: "provider_workout", namespace: "zwift", value: "17" },
      strength: "exact",
      basis: "explicit",
      method: "explicit_identity",
      confidence: "high",
      assumptions: ["Exact provider identity"],
    },
    definitions: { deltas: "Every numeric delta is candidate minus baseline." },
    coverage: { canonical_activities: performances.length },
    performances,
  };
}

describe("EffortTrendRepository", () => {
  it("projects every supported metric and applies metric-specific best direction", async () => {
    const rows = [
      {
        ...performance(FIRST_ID, "2026-01-01", 200),
        duration_seconds: 1800,
        moving_duration: { seconds: 1700, status: "available" },
        metrics: {
          cycling: {
            average_power_watts: 200,
            normalized_power_watts: 220,
            average_heart_rate_bpm: 150,
            average_cadence_rpm: 90,
            power_to_heart_rate_ratio: 1,
            distance_meters: 10_000,
            elevation_gain_meters: 100,
            sample_coverage: { status: "available" },
          },
          climbing: {
            attempts_status: "complete",
            attempts: 4,
            outcomes_status: "complete",
            sends: 2,
          },
          strength: {
            volume_status: "complete",
            valid_volume_kg_reps: 5_000,
            estimated_one_rep_max_status: "complete",
            best_estimated_one_rep_max_kg: 100,
          },
          environment: { average_temperature_c: 15 },
        },
      },
      {
        ...performance(SECOND_ID, "2026-01-08", 210),
        duration_seconds: 1700,
        moving_duration: { seconds: 1600, status: "available" },
        metrics: {
          cycling: {
            average_power_watts: 210,
            normalized_power_watts: 230,
            average_heart_rate_bpm: 145,
            average_cadence_rpm: 95,
            power_to_heart_rate_ratio: 2,
            distance_meters: 11_000,
            elevation_gain_meters: 120,
            sample_coverage: { status: "available" },
          },
          climbing: {
            attempts_status: "complete",
            attempts: 5,
            outcomes_status: "complete",
            sends: 3,
          },
          strength: {
            volume_status: "complete",
            valid_volume_kg_reps: 5_500,
            estimated_one_rep_max_status: "complete",
            best_estimated_one_rep_max_kg: 105,
          },
          environment: { average_temperature_c: 20 },
        },
      },
      {
        ...performance(THIRD_ID, "2026-01-15", 205),
        duration_seconds: 1750,
        moving_duration: { seconds: 1650, status: "available" },
        metrics: {
          cycling: {
            average_power_watts: 205,
            normalized_power_watts: 225,
            average_heart_rate_bpm: 148,
            average_cadence_rpm: 92,
            power_to_heart_rate_ratio: 1.5,
            distance_meters: 10_500,
            elevation_gain_meters: 110,
            sample_coverage: { status: "available" },
          },
          climbing: {
            attempts_status: "complete",
            attempts: 6,
            outcomes_status: "complete",
            sends: 2,
          },
          strength: {
            volume_status: "complete",
            valid_volume_kg_reps: 5_300,
            estimated_one_rep_max_status: "complete",
            best_estimated_one_rep_max_kg: 103,
          },
          environment: { average_temperature_c: 18 },
        },
      },
    ];
    const compare = vi.fn().mockResolvedValue(comparisonResult(rows));

    const result = await new EffortTrendRepository({ compare }).get({
      effortId: "provider_workout:zwift:17",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    expect(result.repetitions[0]?.comparable_metrics).toEqual({
      duration_seconds: 1800,
      moving_duration_seconds: 1700,
      average_power_watts: 200,
      normalized_power_watts: 220,
      average_heart_rate_bpm: 150,
      average_cadence_rpm: 90,
      power_to_heart_rate_ratio: 1,
      distance_meters: 10_000,
      elevation_gain_meters: 100,
      average_temperature_c: 15,
      climbing_attempts: 4,
      climbing_sends: 2,
      strength_volume_kg_reps: 5_000,
      strength_estimated_one_rep_max_kg: 100,
    });
    expect(result.repetitions[2]?.delta_to_best).toEqual({
      duration_seconds: 50,
      moving_duration_seconds: 50,
      average_power_watts: -5,
      normalized_power_watts: -5,
      average_heart_rate_bpm: null,
      average_cadence_rpm: null,
      power_to_heart_rate_ratio: -0.5,
      distance_meters: -500,
      elevation_gain_meters: -10,
      average_temperature_c: null,
      climbing_attempts: null,
      climbing_sends: -1,
      strength_volume_kg_reps: -200,
      strength_estimated_one_rep_max_kg: -2,
    });
    expect(result.repetitions[2]?.rolling).toEqual({
      window_repetitions: 3,
      observation_count: 3,
      metric_observation_counts: {
        duration_seconds: 3,
        moving_duration_seconds: 3,
        average_power_watts: 3,
        normalized_power_watts: 3,
        average_heart_rate_bpm: 3,
        average_cadence_rpm: 3,
        power_to_heart_rate_ratio: 3,
        distance_meters: 3,
        elevation_gain_meters: 3,
        average_temperature_c: 3,
        climbing_attempts: 3,
        climbing_sends: 3,
        strength_volume_kg_reps: 3,
        strength_estimated_one_rep_max_kg: 3,
      },
      comparable_metrics: {
        duration_seconds: 1750,
        moving_duration_seconds: 1650,
        average_power_watts: 205,
        normalized_power_watts: 225,
        average_heart_rate_bpm: 147.667,
        average_cadence_rpm: 92.333,
        power_to_heart_rate_ratio: 1.5,
        distance_meters: 10_500,
        elevation_gain_meters: 110,
        average_temperature_c: 17.667,
        climbing_attempts: 5,
        climbing_sends: 2.333,
        strength_volume_kg_reps: 5_266.667,
        strength_estimated_one_rep_max_kg: 102.667,
      },
      status: "available",
      reason: null,
    });
  });

  it("keeps unavailable metrics null instead of subtracting or ranking them", async () => {
    const first = {
      ...performance(FIRST_ID, "2026-01-01", 200),
      metrics: {
        ...performance(FIRST_ID, "2026-01-01", 200).metrics,
        cycling: {
          ...performance(FIRST_ID, "2026-01-01", 200).metrics.cycling,
          normalized_power_watts: null,
        },
      },
    };
    const second = {
      ...performance(SECOND_ID, "2026-01-08", null),
      moving_duration: { seconds: 999, status: "unavailable" },
      metrics: {
        ...performance(SECOND_ID, "2026-01-08", null).metrics,
        cycling: {
          ...performance(SECOND_ID, "2026-01-08", null).metrics.cycling,
          normalized_power_watts: 220,
        },
        climbing: {
          attempts_status: "partial",
          attempts: 9,
          outcomes_status: "partial",
          sends: 8,
        },
        strength: {
          volume_status: "partial",
          valid_volume_kg_reps: 9_000,
          estimated_one_rep_max_status: "partial",
          best_estimated_one_rep_max_kg: 200,
        },
      },
    };
    const compare = vi.fn().mockResolvedValue(comparisonResult([first, second]));

    const result = await new EffortTrendRepository({ compare }).get({
      effortId: "provider_workout:zwift:17",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    expect(result.repetitions[1]?.comparable_metrics).toMatchObject({
      moving_duration_seconds: null,
      average_power_watts: null,
      normalized_power_watts: 220,
      climbing_attempts: null,
      climbing_sends: null,
      strength_volume_kg_reps: null,
      strength_estimated_one_rep_max_kg: null,
    });
    expect(result.repetitions[1]?.delta_to_first).toMatchObject({
      moving_duration_seconds: null,
      average_power_watts: null,
      normalized_power_watts: null,
    });
    expect(result.repetitions[1]?.delta_to_best).toMatchObject({
      average_power_watts: null,
      normalized_power_watts: 0,
    });
    expect(result.repetitions[0]?.delta_to_best.moving_duration_seconds).toBe(0);
  });

  it("counts non-null rolling observations separately for each metric and retains performance evidence", async () => {
    const row = {
      ...performance(FIRST_ID, "2026-01-01", 200),
      route: { geometry: { overlap_percentage: 0.98 }, source_providers: ["garmin"] },
      provenance: { source_member_activity_ids: [FIRST_ID] },
    };
    const compare = vi
      .fn()
      .mockResolvedValue(
        comparisonResult([
          row,
          performance(SECOND_ID, "2026-01-08", null),
          performance(THIRD_ID, "2026-01-15", null),
        ]),
      );
    const result = await new EffortTrendRepository({ compare }).get({
      effortId: "provider_workout:zwift:17",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(result.repetitions[2]?.rolling).toMatchObject({
      comparable_metrics: { average_power_watts: null, duration_seconds: 1800 },
      metric_observation_counts: { average_power_watts: 1, duration_seconds: 3 },
    });
    expect(result.repetitions[0]?.evidence).toContainEqual(
      expect.objectContaining({
        evidence_type: "comparison_performance",
        route: row.route,
        metrics: row.metrics,
        provenance: row.provenance,
      }),
    );
  });
  it("calculates deltas to first, previous, and best without changing equivalence", async () => {
    const compareMock = vi
      .fn()
      .mockResolvedValue(
        comparisonResult([
          performance(FIRST_ID, "2026-01-01", 200),
          performance(SECOND_ID, "2026-01-08", 212),
          performance(THIRD_ID, "2026-01-15", 208),
        ]),
      );
    const repository = new EffortTrendRepository({ compare: compareMock });

    const result = await repository.get({
      effortId: "provider_workout:zwift:17",
      startDate: "2020-01-01",
      endDate: "2026-12-31",
    });

    expect(result.repetitions.map((row) => row.delta_to_first.average_power_watts)).toEqual([
      0, 12, 8,
    ]);
    expect(result.repetitions[2]).toMatchObject({
      delta_to_previous: { average_power_watts: -4 },
      delta_to_best: { average_power_watts: -4 },
    });
    expect(compareMock).toHaveBeenCalledTimes(1);
    expect(compareMock).toHaveBeenCalledWith(
      expect.objectContaining({
        equivalence: { kind: "provider_workout", provider: "zwift", value: "17" },
      }),
    );
  });

  it("keeps trend caveats when repetitions have incomplete samples", async () => {
    const compareMock = vi
      .fn()
      .mockResolvedValue(
        comparisonResult([
          performance(FIRST_ID, "2026-01-01", 200),
          performance(SECOND_ID, "2026-01-08", 212, ["limited_sample_coverage"]),
        ]),
      );
    const repository = new EffortTrendRepository({ compare: compareMock });

    const result = await repository.get({
      equivalence: { kind: "canonical_route", value: "r1" },
      startDate: "2020-01-01",
      endDate: "2026-12-31",
    });

    expect(result.caveats).toContain("Some repetitions have limited sample coverage");
  });

  it("resolves an opaque discovery effort ID before delegating comparison", async () => {
    const compareMock = vi.fn().mockResolvedValue(comparisonResult([]));
    const discovery = {
      find: vi.fn().mockResolvedValue({
        groups: [
          {
            effortId: "provider_workout:exact:opaque-id",
            kind: "provider_workout",
            discoveryScope: { providers: [], modalities: [], canonicalTypes: ["cycling"] },
            canonicalActivityIds: [FIRST_ID, SECOND_ID],
            canonicalTypes: ["cycling"],
            identityEvidence: [{ namespace: "zwift", value: "17" }],
          },
        ],
        nextCursor: null,
      }),
    };
    const repository = new EffortTrendRepository({ compare: compareMock }, discovery);

    await repository.get({
      effortId: "provider_workout:exact:opaque-id",
      startDate: "2020-01-01",
      endDate: "2026-12-31",
    });

    expect(discovery.find).toHaveBeenCalledTimes(1);
    expect(compareMock).toHaveBeenCalledWith(
      expect.objectContaining({
        equivalence: { kind: "provider_workout", provider: "zwift", value: "17" },
      }),
    );
  });

  it("preserves the complete weak discovery specification in comparison", async () => {
    const weakSpecification = {
      namespace: "garmin",
      normalizedValue: "tempo",
      canonicalType: "running",
      modality: "road",
      durationBucket: 6,
    };
    const compare = vi.fn().mockResolvedValue(comparisonResult([]));
    const find = vi.fn().mockResolvedValue({
      groups: [
        {
          effortId: "activity_name:weak_similarity:opaque-id",
          kind: "activity_name",
          discoveryScope: { providers: [], modalities: [], canonicalTypes: ["running"] },
          canonicalActivityIds: [FIRST_ID, SECOND_ID],
          canonicalTypes: ["running"],
          weakSpecification,
          identityEvidence: [{ namespace: "garmin", value: " Tempo " }],
        },
      ],
      nextCursor: null,
    });
    await new EffortTrendRepository({ compare }, { find }).get({
      effortId: "activity_name:weak_similarity:opaque-id",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(compare).toHaveBeenCalledWith(
      expect.objectContaining({
        equivalence: {
          kind: "activity_name",
          canonicalType: "running",
          value: "tempo",
          asserted: false,
          weakSpecification,
        },
      }),
    );
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        effortId: "activity_name:weak_similarity:opaque-id",
        effortKind: "activity_name",
        limit: 1,
      }),
    );
  });

  it.each([
    { flags: [] },
    { flags: ["strength_volume_coverage_partial"] },
    { flags: ["climbing_attempt_coverage_partial"] },
  ])(
    "does not label non-cycling repetitions as having limited cycling samples: $flags",
    async ({ flags }) => {
      const row = performance(FIRST_ID, "2026-01-01", 200, flags);
      const compare = vi.fn().mockResolvedValue({
        ...comparisonResult([]),
        performances: [
          { ...row, metrics: { ...row.metrics, cycling: null, cycling_effort: null } },
        ],
      });
      const result = await new EffortTrendRepository({ compare }).get({
        equivalence: { kind: "activity_name", canonicalType: "running", value: "Tempo" },
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      expect(result.repetitions).toHaveLength(1);
      expect(result.repetitions[0]?.quality.flags).toEqual(flags);
      expect(result.caveats).not.toContain("Some repetitions have limited sample coverage");
      expect(result.repetitions[0]?.caveats).not.toContain(
        "This repetition has limited sample coverage",
      );
    },
  );

  it.each([
    {
      name: "sample coverage",
      patch: { sampleStatus: "partial", effortStatus: "available", flags: [] },
    },
    {
      name: "cycling effort quality",
      patch: { sampleStatus: "available", effortStatus: "limited", flags: [] },
    },
    {
      name: "limited quality flag",
      patch: { sampleStatus: "available", effortStatus: "available", flags: ["power_limited"] },
    },
    {
      name: "coverage quality flag",
      patch: {
        sampleStatus: "available",
        effortStatus: "available",
        flags: ["power_coverage_partial"],
      },
    },
  ])("reports limited cycling samples from $name", async ({ patch }) => {
    const row = performance(FIRST_ID, "2026-01-01", 200, patch.flags);
    const compare = vi.fn().mockResolvedValue({
      ...comparisonResult([]),
      performances: [
        {
          ...row,
          metrics: {
            ...row.metrics,
            cycling: {
              ...row.metrics.cycling,
              sample_coverage: { status: patch.sampleStatus },
            },
            cycling_effort: { quality: { status: patch.effortStatus } },
          },
        },
      ],
    });

    const result = await new EffortTrendRepository({ compare }).get({
      effortId: "provider_workout:zwift:17",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    expect(result.caveats).toEqual([
      "Ordinary workout bests are lower-bound observed capability, not maximal capacity.",
      "Some repetitions have limited sample coverage",
    ]);
    expect(result.repetitions[0]?.caveats).toEqual([
      "Ordinary workout bests are lower-bound observed capability, not maximal capacity.",
      "This repetition has limited sample coverage",
    ]);
  });

  it("does not infer limited coverage from an unrelated cycling quality flag", async () => {
    const row = performance(FIRST_ID, "2026-01-01", 200, ["device_changed"]);
    const compare = vi.fn().mockResolvedValue({
      ...comparisonResult([]),
      performances: [
        {
          ...row,
          metrics: {
            ...row.metrics,
            cycling_effort: { quality: { status: "available" } },
          },
        },
      ],
    });

    const result = await new EffortTrendRepository({ compare }).get({
      effortId: "provider_workout:zwift:17",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    expect(result.caveats).toEqual([
      "Ordinary workout bests are lower-bound observed capability, not maximal capacity.",
    ]);
    expect(result.repetitions[0]?.caveats).toEqual([
      "Ordinary workout bests are lower-bound observed capability, not maximal capacity.",
    ]);
  });

  it.each([
    [
      "canonical_route:fingerprint:forward",
      { kind: "canonical_route", value: "fingerprint:forward" },
    ],
    [
      "provider_route:garmin:route:42",
      { kind: "provider_route", provider: "garmin", value: "route:42" },
    ],
    ["segment:strava:segment:9", { kind: "segment", namespace: "strava", value: "segment:9" }],
    ["climb:dofek:climb:7", { kind: "climb", namespace: "dofek", value: "climb:7" }],
    [
      "standardized_test:lab:test:3",
      { kind: "standardized_test", namespace: "lab", value: "test:3" },
    ],
  ])("parses direct effort identity %s without discovery", async (effortId, equivalence) => {
    const compare = vi.fn().mockResolvedValue(comparisonResult([]));

    await new EffortTrendRepository({ compare }).get({
      effortId,
      startDate: "2026-02-01",
      endDate: "2026-02-28",
    });

    expect(compare).toHaveBeenCalledWith({
      startDate: "2026-02-01",
      endDate: "2026-02-28",
      referenceActivityId: null,
      equivalence,
      providers: [],
      modalities: [],
      cursor: null,
      limit: 100,
    });
  });

  it("passes explicit equivalence with empty provider and modality filters", async () => {
    const compare = vi.fn().mockResolvedValue(comparisonResult([]));
    const equivalence = { kind: "canonical_route" as const, value: "route-1" };

    await new EffortTrendRepository({ compare }).get({
      equivalence,
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });

    expect(compare).toHaveBeenCalledWith({
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      referenceActivityId: null,
      equivalence,
      providers: [],
      modalities: [],
      cursor: null,
      limit: 100,
    });
  });

  it.each([
    ["canonical_route", "A discovery effort ID requires the repeated-effort repository"],
    ["provider_workout:zwift", "A discovery effort ID requires the repeated-effort repository"],
    ["provider_workout::17", "A discovery effort ID requires the repeated-effort repository"],
    ["unknown:value", "A discovery effort ID requires the repeated-effort repository"],
    ["unknown:namespace:value", "A discovery effort ID requires the repeated-effort repository"],
  ])("rejects non-direct effort identity %s without discovery", async (effortId, message) => {
    const compare = vi.fn().mockResolvedValue(comparisonResult([]));

    await expect(
      new EffortTrendRepository({ compare }).get({
        effortId,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      }),
    ).rejects.toThrow(message);
    expect(compare).not.toHaveBeenCalled();
  });

  it.each([
    { effortId: undefined, equivalence: undefined },
    {
      effortId: "provider_workout:zwift:17",
      equivalence: { kind: "canonical_route" as const, value: "route-1" },
    },
  ])("requires exactly one effort selector: $effortId", async ({ effortId, equivalence }) => {
    const compare = vi.fn().mockResolvedValue(comparisonResult([]));

    await expect(
      new EffortTrendRepository({ compare }).get({
        effortId,
        equivalence,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      }),
    ).rejects.toThrow("Provide exactly one effort ID or explicit equivalence");
    expect(compare).not.toHaveBeenCalled();
  });

  it.each([
    [
      "provider_route",
      "garmin",
      "route-7",
      { kind: "provider_route", provider: "garmin", value: "route-7" },
    ],
    [
      "segment",
      "strava",
      "segment-7",
      { kind: "segment", namespace: "strava", value: "segment-7" },
    ],
    ["climb", "dofek", "climb-7", { kind: "climb", namespace: "dofek", value: "climb-7" }],
    [
      "standardized_test",
      "lab",
      "test-7",
      { kind: "standardized_test", namespace: "lab", value: "test-7" },
    ],
    ["canonical_route", null, "route-7", { kind: "canonical_route", value: "route-7" }],
    [
      "user_defined_benchmark",
      null,
      "00000000-0000-4000-8000-000000000077",
      { kind: "user_defined_benchmark", value: "00000000-0000-4000-8000-000000000077" },
    ],
  ])(
    "maps discovered %s identity evidence into comparison equivalence",
    async (kind, namespace, value, equivalence) => {
      const effortId = `${kind}:exact:requested`;
      const compare = vi.fn().mockResolvedValue(comparisonResult([]));
      const find = vi.fn().mockResolvedValue({
        groups: [
          {
            effortId,
            kind,
            discoveryScope: {
              providers: ["garmin"],
              modalities: ["outdoor"],
              canonicalTypes: ["cycling"],
            },
            canonicalActivityIds: [FIRST_ID, SECOND_ID],
            canonicalTypes: ["cycling"],
            identityEvidence: [{ namespace, value }],
          },
        ],
        nextCursor: null,
      });

      await new EffortTrendRepository({ compare }, { find }).get({
        effortId,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      expect(find).toHaveBeenCalledWith({
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        minimumRepetitions: 2,
        equivalenceStrength: "weak",
        providers: [],
        modalities: [],
        canonicalTypes: [],
        effortKind: kind,
        effortId,
        limit: 1,
        cursor: null,
      });
      expect(compare).toHaveBeenCalledWith(
        expect.objectContaining({
          equivalence,
          providers: ["garmin"],
          modalities: ["outdoor"],
          discoveryActivityIds: [FIRST_ID, SECOND_ID],
        }),
      );
    },
  );

  it("selects the matching discovered group instead of the first result", async () => {
    const effortId = "canonical_route:strong_inferred:requested";
    const compare = vi.fn().mockResolvedValue(comparisonResult([]));
    const group = (candidateEffortId: string, value: string) => ({
      effortId: candidateEffortId,
      kind: "canonical_route",
      discoveryScope: { providers: [], modalities: [], canonicalTypes: ["cycling"] },
      canonicalActivityIds: [FIRST_ID, SECOND_ID],
      canonicalTypes: ["cycling"],
      identityEvidence: [{ namespace: null, value }],
    });
    const find = vi.fn().mockResolvedValue({
      groups: [
        group("canonical_route:strong_inferred:different", "wrong"),
        group(effortId, "right"),
      ],
      nextCursor: null,
    });

    await new EffortTrendRepository({ compare }, { find }).get({
      effortId,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    expect(compare).toHaveBeenCalledWith(
      expect.objectContaining({ equivalence: { kind: "canonical_route", value: "right" } }),
    );
  });

  it.each([
    {
      name: "missing group",
      effortId: "canonical_route:strong_inferred:requested",
      group: null,
      message: "The discovery effort ID was not found in the requested date range",
    },
    {
      name: "missing identity evidence",
      effortId: "canonical_route:strong_inferred:requested",
      group: {
        kind: "canonical_route",
        identityEvidence: [],
      },
      message: "The discovery effort has no identity evidence",
    },
    {
      name: "missing provider namespace",
      effortId: "provider_route:exact:requested",
      group: {
        kind: "provider_route",
        identityEvidence: [{ namespace: null, value: "route-1" }],
      },
      message: "The discovery effort has no provider namespace",
    },
    {
      name: "missing identity namespace",
      effortId: "segment:exact:requested",
      group: {
        kind: "segment",
        identityEvidence: [{ namespace: null, value: "segment-1" }],
      },
      message: "The discovery effort has no identity namespace",
    },
    {
      name: "missing weak specification",
      effortId: "activity_name:weak_similarity:requested",
      group: {
        kind: "activity_name",
        identityEvidence: [{ namespace: "garmin", value: "tempo" }],
      },
      message: "The discovery effort has no weak-group specification",
    },
    {
      name: "unsupported discovered identity",
      effortId: "provider_workout:exact:requested",
      group: {
        kind: "unsupported",
        identityEvidence: [{ namespace: "zwift", value: "17" }],
      },
      message: "The discovery effort cannot be converted to a comparison equivalence",
    },
  ])("rejects $name", async ({ effortId, group, message }) => {
    const compare = vi.fn().mockResolvedValue(comparisonResult([]));
    const completeGroup = group
      ? {
          effortId,
          discoveryScope: { providers: [], modalities: [], canonicalTypes: ["cycling"] },
          canonicalActivityIds: [FIRST_ID, SECOND_ID],
          canonicalTypes: ["cycling"],
          ...group,
        }
      : null;
    const find = vi.fn().mockResolvedValue({
      groups: completeGroup ? [completeGroup] : [],
      nextCursor: null,
    });

    await expect(
      new EffortTrendRepository({ compare }, { find }).get({
        effortId,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      }),
    ).rejects.toThrow(message);
    expect(compare).not.toHaveBeenCalled();
  });

  it("rejects a discovery effort ID with an unsupported identity prefix", async () => {
    const compare = vi.fn().mockResolvedValue(comparisonResult([]));
    const find = vi.fn();

    await expect(
      new EffortTrendRepository({ compare }, { find }).get({
        effortId: "unknown:exact:requested",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      }),
    ).rejects.toThrow("The discovery effort ID has an unsupported identity kind");
    expect(find).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it("uses a trailing three-repetition window in chronological comparison order", async () => {
    const compare = vi
      .fn()
      .mockResolvedValue(
        comparisonResult([
          performance(FIRST_ID, "2026-01-01", 100),
          performance(SECOND_ID, "2026-01-08", 200),
          performance(THIRD_ID, "2026-01-15", 300),
          performance(FOURTH_ID, "2026-01-22", 400),
        ]),
      );

    const result = await new EffortTrendRepository({ compare }).get({
      effortId: "provider_workout:zwift:17",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    expect(result.repetitions.map((row) => row.date)).toEqual([
      "2026-01-01",
      "2026-01-08",
      "2026-01-15",
      "2026-01-22",
    ]);
    expect(result.repetitions[0]?.delta_to_previous.average_power_watts).toBeNull();
    expect(result.repetitions[1]?.rolling).toMatchObject({
      observation_count: 2,
      status: "insufficient_observations",
      reason: "At least three repetitions are required for a descriptive rolling trend.",
    });
    expect(result.repetitions[2]?.rolling).toMatchObject({
      observation_count: 3,
      comparable_metrics: { average_power_watts: 200 },
      status: "available",
      reason: null,
    });
    expect(result.repetitions[3]?.rolling).toMatchObject({
      observation_count: 3,
      comparable_metrics: { average_power_watts: 300 },
      status: "available",
      reason: null,
    });
  });

  it("aggregates identity evidence, assumptions, pagination, and comparable quality", async () => {
    const first = {
      ...performance(FIRST_ID, "2026-01-01", 200),
      identity: { assumptions: ["First row assumption"] },
      equivalence_evidence: [{ evidence_type: "provider_identity", value: "17" }],
      quality: { comparable: true, flags: [] },
    };
    const second = {
      ...performance(SECOND_ID, "2026-01-08", 205),
      identity: { assumptions: ["Second row assumption"] },
      equivalence_evidence: [{ evidence_type: "route_identity", value: "route-1" }],
      quality: { comparable: false, flags: ["weak_identity"] },
    };
    const compare = vi.fn().mockResolvedValue({
      ...comparisonResult([first, second]),
      pagination: { has_more: true },
    });

    const result = await new EffortTrendRepository({ compare }).get({
      effortId: "provider_workout:zwift:17",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    expect(result.quality).toEqual({ comparable_repetitions: 1, total_repetitions: 2 });
    expect(result.evidence).toEqual([
      { evidence_type: "provider_identity", value: "17" },
      { evidence_type: "route_identity", value: "route-1" },
    ]);
    expect(result.assumptions).toEqual(["Exact provider identity"]);
    expect(result.repetitions[0]?.assumptions).toEqual([
      "Exact provider identity",
      "First row assumption",
    ]);
    expect(result.repetitions[1]?.assumptions).toEqual([
      "Exact provider identity",
      "Second row assumption",
    ]);
    expect(result.caveats).toEqual([
      "Ordinary workout bests are lower-bound observed capability, not maximal capacity.",
      "Only the first 100 chronological repetitions are included; narrow the date range for a complete trend.",
    ]);
    expect(result.repetitions[1]?.caveats).toEqual([
      "Ordinary workout bests are lower-bound observed capability, not maximal capacity.",
      "This repetition has weak identity evidence and is not comparable.",
    ]);
  });
});
