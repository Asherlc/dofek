import { describe, expect, it, vi } from "vitest";
import {
  type ComparisonIdentityRow,
  PerformanceComparisonIdentity,
} from "./performance-comparison-identity.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const first = "00000000-0000-4000-8000-000000000010";
const second = "00000000-0000-4000-8000-000000000020";
const identity = (overrides: Partial<ComparisonIdentityRow> = {}): ComparisonIdentityRow => ({
  canonical_activity_id: first,
  source_activity_id: first,
  source_provider: "zwift",
  source_external_id: "instance-1",
  kind: "provider_workout",
  namespace: "zwift",
  value: "Template-A",
  normalized_value: "template-a",
  display_name: "Tempo",
  strength: "exact",
  method: "recorded_template",
  source_field: "templateId",
  evidence: {},
  ...overrides,
});
const activity = (id: string) => ({
  activity_id: id,
  member_activity_ids: [id],
  canonical_type: "cycling",
  modality: "outdoor",
});
const route = (id: string) => ({
  canonical_activity_id: id,
  route_fingerprint: "route-fingerprint",
  points: [
    [37, -122],
    [37.01, -122],
    [37.02, -122],
  ] satisfies [number, number][],
  route_distance_meters: 2224,
  elevation_profile: [],
  coverage_pct: 100,
  largest_gap_seconds: 1,
  geometry_status: "available" as const,
  source_providers: ["garmin"],
  source_devices: ["edge"],
});
const repository = () =>
  new PerformanceComparisonIdentity({ execute: vi.fn() }, { query: vi.fn() }, userId);

