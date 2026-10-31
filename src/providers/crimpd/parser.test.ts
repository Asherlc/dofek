import { describe, expect, it } from "vitest";
import {
  crimpdSetHeader,
  crimpdSetRow,
  crimpdWorkoutHeader,
  crimpdWorkoutRow,
} from "../climbing-file-test-helpers.ts";
import { parseCrimpdExport } from "./parser.ts";

describe("Crimpd documented CSV export", () => {
  it("joins raw climb sets to source workouts and preserves completion separately from set completion", () => {
    const parsed = parseCrimpdExport(
      `${crimpdWorkoutHeader}\n${crimpdWorkoutRow()}`,
      `${crimpdSetHeader}\n${crimpdSetRow({ NOTES: 'A "note"\nwith lines' })}`,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      externalId: "workout-1",
      loggedAt: new Date("2026-09-01T23:30:00Z"),
      climbingEntries: [
        {
          climbedOn: "2026-09-01",
          board: { name: "Kilter Board", externalId: "kilter_board:original" },
          wallAngle: { value: 0, unit: "degrees" },
          reportedGrades: [{ value: "7A", system: "font" }],
          reportedAttemptCounts: [{ count: 3 }],
          attempts: [{ scope: "climb", sourceCompleted: false }],
          notes: 'A "note"\nwith lines',
        },
      ],
    });
    expect(parsed[0]?.climbingEntries[0]?.raw).toMatchObject({
      ASCENT: "false",
      COMPLETE: "true",
      REPS: "3",
      BOARD_LAYOUT: "original",
    });
    expect(parsed[0]?.raw).not.toHaveProperty("WORKLOAD");
    expect(parsed[0]?.raw).not.toHaveProperty("EST_DURATION");
  });

  it("keeps nonclimbing workouts, recorded zero reps/resistance and raw estimates without inventing measured duration", () => {
    const parsed = parseCrimpdExport(
      `${crimpdWorkoutHeader}\n${crimpdWorkoutRow({ TARGET: "Strength Training", WORKOUT_NAME: "Pull ups" })}`,
      `${crimpdSetHeader}\n${crimpdSetRow({ EXERCISE: "Pull up", GRADE: "", GRADE_SYSTEM: "", ASCENT: "", LOCATION: "", BOARD: "", BOARD_LAYOUT: "", REPS: "0", RESISTANCE: "0", WEIGHT_UNIT: "KG", NOTES: "Raw strength", DISTANCE: "0", LENGTH_UNIT: "CM" })}`,
    );
    expect(parsed[0]?.climbingEntries).toEqual([]);
    expect(parsed[0]?.sets).toEqual([
      expect.objectContaining({
        exerciseName: "Pull up",
        reps: 0,
        distanceMeters: 0,
        raw: expect.objectContaining({
          RESISTANCE: "0",
          EST_WORK_DURATION: "30",
          COMPLETE: "true",
        }),
      }),
    ]);
  });

  it("preserves unknown ungraded outcomes and stable positional source identities across CSV reordering", () => {
    const first = crimpdSetRow({
      ASCENT: "",
      GRADE: "",
      GRADE_SYSTEM: "",
      REPS: "",
      SET_ORDER: "1",
    });
    const second = crimpdSetRow({ SET_ORDER: "2", ASCENT: "true", REPS: "1" });
    const before = parseCrimpdExport(
      `${crimpdWorkoutHeader}\n${crimpdWorkoutRow()}`,
      `${crimpdSetHeader}\n${first}\n${second}`,
    );
    const after = parseCrimpdExport(
      `${crimpdWorkoutHeader}\n${crimpdWorkoutRow()}`,
      `${crimpdSetHeader}\n${second}\n${first}`,
    );
    expect(before[0]?.climbingEntries.map((entry) => entry.externalId).sort()).toEqual(
      after[0]?.climbingEntries.map((entry) => entry.externalId).sort(),
    );
    expect(before[0]?.climbingEntries[0]).toMatchObject({
      reportedGrades: [],
      attempts: [{ scope: "climb", sourceCompleted: null }],
    });
  });

  it("rejects orphan/duplicate source positions, invalid booleans, invalid counts, and missing headers", () => {
    const workout = `${crimpdWorkoutHeader}\n${crimpdWorkoutRow()}`;
    expect(() => parseCrimpdExport("DATE,NAME", crimpdSetHeader)).toThrow(/workouts.csv.*header/i);
    expect(() =>
      parseCrimpdExport(workout, `${crimpdSetHeader}\n${crimpdSetRow({ LOG_ID: "missing" })}`),
    ).toThrow(/workout/i);
    expect(() =>
      parseCrimpdExport(workout, `${crimpdSetHeader}\n${crimpdSetRow()}\n${crimpdSetRow()}`),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseCrimpdExport(workout, `${crimpdSetHeader}\n${crimpdSetRow({ ASCENT: "yes" })}`),
    ).toThrow(/ASCENT/i);
    expect(() =>
      parseCrimpdExport(workout, `${crimpdSetHeader}\n${crimpdSetRow({ REPS: "1.5" })}`),
    ).toThrow(/REPS/i);
  });
});
