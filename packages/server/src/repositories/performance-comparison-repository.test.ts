import { describe, expect, it, vi } from "vitest";
import {
  cyclingEffortMetricsSchema,
  performanceComparisonOutputSchema,
} from "../mcp/performance-comparison-output.ts";
import type { ComparisonIdentityRow } from "./performance-comparison-identity.ts";
import { PerformanceComparisonRepository } from "./performance-comparison-repository.ts";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const FIRST_ID = "00000000-0000-4000-8000-000000000010";
const SECOND_ID = "00000000-0000-4000-8000-000000000020";
const THIRD_ID = "00000000-0000-4000-8000-000000000030";

function queryText(query: unknown): string {
  if (typeof query !== "object" || query === null || !("queryChunks" in query)) {
    throw new Error("Expected Drizzle SQL query object");
  }
  return JSON.stringify(Reflect.get(query, "queryChunks"));
}

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    activity_id: FIRST_ID,
    canonical_type: "cycling",
    activity_name: "30 min Power Zone Endurance",
    modality: "indoor",
    started_at: "2026-06-01T17:00:00.000Z",
    ended_at: "2026-06-01T17:30:00.000Z",
    local_date: "2026-06-01",
    source_providers: ["peloton"],
    source_external_ids: [
      {
        providerId: "peloton",
        externalId: "workout-1",
        memberActivityId: FIRST_ID,
      },
    ],
    member_activity_ids: [FIRST_ID],
    timezone: "America/Los_Angeles",
    start_utc_offset_minutes: -420,
    local_time_source: "provider_timezone",
    date_was_authoritative: true,
    source_raw_evidence: [
      {
        sourceActivityId: FIRST_ID,
        provider: "peloton",
        raw: { pelotonClassId: "class-abc" },
      },
    ],
    exercise_ids: [],
    climb_identities: [],
    ...overrides,
  };
}

function database(reference: Record<string, unknown>, candidates: Record<string, unknown>[]) {
  return {
    execute: vi.fn((query: unknown) => {
      const text = queryText(query);
      if (text.includes("performance-comparison:scope")) return Promise.resolve(candidates);
      if (text.includes("performance-comparison:cycling-efforts"))
        return Promise.resolve(candidates);
      if (text.includes("sport_settings") || text.includes("activity_interval"))
        return Promise.resolve([]);
      if (text.includes("performance-comparison:reference")) return Promise.resolve([reference]);
      if (text.includes("performance-comparison:baseline"))
        return Promise.resolve(candidates.slice(0, 1));
      if (text.includes("performance-comparison:candidates")) return Promise.resolve(candidates);
      if (text.includes("performance-comparison:climbing")) return Promise.resolve([]);
      if (text.includes("performance-comparison:strength")) return Promise.resolve([]);
      throw new Error(`Unexpected query: ${text}`);
    }),
  };
}

function recordedIdentity(
  activityId: string,
  overrides: Partial<ComparisonIdentityRow> = {},
): ComparisonIdentityRow {
  return {
    canonical_activity_id: activityId,
    source_activity_id: activityId,
    source_provider: "zwift",
    source_external_id: "instance-1",
    kind: "provider_workout",
    namespace: "zwift",
    value: "template-17",
    normalized_value: "template-17",
    display_name: "Tempo",
    strength: "exact",
    method: "explicit_identity",
    source_field: "templateId",
    evidence: {},
    ...overrides,
  };
}

function routeRow(activityId: string) {
  return {
    canonical_activity_id: activityId,
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
    geometry_status: "available",
    source_providers: [activityId === FIRST_ID ? "garmin" : "wahoo"],
    source_devices: [activityId === FIRST_ID ? "edge" : "bolt"],
  };
}

function indexedActivityId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

