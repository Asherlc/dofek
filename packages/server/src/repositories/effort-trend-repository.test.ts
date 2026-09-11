import { describe, expect, it, vi } from "vitest";
import { EffortTrendRepository } from "./effort-trend-repository.ts";

const FIRST_ID = "00000000-0000-4000-8000-000000000010";
const SECOND_ID = "00000000-0000-4000-8000-000000000020";
const THIRD_ID = "00000000-0000-4000-8000-000000000030";

function performance(
  activityId: string,
  date: string,
  averagePowerWatts: number,
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
});
