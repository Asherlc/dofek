import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { StrengthProgressionRepository } from "./strength-progression-repository.ts";

describe("StrengthProgressionRepository database semantics", () => {
  const userId = randomUUID();
  const primaryProvider = "strong-csv";
  const mirrorProvider = `strength-mirror-${randomUUID()}`;
  const firstActivity = randomUUID();
  const mirrorActivity = randomUUID();
  const latestActivity = randomUUID();
  const priorActivity = randomUUID();
  const benchExercise = randomUUID();
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}::uuid, 'Strength progression fixture')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES
        (${primaryProvider}, 'Primary strength fixture', ${userId}::uuid),
        (${mirrorProvider}, 'Mirror strength fixture', ${userId}::uuid)
      ON CONFLICT (id) DO NOTHING
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.exercise (
        id, name, muscle_groups, equipment, exercise_type, movement
      ) VALUES (
        ${benchExercise}::uuid, 'Bench Press', ARRAY['CHEST'], 'Barbell',
        'STRENGTH', 'push'
      )
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, name, source_name, raw, timezone,
        start_utc_offset_minutes, end_utc_offset_minutes, local_time_source
      ) VALUES
        (${priorActivity}::uuid, ${priorActivity}::uuid, ${primaryProvider}, ${userId}::uuid, 'prior-session',
          'strength', 'strength_training', '2026-04-01T18:00:00Z',
          '2026-04-01T19:00:00Z', 'Earlier bench', 'Strong', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'device_timezone'),
        (${firstActivity}::uuid, ${firstActivity}::uuid, ${primaryProvider}, ${userId}::uuid, 'first-session',
          'strength', 'strength_training', '2026-05-01T18:00:00Z',
          '2026-05-01T19:00:00Z', 'Bench baseline', 'Strong', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'device_timezone'),
        (${mirrorActivity}::uuid, ${firstActivity}::uuid, ${mirrorProvider}, ${userId}::uuid, 'first-session-mirror',
          'strength', 'weightlifting', '2026-05-01T18:00:00Z',
          '2026-05-01T19:00:00Z', 'Bench baseline mirror', 'WHOOP', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${latestActivity}::uuid, ${latestActivity}::uuid, ${primaryProvider}, ${userId}::uuid, 'latest-session',
          'strength', 'strength_training', '2026-07-01T18:00:00Z',
          '2026-07-01T19:00:00Z', 'Bench progression', 'Strong', '{}'::jsonb,
          NULL, NULL, NULL, 'unknown')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.strength_set (
        activity_id, exercise_id, exercise_index, set_index, set_type,
        weight_kg, reps, rpe, raw
      ) VALUES
        (${priorActivity}::uuid, ${benchExercise}::uuid, 0, 0, 'working',
          90, 5, 8, '{"weight":90,"setTag":"Failure","exerciseName":"Bench Press (Barbell)","reportedWeightUnit":"kg","weightUnit":"kg","reps":5,"rpe":8}'::jsonb),
        (${firstActivity}::uuid, ${benchExercise}::uuid, 0, 0, 'working',
          100, 5, 8, '{"weight":100,"setTag":"Failure","exerciseName":"Bench Press (Barbell)","reportedWeightUnit":"kg","weightUnit":"kg","reps":5,"rpe":8}'::jsonb),
        (${mirrorActivity}::uuid, ${benchExercise}::uuid, 0, 0, 'working',
          100, 5, 8, '{"weight_kg":100,"number_of_reps":5,"complete":true}'::jsonb),
        (${latestActivity}::uuid, ${benchExercise}::uuid, 0, 0, 'warmup',
          60, 5, NULL, '{"weight":60,"weightUnit":"kg","reps":5}'::jsonb),
        (${latestActivity}::uuid, ${benchExercise}::uuid, 0, 1, 'working',
          110, 5, 9, '{"weight":110,"setTag":"Failure","exerciseName":"Bench Press (Barbell)","reportedWeightUnit":"kg","weightUnit":"kg","reps":5,"rpe":9}'::jsonb),
        (${latestActivity}::uuid, ${benchExercise}::uuid, 0, 2, 'working',
          4.989512, 140, 7, '{"weight":11,"weightUnit":"lbs","reps":140,"rpe":7}'::jsonb)
    `);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  it("deduplicates provider overlap and computes named e1RM, volume, and PR evidence", async () => {
    const result = await new StrengthProgressionRepository(context.db, userId, "UTC").listRange({
      startDate: "2026-05-01",
      endDate: "2026-07-01",
      providers: [],
      exerciseIds: [],
      cursor: null,
      limit: 100,
    });

    expect(result.definitions).toMatchObject({
      estimated_one_rep_max: expect.stringContaining("Epley"),
      volume: expect.stringContaining("weight_kg × repetitions"),
    });
    expect(result.coverage).toMatchObject({
      sessions: 2,
      source_sets: 5,
      sets: 4,
      merged_exact_duplicate_records: 1,
      flagged_sets: 1,
      sets_excluded_from_volume: 2,
      sets_excluded_from_estimated_one_rep_max: 2,
    });
    expect(result.summary).toMatchObject({
      sessions: 2,
      exercises: 1,
      frequency_days: 2,
      valid_working_sets: 2,
      total_volume_kg_reps: 1050,
    });
    expect(result.exercises).toEqual([
      expect.objectContaining({
        exercise_id: benchExercise,
        name: "Bench Press",
        normalized_identity: true,
        frequency_days: 2,
        total_volume_kg_reps: 1050,
        estimated_one_rep_max: expect.objectContaining({
          formula: "Epley",
          first_kg: 116.65,
          latest_kg: 128.32,
          change_kg: 11.66,
          best_kg: 128.32,
        }),
        daily: [
          {
            date: "2026-05-01",
            sessions: 1,
            working_sets: 1,
            valid_working_sets: 1,
            total_volume_kg_reps: 500,
            max_weight_kg: 100,
            best_estimated_one_rep_max_kg: 116.65,
          },
          {
            date: "2026-07-01",
            sessions: 1,
            working_sets: 2,
            valid_working_sets: 1,
            total_volume_kg_reps: 550,
            max_weight_kg: 110,
            best_estimated_one_rep_max_kg: 128.32,
          },
        ],
        prs: [
          expect.objectContaining({
            date: "2026-05-01",
            value_kg: 116.65,
            previous_best_kg: 104.99,
            previous_best_evidence: expect.objectContaining({
              activity_id: priorActivity,
              date: "2026-04-01",
              reps: 5,
              value_kg: 104.99,
              weight_kg: 90,
            }),
          }),
          expect.objectContaining({
            date: "2026-07-01",
            value_kg: 128.32,
            previous_best_kg: 116.65,
          }),
        ],
      }),
    ]);
  });

  it("bounds logged comparisons by timestamp and access before deduplicating canonical sessions", async () => {
    const all = await new StrengthProgressionRepository(
      context.db,
      userId,
      "UTC",
    ).listLoggedSetComparison(null);
    expect(all.exercises[0]).toMatchObject({ exerciseId: benchExercise, totalLoggedSets: 3 });
    expect(all.exercises[0]?.sessions).toHaveLength(3);
    expect(all.exercises[0]?.comparisons[0]).toMatchObject({
      observedDates: 3,
      first: { weightKg: 90 },
      latest: { weightKg: 110 },
    });
    const restricted = await new StrengthProgressionRepository(context.db, userId, "UTC", {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-05-01",
      endDateExclusive: "2026-06-01",
    }).listLoggedSetComparison(null);
    expect(restricted.exercises[0]).toMatchObject({ totalLoggedSets: 1 });
    expect(restricted.exercises[0]?.sessions[0]).toMatchObject({
      date: "2026-05-01",
      sourceProviders: expect.arrayContaining([primaryProvider, mirrorProvider]),
    });
    expect(restricted.exercises[0]?.comparisons[0]?.latest).toBeNull();
    const futureActivity = randomUUID();
    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, raw
      ) VALUES (
        ${futureActivity}::uuid, ${futureActivity}::uuid, ${primaryProvider}, ${userId}::uuid,
        'future-session', 'strength', 'strength_training',
        CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP + INTERVAL '2 days', '{}'::jsonb
      )
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.strength_set (
        activity_id, exercise_id, exercise_index, set_index, set_type, weight_kg, reps, raw
      ) VALUES (${futureActivity}::uuid, ${benchExercise}::uuid, 0, 0, 'working', 200, 5, '{}'::jsonb)
    `);
    const withFuture = await new StrengthProgressionRepository(
      context.db,
      userId,
      "UTC",
    ).listLoggedSetComparison(null);
    expect(withFuture.exercises[0]?.totalLoggedSets).toBe(3);
    const recent = await new StrengthProgressionRepository(
      context.db,
      userId,
      "UTC",
    ).listLoggedSetComparison(1);
    expect(recent.exercises).toEqual([]);
    const [clock] = await executeWithSchema(
      context.db,
      z.object({ now: timestampStringSchema }),
      sql`SELECT CURRENT_TIMESTAMP::text AS now`,
    );
    if (!clock) throw new Error("Database clock is required");
    const now = new Date(clock.now);
    const offsetStart = new Date(now);
    offsetStart.setUTCDate(offsetStart.getUTCDate() - 3);
    offsetStart.setUTCHours(0, 30, 0, 0);
    const offsetDate = new Date(offsetStart.getTime() - 120 * 60_000).toISOString().slice(0, 10);
    const insideId = randomUUID();
    const outsideId = randomUUID();
    const offsetId = randomUUID();
    for (const observation of [
      { id: insideId, start: new Date(now.getTime() - (30 * 24 - 1) * 3_600_000), offset: null },
      { id: outsideId, start: new Date(now.getTime() - (30 * 24 + 1) * 3_600_000), offset: null },
      { id: offsetId, start: offsetStart, offset: -120 },
    ]) {
      await context.db.execute(sql`
        INSERT INTO fitness.activity (
          id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
          started_at, ended_at, raw, start_utc_offset_minutes, local_time_source
        ) VALUES (
          ${observation.id}::uuid, ${observation.id}::uuid, ${primaryProvider}, ${userId}::uuid,
          ${observation.id}, 'strength', 'strength_training',
          ${observation.start.toISOString()}::timestamptz,
          ${new Date(observation.start.getTime() + 60_000).toISOString()}::timestamptz,
          '{}'::jsonb, ${observation.offset},
          ${observation.offset === null ? "unknown" : "provider_offset"}
        )
      `);
      await context.db.execute(sql`
        INSERT INTO fitness.strength_set (
          activity_id, exercise_id, exercise_index, set_index, set_type, weight_kg, reps, raw
        ) VALUES (${observation.id}::uuid, ${benchExercise}::uuid, 0, 0, 'working', 120, 5, '{}'::jsonb)
      `);
    }
    const selected = await new StrengthProgressionRepository(
      context.db,
      userId,
      "UTC",
    ).listLoggedSetComparison(30);
    expect(selected.exercises[0]?.totalLoggedSets).toBe(2);
    expect(selected.exercises[0]?.sessions.map((session) => session.activityId).sort()).toEqual(
      [insideId, offsetId].sort(),
    );
    expect(
      selected.exercises[0]?.sessions.find((session) => session.activityId === offsetId)?.date,
    ).toBe(offsetDate);
    const unbounded = await new StrengthProgressionRepository(
      context.db,
      userId,
      "UTC",
    ).listLoggedSetComparison(null);
    expect(
      unbounded.exercises[0]?.sessions.some((session) => session.activityId === outsideId),
    ).toBe(true);
    const otherUser = await new StrengthProgressionRepository(
      context.db,
      randomUUID(),
      "UTC",
    ).listLoggedSetComparison(null);
    expect(otherUser.exercises).toEqual([]);
  });

  it("returns suspicious original values but excludes them without correcting them", async () => {
    const result = await new StrengthProgressionRepository(context.db, userId, "UTC").listRange({
      startDate: "2026-07-01",
      endDate: "2026-07-01",
      providers: [primaryProvider],
      exerciseIds: [benchExercise],
      cursor: null,
      limit: 100,
    });

    const session = result.sessions[0];
    expect(session).toMatchObject({
      activity_id: latestActivity,
      date: "2026-07-01",
      quality_flags: expect.arrayContaining(["contains_suspicious_strength_records"]),
      timezone: expect.objectContaining({ assumed: true, analysis_timezone: "UTC" }),
    });
    expect(result.exercises[0]?.estimated_one_rep_max).toMatchObject({
      first_kg: 128.32,
      latest_kg: 128.32,
      change_kg: null,
      change_percent: null,
    });
    const suspicious = session?.exercises[0]?.sets.find((set) => set.normalized.reps === 140);
    expect(suspicious).toMatchObject({
      normalized: { weight_kg: 4.989512, reps: 140, rpe: 7 },
      original: {
        status: "available",
        values: { weight: 11, weightUnit: "lbs", reps: 140, rpe: 7 },
      },
      quality_flags: ["implausible_repetitions", "possible_reversed_fields_or_import_corruption"],
      excluded_from_aggregates: true,
      volume: { status: "unavailable", value_kg_reps: null, reason: "quality_flags" },
      estimated_one_rep_max: {
        status: "unavailable",
        value_kg: null,
        formula: "Epley",
        reason: "quality_flags",
      },
    });
    expect(suspicious?.original.records[0]?.source_exercise_identity).toEqual({
      provider_exercise_id: null,
      provider_exercise_name: null,
      status: "unavailable",
    });
  });

  it("returns a single dumbbell bench history across provider aliases", async () => {
    const dumbbellBench = randomUUID();
    const mirroredBench = randomUUID();
    await context.db.execute(sql`
      INSERT INTO fitness.exercise (id, name, equipment) VALUES
        (${dumbbellBench}::uuid, 'Horizontal Press Fixture', 'Dumbbell'),
        (${mirroredBench}::uuid, 'Horizontal Press Fixture - Dumbbell', 'DUMBBELL')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.strength_set (
        activity_id, exercise_id, exercise_index, set_index, set_type, weight_kg, reps
      ) VALUES
        (${firstActivity}::uuid, ${dumbbellBench}::uuid, 1, 0, 'working', 20, 6),
        (${mirrorActivity}::uuid, ${mirroredBench}::uuid, 1, 0, 'working', 20, 6),
        (${latestActivity}::uuid, ${mirroredBench}::uuid, 1, 0, 'working', 25, 6)
    `);

    const { exercises } = await new StrengthProgressionRepository(
      context.db,
      userId,
      "UTC",
    ).listLoggedSetComparison(null);
    expect(exercises).toMatchObject([
      { exerciseName: "Bench Press", exerciseId: benchExercise, equipment: "Barbell" },
      {
        exerciseId: dumbbellBench,
        exerciseName: "Horizontal Press Fixture",
        equipment: "Dumbbell",
        totalLoggedSets: 2,
        comparisons: [
          {
            reps: 6,
            observedDates: 2,
            first: {
              date: "2026-05-01",
              weightKg: 20,
              sourceProviders: [primaryProvider, mirrorProvider].sort(),
            },
            latest: { date: "2026-07-01", weightKg: 25, sourceProviders: [primaryProvider] },
          },
        ],
      },
    ]);
  });
});

