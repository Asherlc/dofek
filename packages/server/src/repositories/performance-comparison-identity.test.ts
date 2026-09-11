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
});
