import { describe, expect, it, vi } from "vitest";
import {
  crimpdSetHeader,
  crimpdSetRow,
  crimpdWorkoutHeader,
  crimpdWorkoutRow,
} from "../climbing-file-test-helpers.ts";
import { parseCrimpdExport } from "./parser.ts";

function parseSet(values: Record<string, string> = {}, workout: Record<string, string> = {}) {
  return parseCrimpdExport(
    `${crimpdWorkoutHeader}\n${crimpdWorkoutRow(workout)}`,
    `${crimpdSetHeader}\n${crimpdSetRow(values)}`,
  )[0];
}

const strengthSet = {
  EXERCISE: "Pull up",
  GRADE: "",
  GRADE_SYSTEM: "",
  ASCENT: "",
  LOCATION: "",
  BOARD: "",
};

describe("Crimpd documented CSV export", () => {
  it("loads the CSV contract and mappings together in an isolated parser module", async () => {
    vi.resetModules();
    const { parseCrimpdExport: parseFreshExport } = await import("./parser.ts");
    const workoutCsv = `${crimpdWorkoutHeader}\n${crimpdWorkoutRow()}`;
    const parsed = parseFreshExport(
      workoutCsv,
      `${crimpdSetHeader}\n${crimpdSetRow({ HOLD_TYPE: "edges" })}`,
    );
    expect(parsed[0]?.raw.LOG_ID).toBe("workout-1");
    expect(parsed[0]?.climbingEntries[0]).toMatchObject({
      reportedGrades: [{ value: "7A", system: "font" }],
      board: { name: "Kilter Board", externalId: "kilter_board:original" },
      holdTypes: ["crimp"],
    });
    expect(() => parseFreshExport(workoutCsv, "LOG_ID,DATE")).toThrow(/sets.csv.*header/i);
  });
  it("preserves the documented workout fields and each original set field", () => {
    const workout = parseSet(
      {
        HOLD_TYPE: "edges|small_crimps|jugs|slopers|pockets|pinches|unknown",
        LOCATION_NAME: "Gym",
        NOTES: "Set notes",
      },
      { NOTES: "Workout notes", COMPLETION: "0.5", LB_CIRCUIT: "Circuit", LB_ANGLE: "40" },
    );
    expect(workout?.name).toBe("Board climbing");
    expect(workout?.notes).toBe("Workout notes");
    expect(workout?.raw).toEqual({
      DATE: "2026-09-01T23:30:00Z",
      WORKOUT_NAME: "Board climbing",
      TYPE: "Open Climbing",
      TARGET: "Bouldering",
      INTENSITY: "0",
      COMPLETION: "0.5",
      WEIGHT_UNIT: "KG",
      LENGTH_UNIT: "CM",
      LB_CIRCUIT: "Circuit",
      LB_ANGLE: "40",
      NOTES: "Workout notes",
      LOG_ID: "workout-1",
    });
    const entry = workout?.climbingEntries[0];
    expect(entry).toMatchObject({
      externalId: 'crimpd:set:["workout-1",1,1]',
      discipline: "rock_climbing",
      sourceName: "Crimpd",
      holdTypes: ["crimp", "jug", "sloper", "pocket", "pinch"],
      climb: {
        externalId: null,
        name: "A problem",
        kind: "boulder",
        setting: "indoor",
        areas: [{ name: "Gym", externalId: null }],
      },
    });
    expect(entry?.raw).toEqual({
      ...Object.fromEntries(crimpdSetHeader.split(",").map((key) => [key, ""])),
      ...{
        LOG_ID: "workout-1",
        DATE: "2026-09-01T23:30:00Z",
        EXERCISE: "Board bouldering",
        ACTIVITY_ORDER: "1",
        SET_ORDER: "1",
        NAME: "A problem",
        GRADE: "7A",
        GRADE_SYSTEM: "FONT",
        REPS: "3",
        ASCENT: "false",
        COMPLETE: "true",
        EST_WORK_DURATION: "30",
        EST_REST_DURATION: "90",
        LOCATION: "board",
        BOARD: "kilter_board",
        BOARD_LAYOUT: "original",
        ANGLE: "0",
        HOLD_TYPE: "edges|small_crimps|jugs|slopers|pockets|pinches|unknown",
        LOCATION_NAME: "Gym",
        NOTES: "Set notes",
      },
    });
  });

  it.each([
    ["CM", "125", 1.25],
    ["IN", "10", 0.254],
    ["M", "10", null],
    ["CM", "", null],
  ])("converts recorded distance %s/%s to meters", (LENGTH_UNIT, DISTANCE, expected) => {
    const workout = parseSet({
      ...strengthSet,
      LENGTH_UNIT,
      DISTANCE,
      ACTIVITY_ORDER: "3",
      SET_ORDER: "5",
      NOTES: "Recorded",
    });
    expect(workout?.sets[0]).toMatchObject({
      exerciseName: "Pull up",
      exerciseIndex: 2,
      setIndex: 4,
      reps: 3,
      distanceMeters: expected,
      notes: "Recorded",
    });
  });

  it.each([
    ["", null],
    ["1.5", null],
    ["2147483647", 2147483647],
    ["2147483648", null],
  ])("keeps only representable integer strength repetitions %s", (REPS, expected) => {
    expect(parseSet({ ...strengthSet, REPS })?.sets[0]?.reps).toBe(expected);
  });

  it.each(["ASCENT", "GRADE", "LOCATION", "BOARD"])(
    "recognizes climbing from %s alone",
    (field) => {
      const value =
        { ASCENT: "false", GRADE: "V2", LOCATION: "board", BOARD: "custom_board" }[field] ?? "";
      const workout = parseSet({ ...strengthSet, [field]: value });
      expect(workout?.sets).toEqual([]);
      expect(workout?.climbingEntries).toHaveLength(1);
    },
  );

  it.each([
    ["HUECO", "V3", "v_scale", "boulder"],
    ["FONT", "7A", "font", "boulder"],
    ["YDS", "5.10a", "yds", "route"],
    ["FRENCH", "6a", "french", "route"],
    ["UIAA", "6", "uiaa", "route"],
    ["EWBANK", "20", "ewbank", "route"],
  ])("maps %s grades and climb kind", (GRADE_SYSTEM, GRADE, system, kind) => {
    const entry = parseSet({ GRADE_SYSTEM, GRADE, LOCATION: "", BOARD: "" }, { TARGET: "Other" })
      ?.climbingEntries[0];
    expect(entry?.reportedGrades).toEqual([{ value: GRADE, system }]);
    expect(entry?.climb).toMatchObject({ kind, setting: null });
  });

  it.each([
    ["auto_belay", "route", "top_rope", "indoor"],
    ["top_rope", "route", "top_rope", "indoor"],
    ["lead", "route", "lead", "indoor"],
    ["circuit_board", "route", undefined, "indoor"],
    ["outdoor", null, undefined, "outdoor"],
    ["", null, undefined, null],
  ])(
    "maps ungraded %s location without inventing a grade or rope method",
    (LOCATION, kind, ropeMethod, setting) => {
      const entry = parseSet(
        {
          GRADE: "",
          GRADE_SYSTEM: "unknown",
          LOCATION,
          BOARD: "",
          ANGLE: "",
          HOLD_TYPE: "",
          BOARD_LAYOUT: "",
        },
        { TARGET: "Other" },
      )?.climbingEntries[0];
      expect(entry?.climb).toMatchObject({ kind, setting });
      expect(entry?.reportedGrades).toEqual([]);
      expect(entry?.attempts).toEqual([
        { scope: "climb", sourceCompleted: false, ...(ropeMethod ? { ropeMethod } : {}) },
      ]);
      expect(entry?.board).toBeUndefined();
      expect(entry?.wallAngle).toBeUndefined();
      expect(entry?.holdTypes).toBeUndefined();
    },
  );

  it("uses the workout target only when the grade system does not identify a kind", () => {
    expect(
      parseSet({ GRADE_SYSTEM: "", LOCATION: "", BOARD: "" })?.climbingEntries[0]?.climb?.kind,
    ).toBe("boulder");
  });

  it.each(["tension_board", "moonboard", "grasshopper", "decoy", "so_ill", "quantum", "Custom"])(
    "preserves board identity %s without a layout",
    (BOARD) => {
      const names: Record<string, string> = {
        tension_board: "Tension Board",
        moonboard: "MoonBoard",
        grasshopper: "Grasshopper",
        decoy: "Decoy",
        so_ill: "So iLL",
        quantum: "Quantum",
        Custom: "Custom",
      };
      expect(parseSet({ BOARD, BOARD_LAYOUT: "" })?.climbingEntries[0]?.board).toEqual({
        name: names[BOARD],
        externalId: BOARD,
      });
    },
  );

  it.each([-90, 90])("retains valid wall angle boundary %s", (ANGLE) => {
    expect(parseSet({ ANGLE: String(ANGLE) })?.climbingEntries[0]?.wallAngle).toEqual({
      value: ANGLE,
      unit: "degrees",
    });
  });

  it.each(["0", ""])("omits attempt counts for unreported/zero repetitions %s", (REPS) => {
    expect(parseSet({ REPS })?.climbingEntries[0]?.reportedAttemptCounts).toBeUndefined();
  });

  it.each([
    [{ LOG_ID: "" }, /set LOG_ID is required/],
    [{ ACTIVITY_ORDER: "" }, /ACTIVITY_ORDER must be a positive integer/],
    [{ ACTIVITY_ORDER: "0" }, /ACTIVITY_ORDER must be a positive integer/],
    [{ SET_ORDER: "0" }, /SET_ORDER must be a positive integer/],
    [{ SET_ORDER: "" }, /SET_ORDER must be a positive integer/],
    [{ COMPLETE: "maybe" }, /COMPLETE/],
    [{ DATE: "2026-09-02T23:30:00Z" }, /DATE does not match/],
    [{ REPS: "-1" }, /REPS/],
    [{ ANGLE: "-91" }, /ANGLE must be between/],
    [{ ANGLE: "91" }, /ANGLE must be between/],
    [{ ...strengthSet, EXERCISE: "" }, /EXERCISE is required/],
    [{ ...strengthSet, REPS: "-1" }, /REPS must not be negative/],
    [{ ...strengthSet, DISTANCE: "-1" }, /DISTANCE must not be negative/],
  ])("rejects invalid recorded set %j", (values, error) => {
    expect(() => parseSet(values)).toThrow(error);
  });

  it.each([
    [{ LOG_ID: "" }, /LOG_ID is required/],
    [{ DATE: "" }, /DATE is required/],
    [{ DATE: "invalid" }, /workout/],
    [{ DATE: "2026-02-30T23:30:00Z" }, /invalid source date/],
    [{ DATE: "2026-09-01T23:30:00+00:00" }, /UTC timestamp/],
  ])("rejects invalid workout identity/date %j", (workout, error) => {
    expect(() =>
      parseCrimpdExport(`${crimpdWorkoutHeader}\n${crimpdWorkoutRow(workout)}`, crimpdSetHeader),
    ).toThrow(error);
  });

  it("rejects duplicate workout IDs even without any recorded sets", () => {
    expect(() =>
      parseCrimpdExport(
        `${crimpdWorkoutHeader}\n${crimpdWorkoutRow()}\n${crimpdWorkoutRow()}`,
        crimpdSetHeader,
      ),
    ).toThrow(/duplicate workout LOG_ID/);
  });

  it("distinguishes set positions in different exercises and workouts", () => {
    const parsed = parseCrimpdExport(
      `${crimpdWorkoutHeader}\n${crimpdWorkoutRow()}\n${crimpdWorkoutRow({ LOG_ID: "workout-2" })}`,
      `${crimpdSetHeader}\n${crimpdSetRow()}\n${crimpdSetRow({ ACTIVITY_ORDER: "2" })}\n${crimpdSetRow({ LOG_ID: "workout-2" })}`,
    );
    expect(
      parsed.map((workout) => workout.climbingEntries.map((entry) => entry.externalId)),
    ).toEqual([
      ['crimpd:set:["workout-1",1,1]', 'crimpd:set:["workout-1",2,1]'],
      ['crimpd:set:["workout-2",1,1]'],
    ]);
  });
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
    ).toThrow("Crimpd set references a missing workout: missing");
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
