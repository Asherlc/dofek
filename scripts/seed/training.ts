import {
  addMinutes,
  daysBefore,
  round,
  type SeedRandom,
  type Sql,
  timestampAt,
  USER_ID,
} from "./helpers.ts";

type ActivityType = "cycling" | "running" | "hiking" | "walking" | "strength_training";

interface ActivityRow {
  id: string;
}

interface ExerciseRow {
  id: string;
}

export async function seedTraining(sql: Sql, random: SeedRandom): Promise<void> {
  const today = new Date();
  const exerciseIds = await seedExercises(sql);

  for (let daysAgo = 1; daysAgo <= 120; daysAgo++) {
    if (daysAgo % 7 === 0) continue;

    const date = daysBefore(today, daysAgo);
    const activityType = getActivityType(daysAgo);
    const durationMinutes = getDurationMinutes(activityType, daysAgo);
    const startedAt = timestampAt(date, 6 + (daysAgo % 12), daysAgo % 4 === 0 ? 30 : 0);
    const endedAt = addMinutes(startedAt, durationMinutes);
    const providerId = activityType === "strength_training" ? "whoop" : "strava";
    const [{ id: activityId }] = await sql<ActivityRow[]>`
      INSERT INTO fitness.activity (
        provider_id, user_id, external_id, activity_type, started_at, ended_at,
        name, notes, perceived_exertion, source_name, timezone
      ) VALUES (
        ${providerId}, ${USER_ID}, ${`seed-activity-${daysAgo}`}, ${activityType},
        ${startedAt}, ${endedAt}, ${activityName(activityType, daysAgo)},
        ${activityNotes(activityType, daysAgo)}, ${perceivedExertion(activityType, daysAgo)},
        ${providerId === "strava" ? "Strava Review Seed" : "WHOOP Strength Review Seed"},
        'America/Los_Angeles'
      ) RETURNING id
    `;

    await seedActivityStreams(
      sql,
      random,
      activityId,
      activityType,
      startedAt,
      durationMinutes,
      daysAgo,
    );

    if (daysAgo % 10 === 0) {
      await seedIntervals(sql, activityId, startedAt);
    }

    if (activityType === "strength_training") {
      await seedStrengthWorkout(sql, exerciseIds, startedAt, endedAt, daysAgo);
    }
  }

  console.log("Seeded: 120-day deterministic training history");
}

async function seedExercises(sql: Sql): Promise<string[]> {
  const exercises = [
    ["Back Squat", "legs", "barbell", "strength"],
    ["Bench Press", "chest", "barbell", "strength"],
    ["Deadlift", "posterior_chain", "barbell", "strength"],
    ["Pull Up", "back", "bodyweight", "strength"],
    ["Romanian Deadlift", "hamstrings", "barbell", "strength"],
    ["Overhead Press", "shoulders", "barbell", "strength"],
  ] as const;

  const ids: string[] = [];
  for (const [name, muscleGroup, equipment, exerciseType] of exercises) {
    const [{ id }] = await sql<ExerciseRow[]>`
      INSERT INTO fitness.exercise (name, muscle_group, muscle_groups, equipment, exercise_type, movement)
      VALUES (${name}, ${muscleGroup}, ARRAY[${muscleGroup}], ${equipment}, ${exerciseType}, 'compound')
      ON CONFLICT (name, equipment) DO UPDATE
        SET muscle_group = EXCLUDED.muscle_group,
            muscle_groups = EXCLUDED.muscle_groups,
            exercise_type = EXCLUDED.exercise_type,
            movement = EXCLUDED.movement
      RETURNING id
    `;
    ids.push(id);
  }
  return ids;
}

function getActivityType(daysAgo: number): ActivityType {
  if (daysAgo % 8 === 0) return "strength_training";
  if (daysAgo % 6 === 0) return "hiking";
  if (daysAgo % 4 === 0) return "running";
  if (daysAgo % 5 === 0) return "walking";
  return "cycling";
}

function getDurationMinutes(activityType: ActivityType, daysAgo: number): number {
  if (activityType === "strength_training") return 55 + (daysAgo % 12);
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
    case "strength_training":
      return "Strength Session";
  }
}

function activityNotes(activityType: ActivityType, daysAgo: number): string {
  if (daysAgo % 10 === 0 && activityType !== "strength_training") return "Structured intervals";
  if (daysAgo >= 16 && daysAgo <= 22) return "Reduced training load";
  return "Review seed workout";
}

function perceivedExertion(activityType: ActivityType, daysAgo: number): number {
  if (daysAgo % 10 === 0 && activityType !== "strength_training") return 8;
  if (activityType === "strength_training") return 7;
  if (activityType === "walking") return 3;
  return 5 + (daysAgo % 3);
}

