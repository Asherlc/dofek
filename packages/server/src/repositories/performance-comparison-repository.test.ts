import { describe, expect, it, vi } from "vitest";
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

describe("PerformanceComparisonRepository", () => {
  it("derives a repeated provider workout identity and compares deduped cycling metrics", async () => {
    const first = activityRow();
    const second = activityRow({
      activity_id: SECOND_ID,
      started_at: "2026-07-01T17:00:00.000Z",
      ended_at: "2026-07-01T17:30:00.000Z",
      local_date: "2026-07-01",
      source_external_ids: [
        {
          providerId: "peloton",
          externalId: "workout-2",
          memberActivityId: SECOND_ID,
        },
      ],
      member_activity_ids: [SECOND_ID],
      source_raw_evidence: [
        {
          sourceActivityId: SECOND_ID,
          provider: "peloton",
          raw: { pelotonClassId: "class-abc" },
        },
      ],
    });
    const sensorStore = {
      query: vi.fn().mockResolvedValue([
        {
          activity_id: FIRST_ID,
          average_power: 180,
          normalized_power: 185,
          average_heart_rate: 145,
          max_heart_rate: 165,
          average_cadence: 88,
          distance_meters: 15_000,
          elevation_gain_meters: 0,
          average_temperature_c: 20,
          sample_source_providers: ["peloton"],
          sample_device_ids: ["bike-1"],
          sample_count: 360,
          power_sample_count: 360,
          heart_rate_sample_count: 360,
        },
        {
          activity_id: SECOND_ID,
          average_power: 195,
          normalized_power: 200,
          average_heart_rate: 143,
          max_heart_rate: 163,
          average_cadence: 90,
          distance_meters: 15_000,
          elevation_gain_meters: 0,
          average_temperature_c: 18,
          sample_source_providers: ["peloton"],
          sample_device_ids: ["bike-1"],
          sample_count: 360,
          power_sample_count: 360,
          heart_rate_sample_count: 360,
        },
      ]),
    };

    const result = await new PerformanceComparisonRepository(
      database(first, [first, second]),
      sensorStore,
      USER_ID,
      "America/Los_Angeles",
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

    expect(result.equivalence).toMatchObject({
      basis: "derived_from_reference",
      confidence: "high",
      key: { kind: "provider_workout_id", provider: "peloton", value: "class-abc" },
    });
    expect(result.baseline.activity_id).toBe(FIRST_ID);
    expect(result.performances).toHaveLength(2);
    expect(result.performances[1]).toMatchObject({
      activity_id: SECOND_ID,
      equivalence_evidence: [
        {
          evidence_type: "provider_raw_field",
          provider: "peloton",
          value: "class-abc",
          source_activity_id: SECOND_ID,
        },
      ],
      metrics: {
        cycling: {
          average_power_watts: 195,
          average_heart_rate_bpm: 143,
          power_to_heart_rate_ratio: expect.closeTo(195 / 143, 3),
        },
      },
      delta_to_baseline: {
        average_power_watts: 15,
        average_heart_rate_bpm: -2,
        average_temperature_c: -2,
      },
    });
    expect(result.coverage).toMatchObject({
      canonical_activities: 2,
      cycling_metrics_from_deduped_samples: 2,
      environment_metrics_from_deduped_samples: 2,
    });
  });

  it("rejects a reference whose underlying data has no defensible equivalence key", async () => {
    const reference = activityRow({ source_raw_evidence: [], activity_name: "Morning Ride" });
    const repository = new PerformanceComparisonRepository(
      database(reference, []),
      { query: vi.fn() },
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
      { query: vi.fn() },
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

  it("accepts an explicit Peloton class identity as high-confidence provider evidence", async () => {
    const row = activityRow();
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
        kind: "provider_workout_id",
        provider: "peloton",
        value: "class-abc",
      },
      providers: [],
      modalities: [],
      cursor: null,
      limit: 10,
    });

    expect(result.equivalence).toMatchObject({
      basis: "explicit",
      method: "exact_provider_workout_identity",
      confidence: "high",
    });
    expect(result.performances[0]?.equivalence_evidence_count).toBe(1);
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

      const result = await new PerformanceComparisonRepository(
        database(row, [row]),
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

      expect(result.equivalence).toMatchObject({
        basis: "explicit",
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
      equivalence: null,
      providers: [],
      modalities: [],
      cursor: null,
      limit: 1,
    });
    const cursor = firstPage.pagination.next_cursor;
    expect(cursor).not.toBeNull();

    const nextDb = database(first, [second]);
    nextDb.execute.mockImplementation((query: unknown) => {
      const text = queryText(query);
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
      equivalence: null,
      providers: [],
      modalities: [],
      cursor,
      limit: 1,
    });
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
        equivalence: null,
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
            activity_id: SECOND_ID,
            set_id: "00000000-0000-4000-8000-000000000103",
            set_activity_id: SECOND_ID,
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

    expect(result.equivalence).toMatchObject({ basis: "explicit", confidence: "high" });
    expect(result.performances[1]?.metrics.strength).toMatchObject({
      best_estimated_one_rep_max_kg: expect.closeTo(128.33, 2),
      valid_volume_kg_reps: 550,
      volume_status: "partial",
      estimated_one_rep_max_status: "partial",
      suspicious_sets: 1,
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
