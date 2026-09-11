import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EffortTrendRepository } from "./effort-trend-repository.ts";
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
  sourceRows?: unknown[],
) {
  const query = vi.fn(async (schema: z.ZodType, sql: string, _params?: unknown) => {
    const rows = sql.includes("activity_effort_identity")
      ? identities
      : sql.includes("activity_route_identity")
        ? routes
        : sql.includes("activity_source_records")
          ? (sourceRows ??
            activities.flatMap((value) => {
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
            }))
          : activities;
    return z.array(schema).parse(rows);
  });
  const db = { execute: vi.fn().mockResolvedValue(benchmarks) };
  return {
    repository: new RepeatedEffortsRepository(db, { query }, userId, "UTC"),
    query,
    db,
  };
}

describe("RepeatedEffortsRepository.find", () => {
  it("preserves discovery filters and exact memberships when passed to trend", async () => {
    const { repository } = setup(
      [activity(1), activity(2), activity(3, { canonical_type: "running" })],
      [identity(1), identity(2), identity(3)],
    );
    const group = (
      await repository.find({
        ...input,
        providers: ["trainerroad"],
        modalities: ["indoor"],
        canonicalTypes: ["cycling"],
        effortKind: "provider_workout",
      })
    ).groups[0];
    if (!group) throw new Error("Expected discovered group");
    const compare = vi.fn().mockRejectedValue(new Error("comparison reached"));
    await expect(
      new EffortTrendRepository({ compare }, repository).get({
        ...input,
        effortId: group.effortId,
      }),
    ).rejects.toThrow("comparison reached");
    expect(compare).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ["trainerroad"],
        modalities: ["indoor"],
        discoveryActivityIds: [id(1), id(2)],
      }),
    );
  });
  it("resolves a valid ID beyond 2,000 groups in one bounded discovery pass", async () => {
    const identities = Array.from({ length: 2001 }, (_, index) =>
      [1, 2].map((n) => identity(n, { namespace: `provider-${index}` })),
    ).flat();
    const { repository, query } = setup([activity(1), activity(2)], identities);
    let cursor: string | null = null;
    let target = "";
    for (let page = 0; page < 21; page += 1) {
      const result = await repository.find({
        ...input,
        effortKind: "provider_workout",
        limit: 100,
        cursor,
      });
      cursor = result.nextCursor;
      target = result.groups.at(-1)?.effortId ?? "";
    }
    expect(target).toMatch(/^provider_workout:exact:/);
    expect(cursor).toBeNull();
    query.mockClear();
    const result = await repository.find({
      ...input,
      effortKind: "provider_workout",
      effortId: target,
      limit: 1,
    });
    expect(result.groups.map((group) => group.effortId)).toEqual([target]);
    expect(result.nextCursor).toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("returns every constraint used to identify a weak group", async () => {
    const { repository } = setup(
      [activity(1), activity(2)],
      [1, 2].map((n) =>
        identity(n, {
          kind: "activity_name",
          namespace: null,
          value: " Tempo ",
          normalized_value: "tempo",
          strength: "weak_similarity",
        }),
      ),
    );
    const result = await repository.find({ ...input, equivalenceStrength: "weak" });
    expect(result.groups[0]).toMatchObject({
      weakSpecification: {
        namespace: null,
        normalizedValue: "tempo",
        canonicalType: "cycling",
        modality: "indoor",
        durationBucket: 6,
      },
    });
  });
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
  it("rejects malformed effort IDs and cursors without exposing decoder errors", async () => {
    const { repository } = setup([activity(1), activity(2)], [identity(1), identity(2)]);

    await expect(repository.find({ ...input, effortId: "garbage" })).rejects.toThrow(
      "Invalid repeated-effort ID.",
    );
    await expect(
      repository.find({
        ...input,
        effortId: `provider_workout:exact:${"a".repeat(64)}:not-base64-json`,
      }),
    ).rejects.toThrow("Invalid repeated-effort ID.");
    await expect(repository.find({ ...input, cursor: "not-base64-json" })).rejects.toThrow(
      "Invalid repeated-effort cursor.",
    );
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

  it("accepts a one-day range but rejects a reversed range before querying", async () => {
    const { repository, query } = setup([], []);

    await expect(
      repository.find({ startDate: "2026-01-01", endDate: "2026-01-01" }),
    ).resolves.toMatchObject({ groups: [] });
    query.mockClear();
    await expect(
      repository.find({ startDate: "2026-01-02", endDate: "2026-01-01" }),
    ).rejects.toThrow("startDate must be on or before endDate");
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts exactly 2,000 canonical activity candidates", async () => {
    const { repository } = setup(
      Array.from({ length: 2000 }, (_, index) =>
        activity(index + 1, {
          started_at: "2026-01-01T12:00:00Z",
          ended_at: "2026-01-01T12:30:00Z",
        }),
      ),
      [],
    );

    await expect(repository.find(input)).resolves.toMatchObject({ groups: [] });
  });

  it("binds discovery effort IDs to both their user and analysis timezone", async () => {
    const { repository, query, db } = setup([activity(1), activity(2)], [identity(1), identity(2)]);
    const effortId = (await repository.find(input)).groups[0]?.effortId;
    if (!effortId) throw new Error("Expected a discovered effort ID");

    const otherUserRepository = new RepeatedEffortsRepository(db, { query }, id(99), "UTC");
    const otherTimezoneRepository = new RepeatedEffortsRepository(
      db,
      { query },
      userId,
      "America/Los_Angeles",
    );
    await expect(otherUserRepository.find({ ...input, effortId })).rejects.toThrow(
      /user or analysis timezone/,
    );
    await expect(otherTimezoneRepository.find({ ...input, effortId })).rejects.toThrow(
      /user or analysis timezone/,
    );
  });

  it("returns the conservative assumption when no valid activities exist", async () => {
    const { repository } = setup([], []);

    expect(await repository.find(input)).toEqual({
      groups: [],
      nextCursor: null,
      assumptions: [
        "Repeated efforts are not necessarily maximal tests; identity alone does not establish comparable performance or conditions.",
      ],
    });
  });

  it("keeps a merged-provider activity when any requested provider contributed", async () => {
    const { repository } = setup(
      [
        activity(1, { source_providers: ["garmin", "trainerroad"] }),
        activity(2, { source_providers: ["garmin", "trainerroad"] }),
      ],
      [identity(1), identity(2)],
    );

    const group = (await repository.find({ ...input, providers: ["trainerroad"] })).groups[0];
    expect(group).toMatchObject({
      repetitionCount: 2,
      providers: ["garmin", "trainerroad"],
      discoveryScope: { providers: ["trainerroad"] },
    });
  });

  it("excludes invalid and zero-length activities while accepting unknown end times", async () => {
    const invalidCases = [
      activity(2, { started_at: "invalid", ended_at: null }),
      activity(2, { ended_at: "2026-01-02T12:00:00Z" }),
      activity(2, { ended_at: "invalid" }),
    ];
    for (const malformed of invalidCases) {
      const { repository } = setup([activity(1), malformed], [identity(1), identity(2)]);
      expect((await repository.find(input)).groups).toEqual([]);
    }

    const { repository } = setup(
      [activity(1, { ended_at: null }), activity(2, { ended_at: null })],
      [identity(1), identity(2)],
    );
    expect((await repository.find(input)).groups[0]).toMatchObject({ repetitionCount: 2 });
  });

  it("forwards the complete bounded scope and sorted member IDs to evidence projections", async () => {
    const { repository, query } = setup(
      [
        activity(1, {
          member_activity_ids: [id(11), id(1)],
          source_providers: ["trainerroad", "apple_health"],
        }),
        activity(2),
      ],
      [identity(1, { source_activity_id: id(11) }), identity(2)],
    );

    await repository.find({
      ...input,
      providers: ["trainerroad"],
      modalities: ["indoor"],
      canonicalTypes: ["cycling"],
    });
    const identityCall = query.mock.calls.find(([, sql]) =>
      sql.includes("activity_effort_identity"),
    );
    const sourceCall = query.mock.calls.find(([, sql]) => sql.includes("activity_source_records"));
    expect(identityCall?.[2]).toEqual({
      userId,
      timezone: "UTC",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      providers: ["trainerroad"],
      modalities: ["indoor"],
      canonicalTypes: ["cycling"],
      activityIds: [id(1), id(2)],
      memberIds: [id(1), id(2), id(11)],
    });
    expect(sourceCall?.[2]).toEqual(identityCall?.[2]);
  });

  it("returns sorted unique group evidence and exact-identity defaults", async () => {
    const { repository } = setup(
      [
        activity(2, {
          canonical_type: "running",
          modality: "outdoor",
          source_providers: ["wahoo"],
        }),
        activity(1, {
          source_providers: ["trainerroad", "apple_health"],
          member_activity_ids: [id(1), id(11)],
        }),
      ],
      [identity(2), identity(1), identity(1)],
    );

    const group = (await repository.find(input)).groups[0];
    expect(group).toMatchObject({
      displayName: "Tempo",
      providers: ["apple_health", "trainerroad", "wahoo"],
      modalities: ["indoor", "outdoor"],
      canonicalTypes: ["cycling", "running"],
      canonicalActivityIds: [id(1), id(2)],
      memberActivityIds: [id(1), id(2), id(11)],
      qualityFlags: ["expected_duration_unavailable", "merged_sources"],
    });
    expect(group?.identityEvidence).toHaveLength(2);
    expect(group?.assumptions).toEqual([
      "Repeated efforts are not necessarily maximal tests; identity alone does not establish comparable performance or conditions.",
      "Expected protocol duration is unavailable in the identity projections; observed elapsed time is not a prescribed duration.",
    ]);
  });

  it("reports complete source evidence without cross-assigning unrelated rows", async () => {
    const sourceRows = [
      { source_activity_id: id(1), provider: "trainerroad", external_id: "source-one" },
      { source_activity_id: id(2), provider: "wahoo", external_id: "source-two" },
      { source_activity_id: id(99), provider: "garmin", external_id: "unrelated" },
    ];
    const { repository } = setup(
      [activity(1), activity(2, { source_providers: ["wahoo"] })],
      [identity(1), identity(2)],
      [],
      [],
      sourceRows,
    );

    const group = (await repository.find(input)).groups[0];
    expect(group?.sourceEvidence).toEqual([
      {
        canonicalActivityId: id(1),
        sourceActivityId: id(1),
        provider: "trainerroad",
        externalId: "source-one",
      },
      {
        canonicalActivityId: id(2),
        sourceActivityId: id(2),
        provider: "wahoo",
        externalId: "source-two",
      },
    ]);
    expect(group?.qualityFlags).not.toContain("source_evidence_incomplete");
  });

  it("flags a merged activity when any member lacks source evidence", async () => {
    const { repository } = setup(
      [activity(1, { member_activity_ids: [id(1), id(11)] }), activity(2)],
      [identity(1), identity(2)],
      [],
      [],
      [
        { source_activity_id: id(1), provider: "trainerroad", external_id: "one" },
        { source_activity_id: id(2), provider: "trainerroad", external_id: "two" },
        { source_activity_id: id(99), provider: "garmin", external_id: "unrelated" },
      ],
    );

    expect((await repository.find(input)).groups[0]?.qualityFlags).toEqual([
      "expected_duration_unavailable",
      "merged_sources",
      "source_evidence_incomplete",
    ]);
  });

  it("tracks first and last occurrence independent of input order", async () => {
    const { repository } = setup(
      [
        activity(1, {
          started_at: "2026-06-15T12:00:00Z",
          ended_at: "2026-06-15T12:30:00Z",
        }),
        activity(2, {
          started_at: "2026-12-01T12:00:00Z",
          ended_at: "2026-12-01T12:30:00Z",
        }),
        activity(3, {
          started_at: "2026-02-01T12:00:00Z",
          ended_at: "2026-02-01T12:30:00Z",
        }),
      ],
      [identity(1), identity(2), identity(3)],
    );

    expect((await repository.find(input)).groups[0]).toMatchObject({
      firstOccurrence: "2026-02-01T12:00:00.000Z",
      lastOccurrence: "2026-12-01T12:00:00.000Z",
    });
  });

  it("rejects identities missing reusable exact or usable weak evidence", async () => {
    const identities = [1, 2].flatMap((activityNumber) => [
      identity(activityNumber, { value: "   " }),
      identity(activityNumber, { value: "no-namespace", namespace: null }),
      identity(activityNumber, { value: "caller", strength: "caller_asserted" }),
      identity(activityNumber, {
        value: "weak",
        normalized_value: "   ",
        strength: "weak_similarity",
      }),
    ]);
    const { repository } = setup([activity(1), activity(2)], identities);

    expect((await repository.find({ ...input, equivalenceStrength: "weak" })).groups).toEqual([]);
  });

  it("treats either activity-name kind or weak strength as weak similarity", async () => {
    const identities = [1, 2].flatMap((activityNumber) => [
      identity(activityNumber, {
        kind: "activity_name",
        value: "Tempo",
        normalized_value: "tempo",
        strength: "exact",
      }),
      identity(activityNumber, {
        value: "weak-provider-workout",
        normalized_value: "tempo",
        strength: "weak_similarity",
      }),
    ]);
    const { repository } = setup([activity(1), activity(2)], identities);

    const groups = (await repository.find({ ...input, equivalenceStrength: "weak" })).groups;
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.strength === "weak_similarity")).toBe(true);
    expect(groups.every((group) => group.qualityFlags.includes("weak_identity"))).toBe(true);
  });

  it("requires a measured duration for weak similarity", async () => {
    const { repository } = setup(
      [activity(1, { ended_at: null }), activity(2, { ended_at: null })],
      [1, 2].map((activityNumber) =>
        identity(activityNumber, {
          kind: "activity_name",
          value: "Tempo",
          normalized_value: "tempo",
          strength: "exact",
        }),
      ),
    );

    expect((await repository.find({ ...input, equivalenceStrength: "weak" })).groups).toEqual([]);
  });

  it("honors an explicitly selected identity kind", async () => {
    const { repository } = setup([activity(1), activity(2)], [identity(1), identity(2)]);

    expect((await repository.find({ ...input, effortKind: "provider_route" })).groups).toEqual([]);
  });

  it("preserves accepted strongly inferred identity evidence", async () => {
    const { repository } = setup(
      [activity(1), activity(2)],
      [identity(1, { strength: "strong_inferred" }), identity(2, { strength: "strong_inferred" })],
    );

    const group = (await repository.find(input)).groups[0];
    expect(group).toMatchObject({
      strength: "strong_inferred",
      qualityFlags: ["expected_duration_unavailable", "geometry_inferred"],
    });
    expect(group?.assumptions).toContain(
      "Routes must match every member in the group using route_geometry_v1; direction and quality remain in the evidence. Geometry availability depends on the upstream route projection.",
    );
  });

  it("ignores stale benchmark memberships and preserves valid assertion notes", async () => {
    const { repository } = setup(
      [activity(1), activity(2)],
      [],
      [],
      [
        ...[1, 2].map((activityNumber) => ({
          group_id: id(50),
          canonical_activity_id: id(activityNumber),
          display_name: "Saturday test",
          notes: "Steady effort",
          inclusion_note: "Same protocol",
        })),
        {
          group_id: id(50),
          canonical_activity_id: id(99),
          display_name: "Saturday test",
          notes: "Stale",
          inclusion_note: null,
        },
      ],
    );

    const group = (await repository.find({ ...input, effortKind: "user_defined_benchmark" }))
      .groups[0];
    expect(group?.repetitionCount).toBe(2);
    expect(group?.identityEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence: { notes: "Steady effort", inclusionNote: "Same protocol" },
        }),
      ]),
    );
  });

  it("keeps distinct route groups separate and labels provider evidence conservatively", async () => {
    const route = (activityNumber: number, latitude: number, sourceProviders: string[]) => ({
      canonical_activity_id: id(activityNumber),
      points: [
        [latitude, -74],
        [latitude + 0.01, -74],
        [latitude + 0.02, -74],
      ],
      route_distance_meters: 2224,
      elevation_profile: [],
      coverage_pct: 100,
      largest_gap_seconds: 1,
      geometry_status: "available",
      source_providers: sourceProviders,
      source_devices: ["Edge 1050"],
    });
    const { repository } = setup(
      [
        activity(1, { name: "Route A" }),
        activity(2, { name: "Route A" }),
        activity(3, { name: "Route B" }),
        activity(4, { name: "Route B" }),
      ],
      [],
      [
        route(1, 40, ["garmin"]),
        route(2, 40, ["garmin", "strava"]),
        route(3, 50, []),
        route(4, 50, ["wahoo"]),
      ],
    );

    const groups = (await repository.find({ ...input, effortKind: "canonical_route" })).groups;
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.effortId)).toEqual(
      groups.map((group) => group.effortId).toSorted(),
    );
    expect(groups.map((group) => group.displayName).sort()).toEqual(["Route A", "Route B"]);
    expect(
      groups.flatMap((group) => group.identityEvidence.map((evidence) => evidence.provider)),
    ).toEqual(expect.arrayContaining(["garmin", "wahoo", null, null]));
  });

  it("does not create conflicts from identities outside canonical membership", async () => {
    const { repository } = setup(
      [activity(1), activity(2)],
      [
        identity(1),
        identity(1, { source_activity_id: id(99), value: "stale-template" }),
        identity(2),
      ],
    );

    const group = (await repository.find(input)).groups[0];
    expect(group?.qualityFlags).toEqual(["expected_duration_unavailable"]);
    expect(group?.identityEvidence.map((evidence) => evidence.value)).toEqual([
      "Template-A",
      "Template-A",
    ]);
  });

  it("returns the full discovery caveats for non-empty results", async () => {
    const { repository } = setup([activity(1), activity(2)], [identity(1), identity(2)]);

    expect((await repository.find(input)).assumptions).toEqual([
      "Repeated efforts are not necessarily maximal tests; identity alone does not establish comparable performance or conditions.",
      "Date filters use the canonical source-resolved local activity date, falling back to the analysis timezone. Discovery is bounded to 2,000 canonical activities, 250 routes and 20,000 evidence rows per projection; narrow the request if exceeded.",
      "Only explicitly selected user_defined_benchmark requests return caller assertions. Effort IDs preserve the original date, type, provider and modality scope; membership may change when source evidence changes.",
    ]);
  });
});
