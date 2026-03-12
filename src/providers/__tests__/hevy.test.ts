import { describe, expect, it } from "vitest";
import {
  type HevyExerciseTemplate,
  type HevyWorkout,
  mapSetType,
  parseExerciseTemplate,
  parseSets,
  parseWorkout,
} from "../hevy.ts";

describe("mapSetType", () => {
  it("maps normal to working", () => {
    expect(mapSetType("normal")).toBe("working");
  });

  it("maps warmup to warmup", () => {
    expect(mapSetType("warmup")).toBe("warmup");
  });

  it("maps failure to failure", () => {
    expect(mapSetType("failure")).toBe("failure");
  });

  it("maps dropset to dropset", () => {
    expect(mapSetType("dropset")).toBe("dropset");
  });

  it("defaults unknown types to working", () => {
    expect(mapSetType("superset")).toBe("working");
    expect(mapSetType("")).toBe("working");
  });
});

describe("parseWorkout", () => {
  const baseWorkout: HevyWorkout = {
    id: "abc-123",
    title: "Push Day",
    description: "Chest and shoulders",
    start_time: "2024-06-15T10:30:00Z",
    end_time: "2024-06-15T11:45:00Z",
    updated_at: "2024-06-15T12:00:00Z",
    created_at: "2024-06-15T10:30:00Z",
    exercises: [],
  };

  it("maps all fields correctly", () => {
    const result = parseWorkout(baseWorkout);
    expect(result).toEqual({
      externalId: "abc-123",
      startedAt: new Date("2024-06-15T10:30:00Z"),
      endedAt: new Date("2024-06-15T11:45:00Z"),
      name: "Push Day",
      notes: "Chest and shoulders",
    });
  });

  it("handles null end_time", () => {
    const result = parseWorkout({ ...baseWorkout, end_time: null });
    expect(result.endedAt).toBeNull();
  });

  it("handles null title and description", () => {
    const result = parseWorkout({ ...baseWorkout, title: null, description: null });
    expect(result.name).toBeNull();
    expect(result.notes).toBeNull();
  });
});

describe("parseSets", () => {
  it("flattens exercises and sets correctly", () => {
    const workout: HevyWorkout = {
      id: "w1",
      title: "Leg Day",
      description: null,
      start_time: "2024-06-15T10:00:00Z",
      end_time: null,
      updated_at: "2024-06-15T12:00:00Z",
      created_at: "2024-06-15T10:00:00Z",
      exercises: [
        {
          index: 0,
          title: "Squat (Barbell)",
          notes: "Go deep",
          exercise_template_id: "tmpl-1",
          supersets_id: null,
          sets: [
            {
              index: 0,
              type: "warmup",
              weight_kg: 60,
              reps: 10,
              distance_meters: null,
              duration_seconds: null,
              rpe: null,
              custom_metric: null,
            },
            {
              index: 1,
              type: "normal",
              weight_kg: 100,
              reps: 5,
              distance_meters: null,
              duration_seconds: null,
              rpe: 8.5,
              custom_metric: null,
            },
          ],
        },
        {
          index: 1,
          title: "Leg Press",
          notes: null,
          exercise_template_id: "tmpl-2",
          supersets_id: null,
          sets: [
            {
              index: 0,
              type: "normal",
              weight_kg: 200,
              reps: 12,
              distance_meters: null,
              duration_seconds: null,
              rpe: 7,
              custom_metric: null,
            },
          ],
        },
      ],
    };

    const result = parseSets(workout);
    expect(result).toHaveLength(3);

    expect(result[0]).toEqual({
      exerciseTemplateId: "tmpl-1",
      exerciseTitle: "Squat (Barbell)",
      exerciseIndex: 0,
      setIndex: 0,
      setType: "warmup",
      weightKg: 60,
      reps: 10,
      distanceMeters: null,
      durationSeconds: null,
      rpe: null,
      notes: "Go deep",
    });

    expect(result[1]).toMatchObject({
      exerciseIndex: 0,
      setIndex: 1,
      setType: "working",
      weightKg: 100,
      reps: 5,
      rpe: 8.5,
    });

    expect(result[2]).toMatchObject({
      exerciseTemplateId: "tmpl-2",
      exerciseTitle: "Leg Press",
      exerciseIndex: 1,
      setIndex: 0,
      setType: "working",
      notes: null,
    });
  });

  it("returns empty array for workout with no exercises", () => {
    const workout: HevyWorkout = {
      id: "w2",
      title: null,
      description: null,
      start_time: "2024-06-15T10:00:00Z",
      end_time: null,
      updated_at: "2024-06-15T10:00:00Z",
      created_at: "2024-06-15T10:00:00Z",
      exercises: [],
    };
    expect(parseSets(workout)).toEqual([]);
  });
});

describe("parseExerciseTemplate", () => {
  it("maps fields correctly", () => {
    const template: HevyExerciseTemplate = {
      id: "tmpl-1",
      title: "Bench Press (Barbell)",
      type: "strength",
      primary_muscle_group: "chest",
      secondary_muscle_groups: ["triceps", "shoulders"],
      is_custom: false,
    };
    const result = parseExerciseTemplate(template);
    expect(result).toEqual({
      templateId: "tmpl-1",
      name: "Bench Press (Barbell)",
      muscleGroup: "chest",
    });
  });

  it("handles null primary_muscle_group", () => {
    const template: HevyExerciseTemplate = {
      id: "tmpl-2",
      title: "Custom Move",
      type: "strength",
      primary_muscle_group: null,
      secondary_muscle_groups: [],
      is_custom: true,
    };
    expect(parseExerciseTemplate(template).muscleGroup).toBeNull();
  });
});
