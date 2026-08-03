import { SYSTEM_SEEDED_EXERCISE_DEFINITIONS } from "../../src/db/exercise-provenance.ts";
import { addMinutes, daysBefore, type Sql, timestampAt, USER_ID } from "./helpers.ts";

type ActivityType = "cycling" | "running" | "hiking" | "walking" | "strength";

interface ActivityRow {
  id: string;
}

interface ExerciseRow {
  id: string;
}

export async function seedTraining(sql: Sql): Promise<void> {
  const today = new Date();
  const exerciseIds = await seedExercises(sql);

  for (let daysAgo = 1; daysAgo <= 120; daysAgo++) {
    if (daysAgo % 7 === 0) continue;

    const date = daysBefore(today, daysAgo);
    const activityType = getActivityType(daysAgo);
    const durationMinutes = getDurationMinutes(activityType, daysAgo);
    const startedAt = timestampAt(date, 6 + (daysAgo % 12), daysAgo % 4 === 0 ? 30 : 0);
    const endedAt = addMinutes(startedAt, durationMinutes);
    const providerId = activityType === "strength" ? "whoop" : "strava";
    const [{ id: activityId }] = await sql<ActivityRow[]>`
      INSERT INTO fitness.activity (
        provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at,
        name, notes, perceived_exertion, source_name, timezone
      ) VALUES (
        ${providerId}, ${USER_ID}, ${`seed-activity-${daysAgo}`}, ${activityType}, ${activityType},
        ${startedAt}, ${endedAt}, ${activityName(activityType, daysAgo)},
        ${activityNotes(activityType, daysAgo)}, ${perceivedExertion(activityType, daysAgo)},
        ${providerId === "strava" ? "Strava Review Seed" : "WHOOP Strength Review Seed"},
        'America/Los_Angeles'
      ) RETURNING id
    `;

    if (daysAgo % 10 === 0) {
      await seedIntervals(sql, activityId, startedAt);
    }

    if (activityType === "strength") {
      await seedStrengthSets(sql, exerciseIds, activityId, daysAgo);
    }
  }

  console.log("Seeded: 120-day deterministic training history");
}

async function seedExercises(sql: Sql): Promise<string[]> {
  const ids: string[] = [];
  for (const definition of SYSTEM_SEEDED_EXERCISE_DEFINITIONS) {
    const [{ id }] = await sql<ExerciseRow[]>`
      INSERT INTO fitness.exercise (name, muscle_group, muscle_groups, equipment, exercise_type, movement)
      VALUES (
        ${definition.name},
        ${definition.muscleGroup},
        ${[...definition.muscleGroups]},
        ${definition.equipment},
        ${definition.exerciseType},
        ${definition.movement}
      )
      ON CONFLICT (name, equipment) DO UPDATE
        SET muscle_group = EXCLUDED.muscle_group,
            muscle_groups = EXCLUDED.muscle_groups,
            exercise_type = EXCLUDED.exercise_type,
            movement = EXCLUDED.movement
      RETURNING id
    `;
    await sql`
      INSERT INTO fitness.exercise_source (
        exercise_id, source_kind, user_id, provider_id
      )
      VALUES (${id}, ${definition.sourceKind}, NULL, NULL)
      ON CONFLICT (exercise_id) WHERE source_kind = 'system' DO NOTHING
    `;
    ids.push(id);
  }
  return ids;
}

function getActivityType(daysAgo: number): ActivityType {
  if (daysAgo % 8 === 0) return "strength";
  if (daysAgo % 6 === 0) return "hiking";
  if (daysAgo % 4 === 0) return "running";
  if (daysAgo % 5 === 0) return "walking";
  return "cycling";
}

function getDurationMinutes(activityType: ActivityType, daysAgo: number): number {
  if (activityType === "strength") return 55 + (daysAgo % 12);
  if (activityType === "walking") return 35 + (daysAgo % 20);
  if (activityType === "running") return 42 + (daysAgo % 24);
  if (activityType === "hiking") return 95 + (daysAgo % 45);
  return 60 + (daysAgo % 50);
}

function activityName(activityType: ActivityType, daysAgo: number): string {
  if (daysAgo >= 24 && daysAgo <= 38) return `Build Block ${readableActivityType(activityType)}`;
  if (daysAgo >= 16 && daysAgo <= 22) return `Deload ${readableActivityType(activityType)}`;
  return readableActivityType(activityType);
}

function readableActivityType(activityType: ActivityType): string {
  switch (activityType) {
    case "cycling":
      return "Endurance Ride";
    case "running":
      return "Steady Run";
    case "hiking":
      return "Hill Hike";
    case "walking":
      return "Recovery Walk";
    case "strength":
      return "Strength Session";
  }
}

function activityNotes(activityType: ActivityType, daysAgo: number): string {
  if (daysAgo % 10 === 0 && activityType !== "strength") return "Structured intervals";
  if (daysAgo >= 16 && daysAgo <= 22) return "Reduced training load";
  return "Review seed workout";
}

function perceivedExertion(activityType: ActivityType, daysAgo: number): number {
  if (daysAgo % 10 === 0 && activityType !== "strength") return 8;
  if (activityType === "strength") return 7;
  if (activityType === "walking") return 3;
  return 5 + (daysAgo % 3);
}

async function seedIntervals(sql: Sql, activityId: string, startedAt: string): Promise<void> {
  const intervals = [
    ["Warmup", "warmup", 0, 15],
    ["Interval 1", "work", 20, 8],
    ["Interval 2", "work", 35, 8],
    ["Cooldown", "cooldown", 50, 12],
  ] as const;

  for (const [
    index,
    [label, intervalType, offsetMinutes, durationMinutes],
  ] of intervals.entries()) {
    await sql`
      INSERT INTO fitness.activity_interval (
        activity_id, interval_index, label, interval_type, started_at, ended_at
      ) VALUES (
        ${activityId}, ${index + 1}, ${label}, ${intervalType},
        ${addMinutes(startedAt, offsetMinutes)}, ${addMinutes(startedAt, offsetMinutes + durationMinutes)}
      )
    `;
  }
}

async function seedStrengthSets(
  sql: Sql,
  exerciseIds: string[],
  activityId: string,
  daysAgo: number,
): Promise<void> {
  for (const [exerciseIndex, exerciseId] of exerciseIds.entries()) {
    const setCount = exerciseIndex < 2 ? 4 : 3;
    for (let setIndex = 1; setIndex <= setCount; setIndex++) {
      await sql`
        INSERT INTO fitness.strength_set (
          activity_id, exercise_id, exercise_index, set_index, set_type, weight_kg, reps, rpe
        ) VALUES (
          ${activityId}, ${exerciseId}, ${exerciseIndex + 1}, ${setIndex},
          ${setIndex === 1 ? "warmup" : "working"},
          ${45 + exerciseIndex * 12 + setIndex * 4 + (daysAgo % 5)},
          ${setIndex === 1 ? 8 : 5 + (exerciseIndex % 4)},
          ${setIndex === 1 ? 5 : 7 + (setIndex % 3)}
        )
      `;
    }
  }
}