async function seedActivityStreams(
  sql: Sql,
  random: SeedRandom,
  activityId: string,
  activityType: ActivityType,
  startedAt: string,
  durationMinutes: number,
  daysAgo: number,
): Promise<void> {
  const sampleCount = Math.max(8, Math.floor(durationMinutes / 5));
  const baseHeartRate =
    activityType === "strength_training" ? 112 : activityType === "walking" ? 98 : 138;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const recordedAt = addMinutes(startedAt, sampleIndex * 5);
    const wave = Math.sin(sampleIndex / 2);
    await sql`
      INSERT INTO fitness.metric_stream (
        recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar
      ) VALUES (
        ${recordedAt}, ${USER_ID}, 'whoop', 'review-strap', 'api', 'heart_rate', ${activityId},
        ${Math.round(baseHeartRate + wave * 12 + random.int(-4, 6))}
      )
    `;

    if (activityType === "cycling") {
      await insertScalar(
        sql,
        recordedAt,
        "strava",
        "power",
        activityId,
        185 + wave * 42 + random.int(-15, 18),
      );
      await insertScalar(
        sql,
        recordedAt,
        "strava",
        "cadence",
        activityId,
        86 + wave * 8 + random.int(-3, 4),
      );
      await insertScalar(
        sql,
        recordedAt,
        "strava",
        "speed",
        activityId,
        8.2 + wave * 1.5 + random.float(-0.4, 0.5, 1),
      );
      await insertScalar(
        sql,
        recordedAt,
        "strava",
        "altitude",
        activityId,
        85 + sampleIndex * 2 + random.int(-3, 5),
      );
      await insertScalar(sql, recordedAt, "strava", "lat", activityId, 37.78 + sampleIndex * 0.001);
      await insertScalar(
        sql,
        recordedAt,
        "strava",
        "lng",
        activityId,
        -122.42 + sampleIndex * 0.001,
      );
      if (daysAgo % 9 === 0) {
        await insertScalar(sql, recordedAt, "strava", "left_right_balance", activityId, 49 + wave);
      }
    }

    if (activityType === "running" || activityType === "hiking" || activityType === "walking") {
      const speed = activityType === "running" ? 3.1 : activityType === "hiking" ? 1.55 : 1.35;
      await insertScalar(
        sql,
        recordedAt,
        "strava",
        "speed",
        activityId,
        speed + random.float(-0.15, 0.18, 2),
      );
      await insertScalar(
        sql,
        recordedAt,
        "strava",
        "altitude",
        activityId,
        60 + sampleIndex * (activityType === "hiking" ? 4 : 1),
      );
      await insertScalar(sql, recordedAt, "strava", "lat", activityId, 37.7 + sampleIndex * 0.0007);
      await insertScalar(
        sql,
        recordedAt,
        "strava",
        "lng",
        activityId,
        -122.39 + sampleIndex * 0.0007,
      );
      if (activityType === "running") {
        await insertScalar(
          sql,
          recordedAt,
          "strava",
          "cadence",
          activityId,
          168 + random.int(-5, 6),
        );
        await insertScalar(
          sql,
          recordedAt,
          "strava",
          "stride_length",
          activityId,
          1.12 + random.float(-0.08, 0.08, 2),
        );
        await insertScalar(
          sql,
          recordedAt,
          "strava",
          "ground_contact_time",
          activityId,
          245 + random.int(-18, 18),
        );
      }
    }
  }
}

async function insertScalar(
  sql: Sql,
  recordedAt: string,
  providerId: string,
  channel: string,
  activityId: string,
  value: number,
): Promise<void> {
  await sql`
    INSERT INTO fitness.metric_stream (
      recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar
    ) VALUES (
      ${recordedAt}, ${USER_ID}, ${providerId}, 'review-device', 'api', ${channel}, ${activityId},
      ${round(value, 2)}
    )
  `;
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

async function seedStrengthWorkout(
  sql: Sql,
  exerciseIds: string[],
  startedAt: string,
  endedAt: string,
  daysAgo: number,
): Promise<void> {
  const [{ id: workoutId }] = await sql<ActivityRow[]>`
    INSERT INTO fitness.strength_workout (
      provider_id, user_id, external_id, started_at, ended_at, name, notes,
      raw_msk_strain_score, scaled_msk_strain_score, cardio_strain_score,
      cardio_strain_contribution_percent, msk_strain_contribution_percent
    ) VALUES (
      'whoop', ${USER_ID}, ${`seed-strength-${daysAgo}`}, ${startedAt}, ${endedAt},
      'Strength Session', 'Review seed strength workout',
      ${12 + (daysAgo % 8)}, ${8 + (daysAgo % 5)}, ${4 + (daysAgo % 4)}, 35, 65
    ) RETURNING id
  `;

  for (const [exerciseIndex, exerciseId] of exerciseIds.entries()) {
    const setCount = exerciseIndex < 2 ? 4 : 3;
    for (let setIndex = 1; setIndex <= setCount; setIndex++) {
      await sql`
        INSERT INTO fitness.strength_set (
          workout_id, exercise_id, exercise_index, set_index, set_type, weight_kg, reps, rpe
        ) VALUES (
          ${workoutId}, ${exerciseId}, ${exerciseIndex + 1}, ${setIndex},
          ${setIndex === 1 ? "warmup" : "working"},
          ${45 + exerciseIndex * 12 + setIndex * 4 + (daysAgo % 5)},
          ${setIndex === 1 ? 8 : 5 + (exerciseIndex % 4)},
          ${setIndex === 1 ? 5 : 7 + (setIndex % 3)}
        )
      `;
    }
  }
}
