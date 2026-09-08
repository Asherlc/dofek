import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { StrengthProgressionRepository } from "./strength-progression-repository.ts";

describe("StrengthProgressionRepository database semantics", () => {
  const userId = randomUUID();
  const primaryProvider = `strength-primary-${randomUUID()}`;
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
          90, 5, 8, '{"weight":90,"weightUnit":"kg","reps":5,"rpe":8}'::jsonb),
        (${firstActivity}::uuid, ${benchExercise}::uuid, 0, 0, 'working',
          100, 5, 8, '{"weight":100,"weightUnit":"kg","reps":5,"rpe":8}'::jsonb),
        (${mirrorActivity}::uuid, ${benchExercise}::uuid, 0, 0, 'working',
          100, 5, 8, '{"weight_kg":100,"number_of_reps":5,"complete":true}'::jsonb),
        (${latestActivity}::uuid, ${benchExercise}::uuid, 0, 0, 'warmup',
          60, 5, NULL, '{"weight":60,"weightUnit":"kg","reps":5}'::jsonb),
        (${latestActivity}::uuid, ${benchExercise}::uuid, 0, 1, 'working',
          110, 5, 9, '{"weight":110,"weightUnit":"kg","reps":5,"rpe":9}'::jsonb),
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
          first_kg: 116.67,
          latest_kg: 128.33,
          change_kg: 11.66,
          best_kg: 128.33,
        }),
        daily: [
          {
            date: "2026-05-01",
            sessions: 1,
            working_sets: 1,
            valid_working_sets: 1,
            total_volume_kg_reps: 500,
            max_weight_kg: 100,
            best_estimated_one_rep_max_kg: 116.67,
          },
          {
            date: "2026-07-01",
            sessions: 1,
            working_sets: 2,
            valid_working_sets: 1,
            total_volume_kg_reps: 550,
            max_weight_kg: 110,
            best_estimated_one_rep_max_kg: 128.33,
          },
        ],
        prs: [
          expect.objectContaining({
            date: "2026-05-01",
            value_kg: 116.67,
            previous_best_kg: 105,
            previous_best_evidence: expect.objectContaining({
              activity_id: priorActivity,
              date: "2026-04-01",
              reps: 5,
              value_kg: 105,
              weight_kg: 90,
            }),
          }),
          expect.objectContaining({
            date: "2026-07-01",
            value_kg: 128.33,
            previous_best_kg: 116.67,
          }),
        ],
      }),
    ]);
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
});
