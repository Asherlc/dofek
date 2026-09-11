import { describe, expect, it, vi } from "vitest";
import { performanceComparisonOutputSchema } from "../packages/server/src/mcp/performance-comparison-output.ts";
import type { FindRepeatedEffortsOutput } from "../packages/server/src/repositories/repeated-efforts-repository.ts";
import {
  collectRepeatedCyclingReport,
  formatRepeatedCyclingReport,
  parseRepeatedCyclingReportOptions,
} from "./report-repeated-cycling-efforts.ts";

type Group = FindRepeatedEffortsOutput["groups"][number];
const userId = "00000000-0000-4000-8000-000000000001";

function group(kind: Group["kind"], strength: Group["strength"], count: number): Group {
  return {
    effortId: `${kind}:${strength}:fixture`,
    kind,
    strength,
    discoveryScope: { providers: [], modalities: [], canonicalTypes: ["cycling"] },
    displayName: "Fixture effort",
    providers: ["peloton", "garmin"],
    modalities: ["indoor"],
    canonicalTypes: ["cycling"],
    expectedDurationSeconds: null,
    repetitionCount: count,
    firstOccurrence: "2021-01-01T12:00:00Z",
    lastOccurrence: "2026-01-01T12:00:00Z",
    canonicalActivityIds: [userId],
    memberActivityIds: [userId],
    sourceEvidence: [
      {
        canonicalActivityId: userId,
        sourceActivityId: userId,
        provider: "garmin",
        externalId: "instance-only",
      },
    ],
    identityEvidence: [
      {
        canonicalActivityId: userId,
        sourceActivityId: userId,
        provider: "peloton",
        externalId: "instance-17",
        namespace: "peloton",
        value: "class-17",
        method: "explicit_identity",
        sourceField: "pelotonClassId",
        evidence: { geometry_status: "partial", coverage_pct: 64 },
      },
    ],
    assumptions: ["Expected duration unavailable"],
    qualityFlags: ["merged_sources"],
  };
}

function fixture(groups: Group[]) {
  return {
    scope: { userId, startDate: "2000-01-01", endDate: "2099-12-31", timezone: "UTC" },
    groups,
    assumptions: ["Fixture data only"],
    comparisons: [],
    cycling: {
      activities: [],
      rolling_90_day_best: { "5s": null, "1m": null, "5m": null, "20m": null },
      summary: {
        power_coverage: { activities_total: 0, activities_with_power: 0, pct: 0 },
        power_availability_by_modality: {
          indoor: {
            first_observed: null,
            last_observed: null,
            activities_total: 0,
            activities_with_power: 0,
            pct: 0,
            source_providers: [],
          },
          outdoor: {
            first_observed: null,
            last_observed: null,
            activities_total: 0,
            activities_with_power: 0,
            pct: 0,
            source_providers: [],
          },
          unknown: {
            first_observed: null,
            last_observed: null,
            activities_total: 0,
            activities_with_power: 0,
            pct: 0,
            source_providers: [],
          },
        },
        elevation_gain: {
          total_elevation_gain_m: null,
          avg_elevation_gain_m: null,
          coverage: { activities_total: 0, activities_with_elevation: 0, pct: 0 },
        },
      },
    },
  };
}