describe("StrengthProgressionRepository strength evidence", () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const primaryProvider = "strong-csv";
  const mirrorProvider = `z-strength-evidence-mirror-${randomUUID()}`;
  const benchExercise = randomUUID();
  const squatExercise = randomUUID();
  const pressExercise = randomUUID();
  const benchSession = randomUUID();
  const mirrorSession = randomUUID();
  let context: TestContext;
  let day: (offset: number) => string;
  let startedAt: (offset: number) => string;

  beforeAll(async () => {
    context = await setupTestDatabase();
    const [clock] = await executeWithSchema(
      context.db,
      z.object({ now: timestampStringSchema }),
      sql`SELECT CURRENT_TIMESTAMP::text AS now`,
    );
    if (!clock) throw new Error("Database clock is required");
    const now = new Date(clock.now);
    day = (offset) => new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    startedAt = (offset) => `${day(offset)}T18:00:00.000Z`;

    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name) VALUES
        (${userId}::uuid, 'Strength evidence fixture'),
        (${otherUserId}::uuid, 'Strength evidence other user')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id) VALUES
        (${primaryProvider}, 'Strong', ${userId}::uuid),
        (${mirrorProvider}, 'Mirror', ${userId}::uuid)
      ON CONFLICT (id) DO NOTHING
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.exercise (
        id, name, muscle_groups, equipment, exercise_type, movement
      ) VALUES
        (${benchExercise}::uuid, 'Bench Press', ARRAY['CHEST'], 'Barbell', 'STRENGTH', 'push'),
        (${squatExercise}::uuid, 'Squat', ARRAY['QUADRICEPS'], 'Barbell', 'STRENGTH', 'squat'),
        (${pressExercise}::uuid, 'Shoulder Press', ARRAY['SHOULDERS'], 'Dumbbell', 'STRENGTH', 'push')
    `);

    const insertSession = async (
      id: string,
      offset: number,
      name: string,
      provider = primaryProvider,
      groupId = id,
      owner = userId,
    ) => {
      await context.db.execute(sql`
        INSERT INTO fitness.activity (
          id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
          started_at, ended_at, name, source_name, raw, timezone,
          start_utc_offset_minutes, end_utc_offset_minutes, local_time_source
        ) VALUES (
          ${id}::uuid, ${groupId}::uuid, ${provider}, ${owner}::uuid, ${id},
          'strength', 'strength_training', ${startedAt(offset)}::timestamptz,
          ${`${day(offset)}T19:00:00.000Z`}::timestamptz, ${name}, 'Strong', '{}'::jsonb,
          'UTC', 0, 0, 'device_timezone'
        )
      `);
    };
    const insertSet = async (
      activityId: string,
      exerciseId: string,
      weight: number,
      reps: number,
      rpe: number | null,
      raw: Record<string, unknown>,
    ) => {
      await context.db.execute(sql`
        INSERT INTO fitness.strength_set (
          activity_id, exercise_id, exercise_index, set_index, set_type,
          weight_kg, reps, rpe, raw
        ) VALUES (
          ${activityId}::uuid, ${exerciseId}::uuid, 0, 0, 'working',
          ${weight}, ${reps}, ${rpe}, ${JSON.stringify(raw)}::jsonb
        )
      `);
    };

    const repSessions: Array<{ offset: number; reps: number; activity: string }> = [
      { offset: 20, reps: 8, activity: benchSession },
      { offset: 18, reps: 10, activity: randomUUID() },
      { offset: 16, reps: 10, activity: randomUUID() },
    ];
    for (const session of repSessions) {
      await insertSession(session.activity, session.offset, "Bench session");
      await insertSet(session.activity, benchExercise, 60, session.reps, 8, {
        weight: 60,
        weightUnit: "kg",
        reps: session.reps,
        rpe: 8,
      });
    }
    await insertSession(mirrorSession, 20, "Bench session mirror", mirrorProvider, benchSession);
    await insertSet(mirrorSession, benchExercise, 60, 8, 8, {
      weight_kg: 60,
      number_of_reps: 8,
      rpe: 8,
    });

    const flatWeights = [100, 100, 101, 101, 100, 100];
    const flatOffsets = [50, 45, 40, 35, 30, 22];
    for (const [index, offset] of flatOffsets.entries()) {
      const weight = flatWeights[index] ?? 100;
      const activity = randomUUID();
      await insertSession(activity, offset, "Squat session");
      await insertSet(activity, squatExercise, weight, 5, 8, {
        weight,
        weightUnit: "kg",
        reportedWeightUnit: "kg",
        reps: 5,
        setTag: "Failure",
        exerciseName: "Squat (Barbell)",
        rpe: 8,
      });
    }

    for (const [index, offset] of [15, 13, 11].entries()) {
      const reps = index === 0 ? 6 : 8;
      const activity = randomUUID();
      await insertSession(activity, offset, "Press session");
      await insertSet(activity, pressExercise, 40, reps, null, {
        weight: 40,
        weightUnit: "kg",
        reps,
        rpe: null,
      });
    }

    const oldSession = randomUUID();
    await insertSession(oldSession, 70, "Old bench session");
    await insertSet(oldSession, benchExercise, 60, 12, 8, {
      weight: 60,
      weightUnit: "kg",
      reps: 12,
      rpe: 8,
    });
    const foreignSession = randomUUID();
    await insertSession(
      foreignSession,
      14,
      "Foreign bench session",
      primaryProvider,
      foreignSession,
      otherUserId,
    );
    await insertSet(foreignSession, benchExercise, 60, 12, 8, {
      weight: 60,
      weightUnit: "kg",
      reps: 12,
      rpe: 8,
    });
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  it("returns newest-first evidence with ownership, 56-day, deduplication, and optional-effort semantics", async () => {
    const rows = await new StrengthProgressionRepository(
      context.db,
      userId,
      "UTC",
    ).getStrengthProgression();
    expect(rows.map(({ exerciseName }) => exerciseName)).toEqual([
      "Shoulder Press",
      "Bench Press",
      "Squat",
    ]);
    const byName = new Map(rows.map((row) => [row.exerciseName, row]));
    const bench = byName.get("Bench Press");
    expect(bench).toMatchObject({
      exerciseId: benchExercise,
      exerciseName: "Bench Press",
      equipment: "Barbell",
      status: "ready",
      evidence: { kind: "rep_improvement", effort: { provider: primaryProvider } },
    });
    expect(bench?.evidence.observations).toHaveLength(3);
    expect(bench?.evidence.observations[0]).toMatchObject({
      sourceSetId: expect.any(String),
      sourceActivityId: expect.any(String),
      activityId: expect.any(String),
      provider: primaryProvider,
      weightKg: 60,
      reps: 10,
      rpe: 8,
    });
    expect(bench?.latestEvidenceDate).toBe(day(16));

    expect(byName.get("Squat")).toMatchObject({
      status: "stagnating",
      evidence: {
        kind: "flat_benchmark",
        formula: "Epley",
        observedDates: 6,
        spanDays: 28,
      },
    });
    expect(byName.get("Shoulder Press")).toMatchObject({
      status: null,
      evidence: { kind: "rep_improvement", effort: { rpeSpread: null, comparable: false } },
    });

    const otherUser = await new StrengthProgressionRepository(
      context.db,
      otherUserId,
      "UTC",
    ).getStrengthProgression();
    expect(otherUser).toEqual([]);
    const limited = await new StrengthProgressionRepository(context.db, userId, "UTC", {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: day(19),
      endDateExclusive: day(17),
    }).getStrengthProgression();
    expect(limited).toEqual([]);
  });
});
