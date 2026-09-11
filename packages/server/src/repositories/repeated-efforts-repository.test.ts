import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RepeatedEffortsRepository } from "./repeated-efforts-repository.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const input = { startDate: "2026-01-01", endDate: "2026-12-31" };
function activity(n: number, overrides = {}) {
  return {
    activity_id: id(n),
    started_at: `2026-01-0${n}T12:00:00Z`,
    ended_at: `2026-01-0${n}T12:30:00Z`,
    canonical_type: "cycling",
    modality: "indoor",
    name: "Tempo",
    member_activity_ids: [id(n)],
    source_providers: ["trainerroad"],
    ...overrides,
  };
}
function identity(n: number, overrides = {}) {
  return {
    canonical_activity_id: id(n),
    source_activity_id: id(n),
    source_provider: "trainerroad",
    source_external_id: `instance-${n}`,
    kind: "provider_workout",
    namespace: "trainerroad",
    value: "Template-A",
    normalized_value: "template-a",
    display_name: "Tempo",
    strength: "exact",
    method: "exact_explicit_raw_identity_v1",
    source_field: "templateId",
    evidence: { rawValue: "Template-A" },
    ...overrides,
  };
}
function setup(
  activities: unknown[],
  identities: unknown[],
  routes: unknown[] = [],
  benchmarks: unknown[] = [],
) {
  const query = vi.fn(async (schema: z.ZodType, sql: string) => {
    const rows = sql.includes("activity_effort_identity")
      ? identities
      : sql.includes("activity_route_identity")
        ? routes
        : sql.includes("activity_source_records")
          ? activities.flatMap((value) => {
              const parsedActivity = z
                .object({
                  activity_id: z.string(),
                  member_activity_ids: z.array(z.string()),
                  source_providers: z.array(z.string()),
                })
                .parse(value);
              return parsedActivity.member_activity_ids.map((member, index) => ({
                source_activity_id: member,
                provider:
                  parsedActivity.source_providers[index] ?? parsedActivity.source_providers[0],
                external_id: `instance-${member}`,
              }));
            })
          : activities;
    return z.array(schema).parse(rows);
  });
  const db = { execute: vi.fn().mockResolvedValue(benchmarks) };
  return { repository: new RepeatedEffortsRepository(db, { query }, userId, "UTC"), query };
}