describe("repeated cycling report", () => {
  it("prioritizes exact workouts/tests, strong routes, structured identity, then weak names", () => {
    const report = fixture([
      group("activity_name", "weak_similarity", 10),
      group("provider_workout", "strong_inferred", 3),
      group("canonical_route", "strong_inferred", 4),
      group("standardized_test", "exact", 3),
      group("provider_workout", "exact", 2),
    ]);
    const text = formatRepeatedCyclingReport(report);
    const ordered = [
      "provider_workout:exact",
      "standardized_test:exact",
      "canonical_route:strong_inferred",
      "provider_workout:strong_inferred",
      "activity_name:weak_similarity",
    ];
    // Compare the discovery evidence section, independent of summary headings.
    const evidence = text.slice(text.indexOf("Discovery evidence"));
    for (let index = 1; index < ordered.length; index++) {
      const previous = evidence.indexOf(ordered[index - 1] ?? "missing");
      const current = evidence.indexOf(ordered[index] ?? "missing");
      expect(previous).toBeGreaterThanOrEqual(0);
      expect(current).toBeGreaterThan(previous);
    }
    expect(text.indexOf("Generic observed power")).toBeGreaterThan(
      text.indexOf("Longitudinal comparisons"),
    );
  });

  it("reports overlapping group memberships, frequency and multi-year effort counts", () => {
    const sameYear = {
      ...group("provider_workout", "exact", 2),
      firstOccurrence: "2026-01-01T00:00:00Z",
    };
    const text = formatRepeatedCyclingReport(
      fixture([sameYear, group("activity_name", "weak_similarity", 4)]),
    );
    expect(text).toContain("provider_workout / exact: groups=1, repetitions=2");
    expect(text).toContain("activity_name / weak_similarity: groups=1, repetitions=4");
    expect(text).toContain("Multi-year efforts: 1");
    const frequency = text.slice(
      text.indexOf("Most frequent efforts"),
      text.indexOf("Multi-year efforts"),
    );
    expect(frequency.indexOf("activity_name")).toBeLessThan(frequency.indexOf("provider_workout"));
    expect(text).toContain("memberships overlap");
  });

  it("attributes exact support to identity evidence, not other providers on a merged activity", () => {
    const text = formatRepeatedCyclingReport(fixture([group("provider_workout", "exact", 2)]));
    expect(text).toContain("peloton: observed exact kinds=provider_workout");
    expect(text).toContain(
      "garmin: no exact identity observed in repeated groups; support unknown",
    );
    expect(text).toContain('"sourceField":"pelotonClassId"');
    expect(text).toContain('"externalId":"instance-only"');
    expect(text).toContain('"qualityFlags":["merged_sources"]');
    expect(text).toContain('"coverage_pct":64');
  });

  it("keeps empty data, historical gaps and the false-fitness caveat explicit", () => {
    const text = formatRepeatedCyclingReport(fixture([]));
    expect(text).toContain("Exact provider-defined repeats: 0");
    expect(text).toContain("Repeated routes/climbs: 0");
    expect(text).toContain("No repeated groups observed");
    expect(text).toContain("Historical verification incomplete");
    expect(text).toContain("lower-bound observed capability, not maximal capacity");
    expect(text).toContain("Lower observed power does not demonstrate fitness decline");
    expect(text).toContain("structured-protocol discovery");
    expect(text).toContain("ClickHouse/dbt");
    expect(text).toContain("Fixture data only");
  });

  it("requires an explicit user and valid ordered date bounds", () => {
    expect(() =>
      parseRepeatedCyclingReportOptions(["--start=2000-01-01", "--end=2099-12-31"]),
    ).toThrow("--user-id is required");
    for (const dates of [
      ["2026-02-30", "2026-03-01"],
      ["2026-09-10", "2026-01-01"],
    ]) {
      expect(() =>
        parseRepeatedCyclingReportOptions([
          `--user-id=${userId}`,
          `--start=${dates[0]}`,
          `--end=${dates[1]}`,
        ]),
      ).toThrow();
    }
    expect(
      parseRepeatedCyclingReportOptions([
        `--user-id=${userId}`,
        "--start=2000-01-01",
        "--end=2099-12-31",
      ]),
    ).toEqual({ userId, startDate: "2000-01-01", endDate: "2099-12-31", timezone: "UTC" });
  });

  it("follows discovery cursors without dropping the user range or cycling filter", async () => {
    const find = vi
      .fn()
      .mockResolvedValueOnce({ groups: [], nextCursor: "page-two", assumptions: ["page one"] })
      .mockResolvedValueOnce({ groups: [], nextCursor: null, assumptions: ["page two"] });
    const report = await collectRepeatedCyclingReport(fixture([]).scope, {
      discovery: { find },
      comparison: { compare: vi.fn() },
      cycling: { listRange: vi.fn().mockResolvedValue(fixture([]).cycling) },
    });
    expect(report.assumptions).toEqual(["page one", "page two"]);
    expect(find).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        startDate: "2000-01-01",
        endDate: "2099-12-31",
        canonicalTypes: ["cycling"],
        equivalenceStrength: "weak",
        cursor: "page-two",
        limit: 100,
      }),
    );
  });

  it("propagates missing analytics prerequisites instead of publishing zero repeats", async () => {
    await expect(
      collectRepeatedCyclingReport(fixture([]).scope, {
        discovery: {
          find: vi.fn().mockRejectedValue(new Error("Missing analytics.activity_effort_identity")),
        },
        comparison: { compare: vi.fn() },
        cycling: { listRange: vi.fn() },
      }),
    ).rejects.toThrow("Missing analytics.activity_effort_identity");
  });

  it("keeps trend rediscovery cycling-scoped and preserves comparison limitations", async () => {
    const exact = group("provider_workout", "exact", 3);
    const find = vi.fn().mockResolvedValue({ groups: [exact], nextCursor: null, assumptions: [] });
    const comparison = {
      range: { start_date: "2000-01-01", end_date: "2099-12-31", timezone: "UTC" },
      equivalence: {
        key: { kind: "provider_workout", provider: "peloton", value: "class-17" },
        identity: { kind: "provider_workout", namespace: "peloton", value: "class-17" },
        strength: "exact",
        basis: "explicit",
        method: "explicit_identity",
        confidence: "high",
        assumptions: ["Retained class identity; intent unknown"],
      },
      baseline: { activity_id: userId, selection: "earliest_match_in_range" },
      definitions: {
        comparison: "Fixture comparison",
        moving_duration: "Unavailable without provider evidence",
        normalized_power: "Computed by the repository",
        power_to_heart_rate_ratio: "Descriptive ratio",
        deltas: "Candidate minus baseline",
        strength_estimated_one_rep_max: "Epley",
        causality: "No causal claim",
      },
      coverage: {
        canonical_activities: 0,
        cycling_metrics_from_deduped_samples: 0,
        environment_metrics_from_deduped_samples: 0,
        activities_with_missing_duration: 0,
        timezone_assumed_activities: 0,
        performances_with_equivalence_evidence: 0,
        performances_with_moving_duration: 0,
      },
      performances: [],
      pagination: { limit: 100, has_more: false, next_cursor: null },
      rejected_near_matches: {
        status: "not_evaluated",
        reason: "Similarity does not establish equivalence",
        items: [],
      },
    };
    performanceComparisonOutputSchema.parse({ result: comparison });
    const compare = vi.fn().mockResolvedValue(comparison);
    const report = await collectRepeatedCyclingReport(fixture([]).scope, {
      discovery: { find },
      comparison: { compare },
      cycling: { listRange: vi.fn().mockResolvedValue(fixture([]).cycling) },
    });
    expect(find).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ canonicalTypes: ["cycling"], effortId: exact.effortId }),
    );
    expect(compare).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: "2000-01-01",
        endDate: "2099-12-31",
        equivalence: { kind: "provider_workout", provider: "peloton", value: "class-17" },
      }),
    );
    expect(report.comparisons[0]?.comparison).toEqual(comparison);
    const text = formatRepeatedCyclingReport(report);
    expect(text).toContain("Retained class identity; intent unknown");
    expect(text).toContain('"comparable_repetitions":0');
    expect(text).toContain("Historical verification incomplete");
  });
});
