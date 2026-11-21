import { describe, expect, it } from "vitest";
import {
  exerciseOrderEvidenceSchema,
  exerciseOrderSessionSchema,
  exerciseOrderSetRowSchema,
  strengthExerciseHistoryRowSchema,
} from "./strength-exercise-history.ts";

describe("strengthExerciseHistoryRowSchema", () => {
  it("validates an exercise with both estimated strength and exercise order", () => {
    const row = {
      exerciseName: "Bench Press",
      equipment: "barbell",
      estimatedStrength: {
        exerciseName: "Bench Press",
        equipment: "barbell",
        history: [
          {
            date: "2026-05-01",
            estimatedMax: 100,
            actualWeight: 80,
            actualReps: 8,
            sourceSetId: "00000000-0000-4000-8000-000000000001",
            provider: "strong-csv",
            fatigueMarker: "Failure" as const,
          },
        ],
        trend: {
          direction: "stable" as const,
          summary: "Estimated max did not change from first to latest estimate.",
          changeMagnitudeKg: 0,
          firstDate: "2026-05-01",
          latestDate: "2026-05-01",
        },
      },
      exerciseOrder: {
        source: "Crimpd" as const,
        baseline: {
          activityId: "11111111-1111-4111-8111-111111111111",
          date: "2026-05-01",
          position: 2,
          sets: [
            { position: 1, resistance: 20, unit: "KG" as const, reps: 5 },
            { position: 2, resistance: 25, unit: "KG" as const, reps: 5 },
          ],
        },
        earlier: {
          activityId: "22222222-2222-4222-8222-222222222222",
          date: "2026-06-01",
          position: 1,
          sets: [{ position: 1, resistance: 22.5, unit: "KG" as const, reps: 5 }],
        },
      },
    };

    expect(strengthExerciseHistoryRowSchema.parse(row)).toEqual(row);
  });

  it("validates an order-only exercise with nullable estimatedStrength and earlier", () => {
    const row = {
      exerciseName: "Weighted Pull Up",
      equipment: null,
      estimatedStrength: null,
      exerciseOrder: {
        source: "Crimpd" as const,
        baseline: {
          activityId: "11111111-1111-4111-8111-111111111111",
          date: "2026-05-01",
          position: 3,
          sets: [{ position: 1, resistance: -10, unit: "LBS" as const, reps: 6 }],
        },
        earlier: null,
      },
    };

    expect(strengthExerciseHistoryRowSchema.parse(row)).toEqual(row);
  });

  it("validates an estimate-only exercise with nullable exerciseOrder", () => {
    const row = {
      exerciseName: "Squat",
      equipment: "barbell",
      estimatedStrength: {
        exerciseName: "Squat",
        equipment: "barbell",
        history: [
          {
            date: "2026-04-01",
            estimatedMax: 140,
            actualWeight: 120,
            actualReps: 5,
            sourceSetId: "00000000-0000-4000-8000-000000000001",
            provider: "strong-csv",
            fatigueMarker: "Failure" as const,
          },
        ],
        trend: {
          direction: "increasing" as const,
          summary: "Estimated max increased from first to latest estimate.",
          changeMagnitudeKg: 5,
          firstDate: "2026-03-01",
          latestDate: "2026-04-01",
        },
      },
      exerciseOrder: null,
    };

    expect(strengthExerciseHistoryRowSchema.parse(row)).toEqual(row);
  });

  it("rejects non-Crimpd source", () => {
    expect(() =>
      exerciseOrderEvidenceSchema.parse({
        source: "Strong",
        baseline: {
          activityId: "11111111-1111-4111-8111-111111111111",
          date: "2026-05-01",
          position: 2,
          sets: [],
        },
        earlier: null,
      }),
    ).toThrow();
  });

  it("rejects non-positive set or exercise positions", () => {
    expect(() =>
      exerciseOrderSetRowSchema.parse({
        position: 0,
        resistance: 20,
        unit: "KG",
        reps: 5,
      }),
    ).toThrow();

    expect(() =>
      exerciseOrderSessionSchema.parse({
        activityId: "11111111-1111-4111-8111-111111111111",
        date: "2026-05-01",
        position: 0,
        sets: [],
      }),
    ).toThrow();
  });

  it("rejects unknown weight units", () => {
    expect(() =>
      exerciseOrderSetRowSchema.parse({
        position: 1,
        resistance: 20,
        unit: "POUNDS",
        reps: 5,
      }),
    ).toThrow();
  });
});