describe("PerformanceComparisonRepository", () => {
  it.each([
    {
      kind: "provider_workout",
      conflict: { value: "template-18" },
      error: /Conflicting exact identities/,
    },
    {
      kind: "provider_workout",
      conflict: { namespace: "garmin" },
      error: /Ambiguous exact identities/,
    },
    {
      kind: "provider_route",
      conflict: { value: "template-18" },
      error: /Conflicting exact identities/,
    },
    {
      kind: "provider_route",
      conflict: { namespace: "garmin" },
      error: /Ambiguous exact identities/,
    },
  ] as const)(
    "requires explicit selection for candidate $kind ambiguity: $conflict",
    async ({ kind, conflict, error }) => {
      const reference = activityRow({ canonical_type: "running" });
      const candidate = activityRow({
        activity_id: SECOND_ID,
        canonical_type: "running",
        member_activity_ids: [SECOND_ID, THIRD_ID],
      });
      const rows = [
        recordedIdentity(FIRST_ID, { kind }),
        recordedIdentity(SECOND_ID, { kind }),
        recordedIdentity(SECOND_ID, { kind, source_activity_id: THIRD_ID, ...conflict }),
        ...(kind === "provider_route" ? [recordedIdentity(SECOND_ID)] : []),
      ];
      const repository = new PerformanceComparisonRepository(
        database(reference, [reference, candidate]),
        {
          query: vi.fn(async (_schema, text: string) =>
            text.includes("activity_effort_identity") ? rows : [],
          ),
        },
        USER_ID,
        "UTC",
      );
      const input = {
        startDate: "2026-06-01",
        endDate: "2026-07-31",
        referenceActivityId: FIRST_ID,
        equivalence: null,
        providers: [],
        modalities: [],
        cursor: null,
        limit: 25,
      };
      await expect(repository.compare(input)).rejects.toThrow(error);
      const result = await repository.compare({
        ...input,
        equivalence: { kind, provider: "zwift", value: "template-17" },
      });
      expect(result.performances[1]).toMatchObject({
        activity_id: SECOND_ID,
        identity: { identity: { kind }, strength: "exact", basis: "explicit" },
        equivalence_evidence_count: 1,
        equivalence_evidence: [
          expect.objectContaining({ value: "template-17", source_activity_id: SECOND_ID }),
        ],
      });
    },
  );

  it("preserves partial provider-route quality and provenance without claiming a geometric rejection", async () => {
    const reference = activityRow();
    const candidate = activityRow({ activity_id: SECOND_ID, member_activity_ids: [SECOND_ID] });
    const rows = [
      recordedIdentity(FIRST_ID, { kind: "provider_route" }),
      recordedIdentity(SECOND_ID, { kind: "provider_route" }),
    ];
    const routes = [FIRST_ID, SECOND_ID].map((id) => ({
      canonical_activity_id: id,
      route_fingerprint: null,
      points: [
        [37, -122],
        [37.01, -122],
      ],
      route_distance_meters: 1112,
      elevation_profile: [],
      coverage_pct: id === FIRST_ID ? 100 : 40,
      largest_gap_seconds: id === FIRST_ID ? 1 : 300,
      geometry_status: id === FIRST_ID ? "available" : "partial",
      source_providers: [id === FIRST_ID ? "garmin" : "wahoo"],
      source_devices: [id === FIRST_ID ? "edge" : "bolt"],
    }));
    const result = await new PerformanceComparisonRepository(
      database(reference, [reference, candidate]),
      {
        query: vi.fn(async (_schema, text: string) =>
          text.includes("activity_effort_identity")
            ? rows
            : text.includes("activity_route_identity")
              ? routes
              : [],
        ),
      },
      USER_ID,
      "UTC",
    ).compare({
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: FIRST_ID,
      equivalence: null,
      providers: [],
      modalities: [],
      cursor: null,
      limit: 25,
    });
    expect(result.performances[1]?.route).toMatchObject({
      status: "exact",
      geometry: null,
      geometry_unavailable_reason: expect.stringMatching(/partial/),
      quality: { geometry_status: "partial", coverage_pct: 40, largest_gap_seconds: 300 },
      anchor_quality: { geometry_status: "available", coverage_pct: 100, largest_gap_seconds: 1 },
      source_providers: ["wahoo"],
      source_devices: ["bolt"],
      anchor_activity_id: FIRST_ID,
      anchor_source_providers: ["garmin"],
      anchor_source_devices: ["edge"],
    });
    expect(result.performances[1]?.quality.flags).toContain("route_geometry_unavailable");
    expect(result.performances[1]?.quality.flags).not.toContain("route_geometry_rejected");
    expect(performanceComparisonOutputSchema.parse({ result }).result).toEqual(result);
  });

  it("derives a canonical route from reference geometry and preserves matched evidence", async () => {
    const reference = activityRow({ modality: "outdoor" });
    const candidate = activityRow({
      activity_id: SECOND_ID,
      member_activity_ids: [SECOND_ID],
      modality: "outdoor",
    });
    const db = database(reference, [reference, candidate]);
    const routes = [routeRow(FIRST_ID), routeRow(SECOND_ID)];
    const result = await new PerformanceComparisonRepository(
      db,
      {
        query: vi.fn(async (_schema, text: string) =>
          text.includes("activity_route_identity") ? routes : [],
        ),
      },
      USER_ID,
      "UTC",
    ).compare({
      discoveryActivityIds: [FIRST_ID, SECOND_ID],
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: FIRST_ID,
      equivalence: null,
      providers: [],
      modalities: ["outdoor"],
      cursor: null,
      limit: 25,
    });

    expect(result.equivalence).toMatchObject({
      basis: "derived_from_reference",
      identity: { kind: "canonical_route", value: FIRST_ID },
      strength: "strong_inferred",
    });
    expect(result.performances.map((performance) => performance.activity_id)).toEqual([
      FIRST_ID,
      SECOND_ID,
    ]);
    expect(result.performances[1]).toMatchObject({
      equivalence_evidence_count: 1,
      equivalence_evidence: [
        {
          evidence_type: "route_geometry",
          assertion_evidence: { anchor_activity_id: FIRST_ID },
        },
      ],
      route: {
        status: "strong_inferred",
        geometry: { matched: true, overlap_percentage: 1 },
        anchor_activity_id: FIRST_ID,
        source_providers: ["wahoo"],
        source_devices: ["bolt"],
      },
    });
    const scopeQuery = db.execute.mock.calls
      .map(([query]) => queryText(query))
      .find((text) => text.includes("performance-comparison:scope"));
    expect(scopeQuery).toContain("a.id");
    expect(scopeQuery).not.toContain("BETWEEN");
  });

  it("compares user-owned benchmark members with membership evidence", async () => {
    const reference = activityRow();
    const candidate = activityRow({ activity_id: SECOND_ID, member_activity_ids: [SECOND_ID] });
    const db = database(reference, [reference, candidate]);
    const original = db.execute.getMockImplementation();
    db.execute.mockImplementation((query: unknown) => {
      const text = queryText(query);
      if (text.includes("performance-comparison:benchmark")) {
        return Promise.resolve([
          {
            canonical_activity_id: FIRST_ID,
            display_name: "Controlled loop",
            notes: "Same course and protocol",
            inclusion_note: "Dry conditions",
          },
          {
            canonical_activity_id: SECOND_ID,
            display_name: "Controlled loop",
            notes: "Same course and protocol",
            inclusion_note: "Dry conditions",
          },
        ]);
      }
      if (!original) throw new Error("Missing database fixture");
      return original(query);
    });

    const result = await new PerformanceComparisonRepository(
      db,
      { query: vi.fn().mockResolvedValue([]) },
      USER_ID,
      "UTC",
    ).compare({
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: null,
      equivalence: { kind: "user_defined_benchmark", value: THIRD_ID },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 25,
    });

    expect(result.equivalence).toMatchObject({
      basis: "caller_asserted",
      identity: { kind: "user_defined_benchmark", value: THIRD_ID },
      strength: "caller_asserted",
    });
    expect(result.performances).toHaveLength(2);
    for (const performance of result.performances) {
      expect(performance).toMatchObject({
        equivalence_evidence_count: 1,
        equivalence_evidence: [
          {
            evidence_type: "user_benchmark_membership",
            assertion_evidence: {
              display_name: "Controlled loop",
              notes: "Same course and protocol",
              inclusion_note: "Dry conditions",
            },
          },
        ],
        quality: { comparable: true },
      });
    }
  });

  it("accepts 2,000 scoped activities but rejects 2,001", async () => {
    const row = activityRow();
    const maximumScope = Array.from({ length: 2000 }, (_, index) =>
      activityRow({ activity_id: indexedActivityId(index + 100) }),
    );
    const accepted = await new PerformanceComparisonRepository(
      database(row, maximumScope),
      { query: vi.fn().mockResolvedValue([]) },
      USER_ID,
      "UTC",
    ).compare({
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: null,
      equivalence: { kind: "provider_workout", provider: "zwift", value: "template-17" },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 1,
    });
    expect(accepted.performances).toHaveLength(1);

    const overBroadScope = Array.from({ length: 2001 }, (_, index) =>
      activityRow({ activity_id: indexedActivityId(index + 100) }),
    );
    await expect(
      new PerformanceComparisonRepository(
        database(row, overBroadScope),
        { query: vi.fn().mockResolvedValue([]) },
        USER_ID,
        "UTC",
      ).compare({
        startDate: "2026-06-01",
        endDate: "2026-07-31",
        referenceActivityId: null,
        equivalence: { kind: "provider_workout", provider: "zwift", value: "template-17" },
        providers: [],
        modalities: [],
        cursor: null,
        limit: 25,
      }),
    ).rejects.toThrow("Too many activities");
  });

  it("accepts 2,000 benchmark members but rejects 2,001", async () => {
    const row = activityRow();
    const db = database(row, [row]);
    const original = db.execute.getMockImplementation();
    let benchmarkMemberCount = 2000;
    db.execute.mockImplementation((query: unknown) => {
      const text = queryText(query);
      if (text.includes("performance-comparison:benchmark")) {
        return Promise.resolve(
          Array.from({ length: benchmarkMemberCount }, (_, index) => ({
            canonical_activity_id: index === 0 ? FIRST_ID : indexedActivityId(index + 100),
            display_name: "Benchmark",
            notes: null,
            inclusion_note: null,
          })),
        );
      }
      if (!original) throw new Error("Missing database fixture");
      return original(query);
    });
    const repository = new PerformanceComparisonRepository(
      db,
      { query: vi.fn().mockResolvedValue([]) },
      USER_ID,
      "UTC",
    );
    const input = {
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: null,
      equivalence: { kind: "user_defined_benchmark" as const, value: THIRD_ID },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 25,
    };
    await expect(repository.compare(input)).resolves.toMatchObject({
      performances: [expect.objectContaining({ activity_id: FIRST_ID })],
    });

    benchmarkMemberCount = 2001;
    await expect(repository.compare(input)).rejects.toThrow("Too many benchmark members");
  });

  it("distinguishes empty explicit comparisons from filtered-out references", async () => {
    const row = activityRow({ canonical_type: "running" });
    const noBaselineDatabase = database(row, [row]);
    const original = noBaselineDatabase.execute.getMockImplementation();
    noBaselineDatabase.execute.mockImplementation((query: unknown) => {
      const text = queryText(query);
      if (text.includes("performance-comparison:baseline")) return Promise.resolve([]);
      if (!original) throw new Error("Missing database fixture");
      return original(query);
    });
    const explicitInput = {
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: null,
      equivalence: { kind: "activity_name" as const, canonicalType: "running", value: "Tempo" },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 25,
    };
    await expect(
      new PerformanceComparisonRepository(
        noBaselineDatabase,
        { query: vi.fn().mockResolvedValue([]) },
        USER_ID,
        "UTC",
      ).compare(explicitInput),
    ).rejects.toThrow("No performances match");

    await expect(
      new PerformanceComparisonRepository(
        noBaselineDatabase,
        { query: vi.fn().mockResolvedValue([]) },
        USER_ID,
        "UTC",
      ).compare({ ...explicitInput, referenceActivityId: FIRST_ID }),
    ).rejects.toThrow("reference activity does not match");
  });

  it.each([99, 100, 101])(
    "preserves total count and truncation for %i legacy source records",
    async (count) => {
      const sources = Array.from({ length: count }, (_, index) => ({
        sourceActivityId: `00000000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}`,
        provider: "strava",
        providerType: "outdoor_ride",
        sourceActivityName: "Morning ride",
        raw: {},
      }));
      const row = activityRow({
        member_activity_ids: sources.map((source) => source.sourceActivityId),
        source_raw_evidence: sources,
      });
      const result = await new PerformanceComparisonRepository(
        database(row, [row]),
        { query: vi.fn().mockResolvedValue([]) },
        USER_ID,
        "UTC",
      ).compare({
        startDate: "2026-06-01",
        endDate: "2026-07-31",
        referenceActivityId: null,
        equivalence: {
          kind: "cycling_route",
          provider: "strava",
          activityName: "Morning ride",
          providerType: "outdoor_ride",
        },
        providers: [],
        modalities: [],
        cursor: null,
        limit: 25,
      });
      expect(result.performances[0]).toMatchObject({
        equivalence_evidence_count: count,
        equivalence_evidence_truncated: count === 101,
      });
      expect(result.performances[0]?.equivalence_evidence).toHaveLength(count === 99 ? 99 : 100);
      expect(performanceComparisonOutputSchema.parse({ result }).result).toEqual(result);
    },
  );

  it.each([
    ["provider_workout", "exact"],
    ["provider_route", "exact"],
    ["segment", "exact"],
    ["climb", "exact"],
    ["standardized_test", "exact"],
  ] as const)(
    "returns %s identity evidence without promoting its confidence",
    async (kind, strength) => {
      const row = activityRow({ canonical_type: "running" });
      const store = {
        query: vi.fn(async (_schema, text: string) =>
          text.includes("activity_effort_identity")
            ? [
                {
                  canonical_activity_id: FIRST_ID,
                  source_activity_id: FIRST_ID,
                  source_provider: "zwift",
                  source_external_id: "instance-1",
                  kind,
                  namespace: "zwift",
                  value: "template-17",
                  normalized_value: "template-17",
                  display_name: "Tempo",
                  strength,
                  method: "explicit_identity",
                  source_field: "templateId",
                  evidence: { rawValue: "template-17" },
                },
              ]
            : [],
        ),
      };
      const result = await new PerformanceComparisonRepository(
        database(row, [row]),
        store,
        USER_ID,
        "UTC",
      ).compare({
        startDate: "2026-06-01",
        endDate: "2026-07-31",
        referenceActivityId: FIRST_ID,
        equivalence: null,
        providers: [],
        modalities: [],
        cursor: null,
        limit: 25,
      });
      expect(result.equivalence).toMatchObject({
        strength: "exact",
        basis: "derived_from_reference",
        identity: { kind, namespace: "zwift", value: "template-17" },
      });
      expect(result.performances[0]).toMatchObject({
        identity: { strength: "exact" },
        equivalence_evidence: [
          expect.objectContaining({ provider: "zwift", source_activity_id: FIRST_ID }),
        ],
      });
    },
  );

  it("labels normalized-name comparisons as caller assertions", async () => {
    const row = activityRow({ canonical_type: "running" });
    const result = await new PerformanceComparisonRepository(
      database(row, [row]),
      { query: vi.fn().mockResolvedValue([]) },
      USER_ID,
      "UTC",
    ).compare({
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: null,
      equivalence: { kind: "activity_name", canonicalType: "running", value: "Tempo" },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 25,
    });
    expect(result.equivalence).toMatchObject({
      basis: "caller_asserted",
      strength: "caller_asserted",
    });
    expect(result.performances[0]?.quality.flags).toContain("caller_asserted_equivalence");
  });

  it("keeps names without caller assertion weak and does not declare them comparable", async () => {
    const row = activityRow({ canonical_type: "running" });
    const result = await new PerformanceComparisonRepository(
      database(row, [row]),
      { query: vi.fn().mockResolvedValue([]) },
      USER_ID,
      "UTC",
    ).compare({
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: null,
      equivalence: {
        kind: "activity_name",
        canonicalType: "running",
        value: "Tempo",
        asserted: false,
      },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 25,
    });
    expect(result.equivalence).toMatchObject({ strength: "weak_similarity", confidence: "low" });
    expect(result.performances[0]?.quality).toMatchObject({
      comparable: false,
      flags: ["weak_similarity_equivalence"],
    });
    expect(performanceComparisonOutputSchema.parse({ result }).result).toEqual(result);
  });

  it("loads a bounded complete cycling bundle for future comparison without using a current FTP", async () => {
    const row = activityRow();
    const db = database(row, [row]);
    const original = db.execute.getMockImplementation();
    db.execute.mockImplementation((query: unknown) => {
      const text = queryText(query);
      if (text.includes("sport_settings") || text.includes("activity_interval"))
        return Promise.resolve([]);
      if (!original) throw new Error("Missing database fixture");
      return original(query);
    });
    const query = vi.fn(async (_schema, text: string) => {
      if (text.includes("cycling-training-metrics:samples"))
        return Array.from({ length: 1800 }, (_, i) => ({
          activity_id: FIRST_ID,
          elapsed_seconds: i,
          power: 210,
          heart_rate: 140,
          cadence: 90,
          source_providers: ["sensor"],
          source_devices: ["meter"],
          power_measurement_kinds: ["direct"],
          stream_evidence: [
            ["power", "sensor", "meter", "direct"],
            ["heart_rate", "sensor", "meter", "direct"],
            ["cadence", "sensor", "meter", "direct"],
          ],
        }));
      return [];
    });
    const repository = new PerformanceComparisonRepository(
      db,
      { query },
      USER_ID,
      "America/Los_Angeles",
    );
    const [effort] = await repository.cyclingEfforts([FIRST_ID], [300]);
    expect(cyclingEffortMetricsSchema.parse(effort?.metrics)).toEqual(effort?.metrics);
    expect(effort).toMatchObject({
      activityId: FIRST_ID,
      metrics: {
        workout: { power: { averageWatts: 210, workKilojoules: 378, intensityFactor: null } },
        thresholds: { ftp: null },
        provenance: { sourceDevices: ["meter"] },
      },
    });
    await expect(
      repository.cyclingEfforts(
        Array.from({ length: 26 }, () => FIRST_ID),
        [300],
      ),
    ).rejects.toThrow(/25/);
    const callsBeforeEmptyRequest = db.execute.mock.calls.length;
    await expect(repository.cyclingEfforts([], [300])).resolves.toEqual([]);
    expect(db.execute).toHaveBeenCalledTimes(callsBeforeEmptyRequest);
  });

  it("rejects a mixed cycling and non-cycling batch from the metric entry point", async () => {
    const cycling = activityRow();
    const running = activityRow({
      activity_id: SECOND_ID,
      canonical_type: "running",
      member_activity_ids: [SECOND_ID],
    });

    await expect(
      new PerformanceComparisonRepository(
        database(cycling, [cycling, running]),
        { query: vi.fn().mockResolvedValue([]) },
        USER_ID,
        "UTC",
      ).cyclingEfforts([FIRST_ID, SECOND_ID], [300]),
    ).rejects.toThrow("canonical cycling activities");
  });

  it("batches comparison cycling metrics in groups of 25 with standard durations", async () => {
    const activities = Array.from({ length: 26 }, (_, index) =>
      activityRow({
        activity_id: indexedActivityId(index + 100),
        member_activity_ids: [indexedActivityId(index + 100)],
      }),
    );
    const sampleBatches: string[][] = [];
    const requestedDurations: number[][] = [];
    const query = vi.fn(
      async (
        _schema: unknown,
        text: string,
        parameters: { activityIds: string[]; durations?: number[] },
      ) => {
        if (text.includes("cycling-training-metrics:samples")) {
          sampleBatches.push(parameters.activityIds);
        }
        if (text.includes("cycling-training-metrics:power-curve")) {
          requestedDurations.push(parameters.durations ?? []);
        }
        return [];
      },
    );

    const result = await new PerformanceComparisonRepository(
      database(activities[0] ?? activityRow(), activities),
      { query },
      USER_ID,
      "UTC",
    ).compare({
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: null,
      equivalence: {
        kind: "activity_name",
        canonicalType: "cycling",
        value: "30 min Power Zone Endurance",
      },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 26,
    });

    expect(result.performances).toHaveLength(26);
    expect(sampleBatches.map((activityIds) => activityIds.length)).toEqual([25, 1]);
    expect(requestedDurations).toEqual([
      [5, 60, 300, 1200],
      [5, 60, 300, 1200],
    ]);
  });

  it("loads cycling activity references once and skips incomplete durations without hiding valid efforts", async () => {
    const complete = activityRow();
    const incomplete = activityRow({
      activity_id: SECOND_ID,
      ended_at: null,
      member_activity_ids: [SECOND_ID],
    });
    let referenceIndex = 0;
    const execute = vi.fn((query: unknown) => {
      const text = queryText(query);
      if (text.includes("performance-comparison:cycling-efforts")) {
        return Promise.resolve([complete, incomplete]);
      }
      if (text.includes("performance-comparison:reference")) {
        return Promise.resolve([[complete, incomplete][referenceIndex++]]);
      }
      if (text.includes("sport_settings") || text.includes("activity_interval")) {
        return Promise.resolve([]);
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const query = vi.fn(async (_schema, text: string) => {
      if (!text.includes("cycling-training-metrics:samples")) return [];
      return Array.from({ length: 1800 }, (_, elapsed_seconds) => ({
        activity_id: FIRST_ID,
        elapsed_seconds,
        power: 210,
        heart_rate: 140,
        cadence: 90,
        source_providers: ["sensor"],
        source_devices: ["meter"],
        power_measurement_kinds: ["direct"],
        stream_evidence: [
          ["power", "sensor", "meter", "direct"],
          ["heart_rate", "sensor", "meter", "direct"],
          ["cadence", "sensor", "meter", "direct"],
        ],
      }));
    });

    const result = await new PerformanceComparisonRepository(
      { execute },
      { query },
      USER_ID,
      "UTC",
    ).cyclingEfforts([FIRST_ID, SECOND_ID], [300]);

    expect(result.map((effort) => effort.activityId)).toEqual([FIRST_ID]);
    expect(
      execute.mock.calls.filter(([query]) =>
        queryText(query).includes("performance-comparison:cycling-efforts"),
      ),
    ).toHaveLength(1);
    expect(
      execute.mock.calls.filter(([query]) =>
        queryText(query).includes("performance-comparison:reference"),
      ),
    ).toHaveLength(0);
  });

  it("rejects a cycling reference batch when any requested activity is unavailable", async () => {
    const complete = activityRow();
    let referenceIndex = 0;
    const execute = vi.fn((query: unknown) => {
      const text = queryText(query);
      if (text.includes("performance-comparison:cycling-efforts")) {
        return Promise.resolve([complete]);
      }
      if (text.includes("performance-comparison:reference")) {
        referenceIndex += 1;
        return Promise.resolve(referenceIndex === 1 ? [complete] : []);
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      new PerformanceComparisonRepository(
        { execute },
        { query: vi.fn().mockResolvedValue([]) },
        USER_ID,
        "UTC",
      ).cyclingEfforts([FIRST_ID, SECOND_ID], [300]),
    ).rejects.toThrow("A requested cycling activity was not found for this user");
    expect(referenceIndex).toBe(0);
  });

  it("compares shared sample-derived cycling metrics with explicit unavailable reasons and provenance", async () => {
    const first = activityRow();
    const second = activityRow({ activity_id: SECOND_ID, member_activity_ids: [SECOND_ID] });
    const query = vi.fn(async (_schema, text: string) => {
      if (text.includes("cycling-training-metrics:samples"))
        return [FIRST_ID, SECOND_ID].flatMap((id, index) =>
          Array.from({ length: 1800 }, (_, elapsed_seconds) => ({
            activity_id: id,
            elapsed_seconds,
            power: index === 0 ? 180 : 195,
            heart_rate: index === 0 ? 145 : 143,
            cadence: 90,
            source_providers: ["zwift"],
            source_devices: ["meter"],
            power_measurement_kinds: ["direct"],
            stream_evidence: [
              ["power", "zwift", "meter", "direct"],
              ["heart_rate", "zwift", "hr", "direct"],
            ],
          })),
        );
      if (text.includes("cycling-effort:movement-samples")) {
        return [FIRST_ID, SECOND_ID].flatMap((id, index) =>
          Array.from({ length: 1800 }, (_, elapsed_seconds) => ({
            activity_id: id,
            elapsed_seconds,
            channel: "temperature",
            scalar: index === 0 ? 20 : 21,
            provider_id: "weather-sensor",
            device_id: "thermometer",
            measurement_kind: "direct",
          })),
        );
      }
      return [];
    });
    const result = await new PerformanceComparisonRepository(
      database(first, [first, second]),
      { query },
      USER_ID,
      "UTC",
    ).compare({
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: null,
      equivalence: { kind: "activity_name", canonicalType: "cycling", value: first.activity_name },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 10,
    });
    expect(performanceComparisonOutputSchema.parse({ result }).result).toEqual(result);
    expect(result.coverage.cycling_metrics_from_deduped_samples).toBe(2);
    expect(result.coverage.environment_metrics_from_deduped_samples).toBe(2);
    expect(result.performances[1]?.provenance.sample_device_ids).toEqual(["meter", "thermometer"]);
    expect(result.performances[1]?.provenance.sample_source_providers).toEqual([
      "weather-sensor",
      "zwift",
    ]);
    expect(result.performances[1]).toMatchObject({
      metrics: {
        cycling: {
          average_power_watts: 195,
          normalized_power_watts: 195,
          average_heart_rate_bpm: 143,
          max_heart_rate_bpm: 143,
          average_cadence_rpm: 90,
          power_to_heart_rate_ratio: expect.closeTo(195 / 143, 3),
          distance_meters: null,
          elevation_gain_meters: null,
          sample_coverage: {
            power_samples: 1800,
            heart_rate_samples: 1800,
            status: "available",
          },
        },
        cycling_effort: {
          workout: { power: { averageWatts: 195, intensityFactor: null } },
          thresholds: { ftp: null },
          provenance: { sourceDevices: ["meter", "thermometer"] },
          bestPowerInterpretation: { maximalTest: false },
          unavailableReasons: expect.arrayContaining([
            expect.objectContaining({ metric: "intensity_factor" }),
          ]),
        },
        environment: { average_temperature_c: 21, status: "available" },
      },
      delta_to_baseline: { average_power_watts: 15, average_heart_rate_bpm: -2 },
    });
  });

  it("rejects a reference whose underlying data has no defensible equivalence key", async () => {
    const reference = activityRow({ source_raw_evidence: [], activity_name: "Morning Ride" });
    const repository = new PerformanceComparisonRepository(
      database(reference, []),
      { query: vi.fn().mockResolvedValue([]) },
      USER_ID,
      "UTC",
    );

    await expect(
      repository.compare({
        startDate: "2026-06-01",
        endDate: "2026-07-31",
        referenceActivityId: FIRST_ID,
        equivalence: null,
        providers: [],
        modalities: [],
        cursor: null,
        limit: 10,
      }),
    ).rejects.toThrow("explicit equivalence key");
  });

  it("does not infer a verified workout identity from an unsupported generic raw field", async () => {
    const reference = activityRow({
      source_raw_evidence: [
        {
          sourceActivityId: FIRST_ID,
          provider: "wahoo",
          raw: { id: "template-1" },
        },
      ],
    });
    const repository = new PerformanceComparisonRepository(
      database(reference, []),
      { query: vi.fn().mockResolvedValue([]) },
      USER_ID,
      "UTC",
    );

    await expect(
      repository.compare({
        startDate: "2026-06-01",
        endDate: "2026-07-31",
        referenceActivityId: FIRST_ID,
        equivalence: null,
        providers: [],
        modalities: [],
        cursor: null,
        limit: 10,
      }),
    ).rejects.toThrow("explicit equivalence key");
  });

  it.each([
    {
      label: "climb",
      row: activityRow({
        canonical_type: "climbing",
        source_raw_evidence: [],
        climb_identities: [
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "v6",
            routeName: "blue arete",
            locationName: "the gym",
            lead: null,
          },
        ],
      }),
      expectedKind: "climb",
      expectedMethod: "exact_climb_location_route_grade_identity",
    },
    {
      label: "strength exercise",
      row: activityRow({
        canonical_type: "strength",
        source_raw_evidence: [],
        exercise_ids: [THIRD_ID],
      }),
      expectedKind: "strength_exercise_id",
      expectedMethod: "exact_normalized_strength_exercise_identity",
    },
  ])(
    "derives a single exact $label identity from the reference",
    async ({ row, expectedKind, expectedMethod }) => {
      const result = await new PerformanceComparisonRepository(
        database(row, [row]),
        { query: vi.fn().mockResolvedValue([]) },
        USER_ID,
        "UTC",
      ).compare({
        startDate: "2026-06-01",
        endDate: "2026-07-31",
        referenceActivityId: FIRST_ID,
        equivalence: null,
        providers: [],
        modalities: [],
        cursor: null,
        limit: 10,
      });

      expect(result).toMatchSnapshot();
      expect(result.equivalence).toMatchObject({
        basis: "derived_from_reference",
        confidence: "high",
        method: expectedMethod,
        key: { kind: expectedKind },
      });
    },
  );

  it("retains missing duration and timezone quality with an unavailable cycling bundle", async () => {
    const row = activityRow({
      ended_at: null,
      local_time_source: "unknown",
      date_was_authoritative: false,
    });
    const result = await new PerformanceComparisonRepository(
      database(row, [row]),
      { query: vi.fn().mockResolvedValue([]) },
      USER_ID,
      "UTC",
    ).compare({
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: null,
      equivalence: { kind: "activity_name", canonicalType: "cycling", value: row.activity_name },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 10,
    });
    expect(result.performances[0]).toMatchObject({
      duration_seconds: null,
      metrics: {
        cycling_effort: null,
        cycling_effort_unavailable_reason: expect.stringContaining("elapsed duration"),
      },
      quality: {
        flags: expect.arrayContaining([
          "duration_unavailable",
          "timezone_assumed_from_analysis_context",
        ]),
      },
    });
    expect(result.coverage.activities_with_missing_duration).toBe(1);
  });

  it.each([
    {
      label: "cycling route",
      equivalence: {
        kind: "cycling_route" as const,
        provider: "strava",
        activityName: "Morning ride",
        providerType: "outdoor_ride",
      },
      raw: {},
      sourceActivityName: "Morning ride",
      providerType: "outdoor_ride",
      expectedMethod: "caller_asserted_cycling_route_name_provider_type",
    },
    {
      label: "standardized test",
      equivalence: {
        kind: "standardized_test" as const,
        provider: "wahoo",
        activityName: "20 minute FTP test",
        providerType: "cycling_test",
      },
      raw: {},
      sourceActivityName: "20 minute FTP test",
      providerType: "cycling_test",
      expectedMethod: "caller_asserted_standardized_test_name_provider_type",
    },
    {
      label: "activity name",
      equivalence: {
        kind: "activity_name" as const,
        canonicalType: "cycling",
        value: "30 min Power Zone Endurance",
      },
      raw: {},
      expectedMethod: "exact_normalized_activity_name",
    },
  ])(
    "supports the explicit $label equivalence branch",
    async ({ equivalence, raw, expectedMethod, sourceActivityName, providerType }) => {
      const provider = "provider" in equivalence ? equivalence.provider : "peloton";
      const row = activityRow({
        source_providers: [provider],
        source_raw_evidence: [
          {
            sourceActivityId: FIRST_ID,
            provider,
            providerType: providerType ?? "cycling",
            sourceActivityName: sourceActivityName ?? "30 min Power Zone Endurance",
            raw,
          },
        ],
      });
      const db = database(row, [row]);

      const result = await new PerformanceComparisonRepository(
        db,
        { query: vi.fn().mockResolvedValue([]) },
        USER_ID,
        "UTC",
      ).compare({
        startDate: "2026-06-01",
        endDate: "2026-07-31",
        referenceActivityId: null,
        equivalence,
        providers: [],
        modalities: [],
        cursor: null,
        limit: 10,
      });

      expect(result).toMatchSnapshot();
      expect(db.execute.mock.calls.map(([query]) => queryText(query))).toMatchSnapshot();
      expect(result.equivalence).toMatchObject({
        basis: "caller_asserted",
        method: expectedMethod,
        confidence: "user_asserted",
      });
      expect(result.performances[0]?.equivalence_evidence_count).toBe(1);
      if (equivalence.kind === "cycling_route") {
        expect(result.performances[0]?.route).toMatchObject({
          status: "caller_asserted",
          provider: "strava",
          activity_name: "30 min Power Zone Endurance",
          provider_type: "outdoor_ride",
        });
      }
    },
  );

  it("binds cursors to the reference and continues by keyset even when the cursor row is absent", async () => {
    const first = activityRow();
    const second = activityRow({
      activity_id: SECOND_ID,
      started_at: "2026-07-01T17:00:00.000Z",
      ended_at: "2026-07-01T17:30:00.000Z",
      local_date: "2026-07-01",
      member_activity_ids: [SECOND_ID],
      source_raw_evidence: [
        {
          sourceActivityId: SECOND_ID,
          provider: "peloton",
          raw: { pelotonClassId: "class-abc" },
        },
      ],
    });
    const firstPage = await new PerformanceComparisonRepository(
      database(first, [first, second]),
      { query: vi.fn().mockResolvedValue([]) },
      USER_ID,
      "UTC",
    ).compare({
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: FIRST_ID,
      equivalence: {
        kind: "activity_name",
        canonicalType: "cycling",
        value: "30 min Power Zone Endurance",
      },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 1,
    });
    expect(firstPage).toMatchSnapshot();
    const cursor = firstPage.pagination.next_cursor;
    expect(cursor).not.toBeNull();

    const nextDb = database(first, [second]);
    nextDb.execute.mockImplementation((query: unknown) => {
      const text = queryText(query);
      if (text.includes("sport_settings") || text.includes("activity_interval"))
        return Promise.resolve([]);
      if (text.includes("performance-comparison:reference")) return Promise.resolve([first]);
      if (text.includes("performance-comparison:baseline")) return Promise.resolve([first]);
      if (text.includes("performance-comparison:candidates")) return Promise.resolve([second]);
      if (text.includes("performance-comparison:climbing")) return Promise.resolve([]);
      if (text.includes("performance-comparison:strength")) return Promise.resolve([]);
      throw new Error(`Unexpected query: ${text}`);
    });
    const nextPage = await new PerformanceComparisonRepository(
      nextDb,
      { query: vi.fn().mockResolvedValue([]) },
      USER_ID,
      "UTC",
    ).compare({
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: FIRST_ID,
      equivalence: {
        kind: "activity_name",
        canonicalType: "cycling",
        value: "30 min Power Zone Endurance",
      },
      providers: [],
      modalities: [],
      cursor,
      limit: 1,
    });
    expect(nextPage).toMatchSnapshot();
    expect(nextPage.performances.map((item) => item.activity_id)).toEqual([SECOND_ID]);
    const candidateQuery = nextDb.execute.mock.calls
      .map(([query]) => queryText(query))
      .find((text) => text.includes("performance-comparison:candidates"));
    expect(candidateQuery).toContain("started_at");
    expect(candidateQuery).toContain(">");

    const otherReference = activityRow({ activity_id: THIRD_ID, member_activity_ids: [THIRD_ID] });
    await expect(
      new PerformanceComparisonRepository(
        database(otherReference, [otherReference]),
        { query: vi.fn().mockResolvedValue([]) },
        USER_ID,
        "UTC",
      ).compare({
        startDate: "2026-06-01",
        endDate: "2026-07-31",
        referenceActivityId: THIRD_ID,
        equivalence: {
          kind: "activity_name",
          canonicalType: "cycling",
          value: "30 min Power Zone Endurance",
        },
        providers: [],
        modalities: [],
        cursor,
        limit: 1,
      }),
    ).rejects.toThrow("cursor does not match this query");
  });

  it("uses an explicit normalized strength exercise identity and excludes suspicious sets", async () => {
    const exerciseId = "00000000-0000-4000-8000-000000000030";
    const first = activityRow({
      canonical_type: "strength",
      activity_name: "Bench",
      exercise_ids: [exerciseId],
      source_raw_evidence: [],
    });
    const second = activityRow({
      activity_id: SECOND_ID,
      canonical_type: "strength",
      activity_name: "Bench",
      local_date: "2026-07-01",
      started_at: "2026-07-01T17:00:00.000Z",
      ended_at: "2026-07-01T18:00:00.000Z",
      exercise_ids: [exerciseId],
      source_raw_evidence: [],
    });
    const db = database(first, [first, second]);
    db.execute.mockImplementation((query: unknown) => {
      const text = queryText(query);
      if (text.includes("performance-comparison:baseline")) return Promise.resolve([first]);
      if (text.includes("performance-comparison:candidates"))
        return Promise.resolve([first, second]);
      if (text.includes("performance-comparison:climbing")) return Promise.resolve([]);
      if (text.includes("performance-comparison:strength")) {
        return Promise.resolve([
          {
            activity_id: FIRST_ID,
            set_id: "00000000-0000-4000-8000-000000000101",
            set_activity_id: FIRST_ID,
            set_provider: "hevy",
            exercise_id: exerciseId,
            exercise_index: 0,
            set_index: 0,
            set_type: "working",
            weight_kg: 100,
            reps: 5,
            rpe: 8,
          },
          {
            activity_id: SECOND_ID,
            set_id: "00000000-0000-4000-8000-000000000102",
            set_activity_id: SECOND_ID,
            set_provider: "hevy",
            exercise_id: exerciseId,
            exercise_index: 0,
            set_index: 0,
            set_type: "working",
            weight_kg: 110,
            reps: 5,
            rpe: 9,
          },
          {
            activity_id: FIRST_ID,
            set_id: "00000000-0000-4000-8000-000000000103",
            set_activity_id: FIRST_ID,
            set_provider: "hevy",
            exercise_id: exerciseId,
            exercise_index: 0,
            set_index: 1,
            set_type: "working",
            weight_kg: 5,
            reps: 140,
            rpe: 7,
          },
        ]);
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    const result = await new PerformanceComparisonRepository(
      db,
      { query: vi.fn().mockResolvedValue([]) },
      USER_ID,
      "UTC",
    ).compare({
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: null,
      equivalence: { kind: "strength_exercise_id", exerciseId },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 10,
    });

    expect(result).toMatchSnapshot();
    expect(result.equivalence).toMatchObject({ basis: "explicit", confidence: "high" });
    expect(result.performances[0]?.metrics.strength).toMatchObject({
      valid_volume_kg_reps: 500,
      volume_status: "partial",
      estimated_one_rep_max_status: "partial",
      suspicious_sets: 1,
    });
    expect(result.performances[1]?.metrics.strength).toMatchObject({
      best_estimated_one_rep_max_kg: expect.closeTo(128.33, 2),
      valid_volume_kg_reps: 550,
      volume_status: "complete",
      estimated_one_rep_max_status: "complete",
      suspicious_sets: 0,
    });
    expect(result.performances[1]?.delta_to_baseline).toMatchObject({
      strength_volume_kg_reps: null,
      strength_estimated_one_rep_max_kg: null,
    });
  });

  it("compares an exact climb identity without producing deltas from incomplete attempts", async () => {
    const identity = {
      kind: "climb" as const,
      climbType: "boulder",
      gradeSystem: "v_scale",
      grade: "V6",
      routeName: "Blue Arete",
      locationName: "The Gym",
      lead: null,
    };
    const first = activityRow({
      canonical_type: "climbing",
      activity_name: "Bouldering",
      source_providers: ["kaya"],
      source_raw_evidence: [],
    });
    const second = activityRow({
      activity_id: SECOND_ID,
      canonical_type: "climbing",
      activity_name: "Bouldering",
      started_at: "2026-07-01T17:00:00.000Z",
      ended_at: "2026-07-01T18:00:00.000Z",
      local_date: "2026-07-01",
      source_providers: ["kaya"],
      member_activity_ids: [SECOND_ID],
      source_raw_evidence: [],
    });
    const db = database(first, [first, second]);
    db.execute.mockImplementation((query: unknown) => {
      const text = queryText(query);
      if (text.includes("performance-comparison:baseline")) return Promise.resolve([first]);
      if (text.includes("performance-comparison:candidates"))
        return Promise.resolve([first, second]);
      if (text.includes("performance-comparison:climbing")) {
        return Promise.resolve([
          {
            activity_id: FIRST_ID,
            entry_id: "00000000-0000-4000-8000-000000000201",
            entry_activity_id: FIRST_ID,
            entry_provider: "kaya",
            external_id: "problem-1",
            climb_type: "boulder",
            grade_system: "v_scale",
            grade: "V6",
            sent: null,
            attempt_count: null,
            lead: null,
            wall_angle_degrees: 30,
            route_name: "Blue Arete",
            location_name: "The Gym",
          },
          {
            activity_id: SECOND_ID,
            entry_id: "00000000-0000-4000-8000-000000000202",
            entry_activity_id: SECOND_ID,
            entry_provider: "kaya",
            external_id: "problem-1",
            climb_type: "boulder",
            grade_system: "v_scale",
            grade: "V6",
            sent: true,
            attempt_count: 2,
            lead: null,
            wall_angle_degrees: 30,
            route_name: "Blue Arete",
            location_name: "The Gym",
          },
        ]);
      }
      if (text.includes("performance-comparison:strength")) return Promise.resolve([]);
      throw new Error(`Unexpected query: ${text}`);
    });

    const result = await new PerformanceComparisonRepository(
      db,
      { query: vi.fn().mockResolvedValue([]) },
      USER_ID,
      "UTC",
    ).compare({
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: null,
      equivalence: identity,
      providers: [],
      modalities: [],
      cursor: null,
      limit: 10,
    });

    expect(result).toMatchSnapshot();
    expect(result.equivalence).toMatchObject({
      confidence: "high",
      method: "exact_climb_location_route_grade_identity",
    });
    expect(result.performances[1]).toMatchObject({
      equivalence_evidence_count: 1,
      metrics: {
        climbing: {
          attempts: 2,
          attempts_status: "complete",
          sends: 1,
          outcomes_status: "complete",
        },
      },
      delta_to_baseline: { climbing_attempts: null, climbing_sends: null },
    });
    expect(result.equivalence.key).toMatchObject({ kind: "climb", lead: null });
    const candidateQuery = db.execute.mock.calls
      .map(([query]) => queryText(query))
      .find((text) => text.includes("performance-comparison:candidates"));
    expect(candidateQuery).toContain("lead");
  });
});