describe("PerformanceComparisonIdentity", () => {
  it.each([
    { change: {}, matches: true },
    { change: { namespace: null }, matches: false },
    { change: { namespace: "other" }, matches: false },
    { change: { normalized_value: "other" }, matches: false },
    { change: { kind: "provider_workout" }, matches: false },
  ] as const)("matches weak recorded identity with $change", ({ change, matches }) => {
    const row = identity({ kind: "activity_name", normalized_value: "tempo", ...change });
    const result = repository().matchingWeak(
      {
        namespace: "zwift",
        normalizedValue: "tempo",
        canonicalType: "cycling",
        modality: "outdoor",
        durationBucket: 6,
      },
      [row],
      [
        {
          ...activity(first),
          started_at: "2026-01-01T12:00:00Z",
          ended_at: "2026-01-01T12:30:00Z",
        },
      ],
    );
    expect(result).toEqual(matches ? [row] : []);
  });

  it.each([
    { seconds: 1799, modality: null, canonical_type: "cycling", matches: false },
    { seconds: 1800, modality: null, canonical_type: "cycling", matches: true },
    { seconds: 2099.9, modality: null, canonical_type: "cycling", matches: true },
    { seconds: 2100, modality: null, canonical_type: "cycling", matches: false },
    { seconds: null, modality: null, canonical_type: "cycling", matches: false },
    { seconds: 1800, modality: "outdoor", canonical_type: "cycling", matches: false },
    { seconds: 1800, modality: null, canonical_type: "running", matches: false },
  ])(
    "keeps exact weak duration/type/modality constraints: $seconds/$modality/$canonical_type",
    ({ seconds, modality, canonical_type, matches }) => {
      const row = identity({ kind: "activity_name", namespace: null, normalized_value: "tempo" });
      const result = repository().matchingWeak(
        {
          namespace: null,
          normalizedValue: "tempo",
          canonicalType: "cycling",
          modality: null,
          durationBucket: 6,
        },
        [row],
        [
          {
            ...activity(first),
            canonical_type,
            modality,
            started_at: "2026-01-01T12:00:00Z",
            ended_at:
              seconds === null
                ? null
                : new Date(Date.parse("2026-01-01T12:00:00Z") + seconds * 1000).toISOString(),
          },
        ],
      );
      expect(result).toEqual(matches ? [row] : []);
    },
  );
  it("matches a discovery second-precision duration bucket at a millisecond boundary", () => {
    const row = identity({ kind: "activity_name", namespace: null, normalized_value: "tempo" });

    const result = repository().matchingWeak(
      {
        namespace: null,
        normalizedValue: "tempo",
        canonicalType: "cycling",
        modality: "outdoor",
        // Discovery formats timestamps to seconds: 12:00:00 → 12:35:00 is bucket 7.
        durationBucket: 7,
      },
      [row],
      [
        {
          ...activity(first),
          started_at: "2026-01-01T12:00:00.900Z",
          ended_at: "2026-01-01T12:35:00.800Z",
        },
      ],
    );

    expect(result).toEqual([row]);
  });
  it("rejects conflicting exact identities unless a specific namespaced value is selected", () => {
    const rows = [identity(), identity({ value: "Template-B" })];
    expect(() => repository().strongest(rows)).toThrow(/Conflicting exact identities/);
    expect(
      repository().matching(
        { kind: "provider_workout", provider: "zwift", value: "Template-A" },
        rows,
      ),
    ).toEqual([rows[0]]);
    expect(
      repository().matching(
        { kind: "provider_workout", provider: "zwift", value: "template-a" },
        rows,
      ),
    ).toEqual([]);
    expect(
      repository().matching(
        { kind: "provider_workout", provider: "garmin", value: "Template-A" },
        rows,
      ),
    ).toEqual([]);
  });
  it("rejects namespace ambiguity and never resolves weak name evidence as exact", () => {
    expect(() => repository().strongest([identity(), identity({ namespace: "garmin" })])).toThrow(
      /Ambiguous/,
    );
    expect(
      repository().strongest([identity({ kind: "activity_name", strength: "weak_similarity" })]),
    ).toBeNull();
    expect(
      repository().strongest([
        identity({ strength: "strong_inferred" }),
        identity({ kind: "provider_route", value: "route" }),
      ]),
    ).toEqual({ kind: "provider_route", provider: "zwift", value: "route" });
  });
  it("fences serving evidence by current canonical membership", async () => {
    const query = vi
      .fn()
      .mockResolvedValue([
        identity(),
        identity({ source_activity_id: second }),
        identity({ canonical_activity_id: second }),
      ]);
    const result = await new PerformanceComparisonIdentity(
      { execute: vi.fn() },
      { query },
      userId,
    ).identities([activity(first)]);
    expect(result).toEqual([identity()]);
    expect(query).toHaveBeenCalledWith(expect.anything(), expect.any(String), {
      userId,
      activityIds: [first],
    });
  });
  it("retains directional geometry quality and provenance for anchors and fingerprints", () => {
    const routes = [
      route(first),
      { ...route(second), points: [...route(second).points].reverse() },
    ];
    for (const value of [first, "route-fingerprint"]) {
      const result = repository().routeMatches(value, routes, [activity(first), activity(second)]);
      expect(result[1]).toMatchObject({
        activityId: second,
        anchor_activity_id: first,
        geometry: {
          matched: true,
          strength: "strong_inferred",
          direction: "reverse",
          overlap_percentage: 1,
          left_quality: { coverage_pct: 100 },
          right_quality: { largest_gap_seconds: 1 },
        },
        source_providers: ["garmin"],
        source_devices: ["edge"],
        anchor_source_providers: ["garmin"],
      });
    }
  });
  it("rejects incomplete geometry, different modalities, and unknown anchors", () => {
    const routes = [route(first), { ...route(second), geometry_status: "partial" as const }];
    expect(
      repository().routeMatches(first, routes, [activity(first), activity(second)]),
    ).toHaveLength(1);
    expect(
      repository().routeMatches(
        first,
        [route(first), route(second)],
        [activity(first), { ...activity(second), modality: "indoor" }],
      ),
    ).toHaveLength(1);
    expect(() => repository().routeMatches("unknown", routes, [activity(first)])).toThrow(
      /anchor is unavailable/,
    );
  });
  it.each(["partial", "unavailable"] as const)(
    "retains %s route evidence independently of geometry matching on either side",
    (status) => {
      for (const incompleteId of [first, second]) {
        const routes = [first, second].map((id) => ({
          ...route(id),
          ...(id === incompleteId
            ? { geometry_status: status, coverage_pct: 40, largest_gap_seconds: 300 }
            : {}),
        }));
        const result = repository().routeEvidence(first, routes, [
          activity(first),
          activity(second),
        ]);
        expect(result[1]).toMatchObject({
          activityId: second,
          anchor_activity_id: first,
          geometry: null,
          geometry_unavailable_reason: expect.stringContaining(status),
          quality: { geometry_status: incompleteId === second ? status : "available" },
          anchor_quality: { geometry_status: incompleteId === first ? status : "available" },
          source_providers: ["garmin"],
          source_devices: ["edge"],
          anchor_source_providers: ["garmin"],
          anchor_source_devices: ["edge"],
        });
        expect(
          repository()
            .routeMatches(first, routes, [activity(first), activity(second)])
            .map((row) => row.activityId),
        ).toEqual(incompleteId === first ? [] : [first]);
      }
    },
  );
});