describe("RepeatedEffortsRepository.find", () => {
  it("flags conflicting stable identities from merged members without discarding their evidence", async () => {
    const { repository } = setup(
      [activity(1, { member_activity_ids: [id(1), id(11)] }), activity(2)],
      [
        identity(1),
        identity(1, { source_activity_id: id(11), value: "different-template" }),
        identity(2),
      ],
    );
    const group = (await repository.find(input)).groups[0];
    expect(group?.qualityFlags).toContain("conflicting_identity_evidence");
    expect(group?.identityEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "different-template", sourceActivityId: id(11) }),
      ]),
    );
  });
  it("groups reusable provider identities, counting canonical activities rather than evidence rows", async () => {
    const { repository } = setup(
      [activity(1), activity(2), activity(3)],
      [identity(1), identity(1), identity(2), identity(3)],
    );
    const result = await repository.find(input);
    expect(result.groups).toEqual([
      expect.objectContaining({
        kind: "provider_workout",
        strength: "exact",
        repetitionCount: 3,
        canonicalActivityIds: [id(1), id(2), id(3)],
        expectedDurationSeconds: null,
      }),
    ]);
  });
  it("requires opt-in for name/duration candidates and never calls them exact", async () => {
    const identities = [1, 2].map((n) =>
      identity(n, {
        kind: "activity_name",
        namespace: "cycling",
        value: "Tempo",
        normalized_value: "tempo",
        strength: "weak_similarity",
      }),
    );
    const { repository } = setup([activity(1), activity(2)], identities);
    expect((await repository.find({ ...input, effortKind: "activity_name" })).groups).toEqual([]);
    expect((await repository.find({ ...input, equivalenceStrength: "weak" })).groups).toEqual([
      expect.objectContaining({
        strength: "weak_similarity",
        repetitionCount: 2,
        qualityFlags: expect.arrayContaining(["weak_identity"]),
      }),
    ]);
  });
  it("preserves merged providers and source records even when only one member supplies identity", async () => {
    const { repository } = setup(
      [
        activity(1, {
          member_activity_ids: [id(1), id(11)],
          source_providers: ["strava", "apple_health"],
        }),
        activity(2),
      ],
      [identity(1), identity(2)],
    );
    const group = (await repository.find(input)).groups[0];
    expect(group?.sourceEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "strava", sourceActivityId: id(1) }),
        expect.objectContaining({ provider: "apple_health", sourceActivityId: id(11) }),
      ]),
    );
    expect(group?.memberActivityIds).toContain(id(11));
    expect(group?.repetitionCount).toBe(2);
  });
  it("does not collapse namespaces, case-sensitive exact keys, or strengths", async () => {
    const { repository } = setup(
      [activity(1), activity(2)],
      [identity(1), identity(2, { namespace: "other" }), identity(2, { value: "template-a" })],
    );
    expect((await repository.find(input)).groups).toEqual([]);
  });
  it("filters unusable timestamps, providers, modalities and activity types before counting", async () => {
    const { repository } = setup(
      [activity(1), activity(2, { started_at: "invalid" }), activity(3, { modality: "outdoor" })],
      [identity(1), identity(2), identity(3)],
    );
    expect((await repository.find({ ...input, modalities: ["indoor"] })).groups).toEqual([]);
    expect((await repository.find({ ...input, providers: ["garmin"] })).groups).toEqual([]);
    expect((await repository.find({ ...input, canonicalTypes: ["running"] })).groups).toEqual([]);
  });
  it("paginates complete groups and binds the cursor to user and filters", async () => {
    const { repository } = setup(
      [activity(1), activity(2)],
      [identity(1), identity(2), identity(1, { value: "B" }), identity(2, { value: "B" })],
    );
    const first = await repository.find({ ...input, limit: 1 });
    expect(first.groups).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await repository.find({ ...input, limit: 1, cursor: first.nextCursor });
    expect(second.groups).toHaveLength(1);
    expect(second.groups[0]?.effortId).not.toBe(first.groups[0]?.effortId);
    expect(second.nextCursor).toBeNull();
    await expect(
      repository.find({ ...input, providers: ["other"], cursor: first.nextCursor }),
    ).rejects.toThrow(/cursor/i);
    await expect(repository.find({ ...input, cursor: "garbage" })).rejects.toThrow();
  });
  it("returns caller assertions only when benchmark kind is explicitly selected", async () => {
    const { repository } = setup(
      [activity(1), activity(2)],
      [],
      [],
      [1, 2].map((n) => ({
        group_id: id(50),
        canonical_activity_id: id(n),
        display_name: "Saturday test",
        notes: "Steady effort",
        inclusion_note: "Same protocol",
      })),
    );
    expect((await repository.find(input)).groups).toEqual([]);
    expect(
      (await repository.find({ ...input, effortKind: "user_defined_benchmark" })).groups,
    ).toEqual([
      expect.objectContaining({
        strength: "caller_asserted",
        repetitionCount: 2,
        qualityFlags: expect.arrayContaining(["caller_asserted_equivalence"]),
      }),
    ]);
  });
  it("uses strong geometry with match evidence and rejects partial geometry", async () => {
    const routes = [1, 2, 3].map((n) => ({
      canonical_activity_id: id(n),
      points: [
        [40, -74],
        [40.01, -74],
        [40.02, -74],
      ],
      route_distance_meters: 2224,
      elevation_profile: [],
      coverage_pct: 100,
      largest_gap_seconds: 1,
      geometry_status: n === 3 ? "partial" : "available",
      source_providers: ["garmin"],
      source_devices: ["Edge 1050"],
    }));
    const { repository } = setup([activity(1), activity(2), activity(3)], [], routes);
    const groups = (await repository.find(input)).groups;
    expect(groups).toEqual([
      expect.objectContaining({
        kind: "canonical_route",
        strength: "strong_inferred",
        canonicalActivityIds: [id(1), id(2)],
      }),
    ]);
    expect(groups[0]?.identityEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "route_geometry_v1",
          evidence: expect.objectContaining({ matched: true }),
        }),
      ]),
    );
  });
  it("fails explicitly when candidate bounds would make repetition counts incomplete", async () => {
    const { repository } = setup(
      Array.from({ length: 2001 }, () => activity(1)),
      [],
    );
    await expect(repository.find(input)).rejects.toThrow(/narrow/i);
  });
  it("keeps identical geometry in different modalities or sports separate", async () => {
    const routes = [1, 2, 3].map((n) => ({
      canonical_activity_id: id(n),
      points: [
        [40, -74],
        [40.01, -74],
      ],
      route_distance_meters: 1112,
      elevation_profile: [],
      coverage_pct: 100,
      largest_gap_seconds: 1,
      geometry_status: "available",
      source_providers: ["garmin"],
      source_devices: ["Edge 1050"],
    }));
    const { repository } = setup(
      [
        activity(1),
        activity(2, { modality: "outdoor" }),
        activity(3, { canonical_type: "running" }),
      ],
      [],
      routes,
    );
    expect((await repository.find(input)).groups).toEqual([]);
  });
  it("separates weak name matches with substantially different durations", async () => {
    const { repository } = setup(
      [activity(1), activity(2, { ended_at: "2026-01-02T13:00:00Z" })],
      [1, 2].map((n) => identity(n, { kind: "activity_name", strength: "weak_similarity" })),
    );
    expect((await repository.find({ ...input, equivalenceStrength: "weak" })).groups).toEqual([]);
  });
});
