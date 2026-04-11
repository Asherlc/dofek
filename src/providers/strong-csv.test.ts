import { describe, expect, it } from "vitest";
import {
  isStrongCsvFormat,
  parseDurationString,
  parseOptionalFloat,
  parseOptionalInt,
  parseStrongCsv,
  parseStrongExerciseName,
  parseStrongText,
  parseStrongTextDate,
} from "./strong-csv.ts";

describe("parseStrongExerciseName", () => {
  it("splits name and equipment from parens", () => {
    expect(parseStrongExerciseName("Squat (Barbell)")).toEqual({
      exerciseName: "Squat",
      equipment: "Barbell",
    });
  });

  it("handles multi-word exercise names", () => {
    expect(parseStrongExerciseName("Romanian Deadlift (Barbell)")).toEqual({
      exerciseName: "Romanian Deadlift",
      equipment: "Barbell",
    });
  });

  it("handles dumbbell equipment", () => {
    expect(parseStrongExerciseName("Bench Press (Dumbbell)")).toEqual({
      exerciseName: "Bench Press",
      equipment: "Dumbbell",
    });
  });

  it("returns null equipment when no parens", () => {
    expect(parseStrongExerciseName("Pull Up")).toEqual({
      exerciseName: "Pull Up",
      equipment: null,
    });
  });

  it("handles machine equipment", () => {
    expect(parseStrongExerciseName("Leg Press (Machine)")).toEqual({
      exerciseName: "Leg Press",
      equipment: "Machine",
    });
  });

  it("trims whitespace", () => {
    expect(parseStrongExerciseName("  Squat (Barbell)  ")).toEqual({
      exerciseName: "Squat",
      equipment: "Barbell",
    });
  });
});

describe("parseDurationString", () => {
  it("parses hours and minutes", () => {
    expect(parseDurationString("1h 3m")).toBe(3780);
  });

  it("parses minutes only", () => {
    expect(parseDurationString("45m")).toBe(2700);
  });

  it("parses hours only", () => {
    expect(parseDurationString("2h")).toBe(7200);
  });

  it("parses zero minutes", () => {
    expect(parseDurationString("0m")).toBe(0);
  });

  it("handles hours and minutes without space", () => {
    expect(parseDurationString("1h30m")).toBe(5400);
  });

  it("returns 0 for unrecognized format", () => {
    expect(parseDurationString("")).toBe(0);
    expect(parseDurationString("unknown")).toBe(0);
  });

  it("parses HH:MM:SS format", () => {
    expect(parseDurationString("01:03:00")).toBe(3780);
    expect(parseDurationString("00:45:00")).toBe(2700);
  });
});

describe("parseStrongCsv", () => {
  const csvHeader =
    "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE";

  it("parses a basic CSV with one workout", () => {
    const csv = [
      csvHeader,
      '2024-11-02 10:00:00,"Push Day","1h 3m","Bench Press (Barbell)",1,135,10,,,,',
      '2024-11-02 10:00:00,"Push Day","1h 3m","Bench Press (Barbell)",2,155,8,,,,',
    ].join("\n");

    const groups = parseStrongCsv(csv);
    expect(groups).toHaveLength(1);
    const group = groups[0];
    if (!group) throw new Error("expected group");
    expect(group.workoutName).toBe("Push Day");
    expect(group.date).toBe("2024-11-02 10:00:00");
    expect(group.duration).toBe("1h 3m");
    expect(group.sets).toHaveLength(2);
    expect(group.sets[0]?.exerciseName).toBe("Bench Press (Barbell)");
    expect(group.sets[0]?.weight).toBe(135);
    expect(group.sets[0]?.reps).toBe(10);
    expect(group.sets[1]?.weight).toBe(155);
    expect(group.sets[1]?.reps).toBe(8);
  });

  it("groups rows by date and workout name", () => {
    const csv = [
      csvHeader,
      '2024-11-02 10:00:00,"Push Day","1h","Bench Press (Barbell)",1,135,10,,,,',
      '2024-11-03 09:00:00,"Pull Day","45m","Pull Up",1,,10,,,,',
    ].join("\n");

    const groups = parseStrongCsv(csv);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.workoutName).toBe("Push Day");
    expect(groups[1]?.workoutName).toBe("Pull Day");
  });

  it("handles empty weight and reps for cardio", () => {
    const csv = [csvHeader, '2024-11-02 10:00:00,"Cardio","30m","Running",1,,,5,1800,,'].join("\n");

    const groups = parseStrongCsv(csv);
    const set = groups[0]?.sets[0];
    if (!set) throw new Error("expected set");
    expect(set.weight).toBeNull();
    expect(set.reps).toBeNull();
    expect(set.distance).toBe(5);
    expect(set.seconds).toBe(1800);
  });

  it("handles BOM character", () => {
    const csv = [
      `\uFEFF${csvHeader}`,
      '2024-11-02 10:00:00,"Push Day","1h","Bench Press (Barbell)",1,135,10,,,,',
    ].join("\n");

    const groups = parseStrongCsv(csv);
    expect(groups).toHaveLength(1);
  });

  it("parses RPE values", () => {
    const csv = [
      csvHeader,
      '2024-11-02 10:00:00,"Push Day","1h","Bench Press (Barbell)",1,135,10,,,,,8.5',
    ].join("\n");

    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.rpe).toBe(8.5);
  });

  it("captures workout notes", () => {
    const csv = [
      csvHeader,
      '2024-11-02 10:00:00,"Push Day","1h","Bench Press (Barbell)",1,135,10,,,"set note","Felt good today",',
    ].join("\n");

    const groups = parseStrongCsv(csv);
    expect(groups[0]?.workoutNotes).toBe("Felt good today");
    expect(groups[0]?.sets[0]?.notes).toBe("set note");
  });

  it("handles quoted fields with commas", () => {
    const csv = [
      csvHeader,
      '2024-11-02 10:00:00,"Push Day, AM","1h","Bench Press (Barbell)",1,135,10,,,,',
    ].join("\n");

    const groups = parseStrongCsv(csv);
    expect(groups[0]?.workoutName).toBe("Push Day, AM");
  });

  it("returns empty array for empty CSV", () => {
    expect(parseStrongCsv("")).toEqual([]);
    expect(parseStrongCsv(csvHeader)).toEqual([]);
  });

  it("handles escaped double quotes in CSV fields", () => {
    const csv = [
      csvHeader,
      '2024-11-02 10:00:00,"Push Day","1h","Bench Press (Barbell)",1,135,10,,,"Note with ""quotes""","",',
    ].join("\n");

    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.notes).toBe('Note with "quotes"');
  });

  it("skips rows with fewer than 7 fields", () => {
    const csv = [csvHeader, "2024-11-02,Push Day,1h,Bench,1,135"].join("\n");
    expect(parseStrongCsv(csv)).toEqual([]);
  });

  it("carries workout notes from later row when first row lacks them", () => {
    const csv = [
      csvHeader,
      '2024-11-02 10:00:00,"Day","1h","Bench (Barbell)",1,135,10,,,,"",',
      '2024-11-02 10:00:00,"Day","1h","Bench (Barbell)",2,155,8,,,,"Good session",',
    ].join("\n");

    const groups = parseStrongCsv(csv);
    expect(groups[0]?.workoutNotes).toBe("Good session");
  });

  it("handles NaN values in numeric fields", () => {
    const csv = [
      csvHeader,
      '2024-11-02 10:00:00,"Day","1h","Bench (Barbell)",1,abc,xyz,,,,,,',
    ].join("\n");

    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.weight).toBeNull();
    expect(groups[0]?.sets[0]?.reps).toBeNull();
  });

  it("handles \\r\\n line endings", () => {
    const csv = `${csvHeader}\r\n2024-11-02 10:00:00,"Day","1h","Bench (Barbell)",1,135,10,,,,,,\r\n`;
    expect(parseStrongCsv(csv)).toHaveLength(1);
  });

  it("handles exercise name with empty parens", () => {
    expect(parseStrongExerciseName("Squat ()")).toEqual({
      exerciseName: "Squat ()",
      equipment: null,
    });
  });

  it("parses row with exactly 7 fields (minimum)", () => {
    const csv = [csvHeader, "2024-11-02 10:00:00,Day,1h,Bench,1,135,10"].join("\n");
    const groups = parseStrongCsv(csv);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sets[0]?.weight).toBe(135);
    expect(groups[0]?.sets[0]?.reps).toBe(10);
    expect(groups[0]?.sets[0]?.distance).toBeNull();
    expect(groups[0]?.sets[0]?.seconds).toBeNull();
    expect(groups[0]?.sets[0]?.notes).toBeNull();
    expect(groups[0]?.sets[0]?.workoutNotes).toBeNull();
    expect(groups[0]?.sets[0]?.rpe).toBeNull();
  });

  it("skips row with exactly 6 fields (below minimum)", () => {
    const csv = [csvHeader, "2024-11-02,Day,1h,Bench,1,135"].join("\n");
    expect(parseStrongCsv(csv)).toEqual([]);
  });

  it("notes with whitespace-only become null", () => {
    const csv = [csvHeader, '2024-11-02 10:00:00,"Day","1h","Bench",1,135,10,,,"   ","   ",'].join(
      "\n",
    );
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.notes).toBeNull();
    expect(groups[0]?.workoutNotes).toBeNull();
  });

  it("preserves first workout notes and ignores later ones", () => {
    const csv = [
      csvHeader,
      '2024-11-02 10:00:00,"Day","1h","Bench",1,135,10,,,,"First note",',
      '2024-11-02 10:00:00,"Day","1h","Bench",2,155,8,,,,"Second note",',
    ].join("\n");
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.workoutNotes).toBe("First note");
  });

  it("set order is parsed as integer", () => {
    const csv = [csvHeader, '2024-11-02 10:00:00,"Day","1h","Bench",3,135,10,,,,,,'].join("\n");
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.setOrder).toBe(3);
  });

  it("date and workoutName are preserved exactly", () => {
    const csv = [
      csvHeader,
      '2024-11-02 10:00:00,"My Workout","1h 30m","Squat (Barbell)",1,225,5,,,,,,',
    ].join("\n");
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.date).toBe("2024-11-02 10:00:00");
    expect(groups[0]?.workoutName).toBe("My Workout");
    expect(groups[0]?.duration).toBe("1h 30m");
  });

  it("parses HH:MM:SS with seconds", () => {
    expect(parseDurationString("01:30:45")).toBe(5445);
  });

  it("parses single-digit hour in HH:MM:SS", () => {
    expect(parseDurationString("2:15:30")).toBe(8130);
  });

  it("trailing comma in CSV line is handled", () => {
    const csv = [csvHeader, '2024-11-02 10:00:00,"Day","1h","Bench",1,135,10,,,,,8,'].join("\n");
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.rpe).toBe(8);
  });

  it("exercise name trimming removes whitespace from inside parens", () => {
    expect(parseStrongExerciseName("  Bench Press  ( Barbell )  ")).toEqual({
      exerciseName: "Bench Press",
      equipment: "Barbell",
    });
  });
});

describe("parseDurationString — arithmetic verification", () => {
  it("hours correctly multiply by 3600", () => {
    // 1h = 3600, not 60 or 1
    expect(parseDurationString("1h")).toBe(3600);
    expect(parseDurationString("3h")).toBe(10800);
  });

  it("minutes correctly multiply by 60", () => {
    // 1m = 60, not 1 or 3600
    expect(parseDurationString("1m")).toBe(60);
    expect(parseDurationString("10m")).toBe(600);
  });

  it("HH:MM:SS arithmetic is correct (hours*3600 + minutes*60 + seconds)", () => {
    // 1:01:01 = 3600 + 60 + 1 = 3661
    expect(parseDurationString("1:01:01")).toBe(3661);
    // 0:00:30 = 30
    expect(parseDurationString("0:00:30")).toBe(30);
    // 0:01:00 = 60
    expect(parseDurationString("0:01:00")).toBe(60);
  });

  it("rejects invalid formats", () => {
    expect(parseDurationString("abc")).toBe(0);
    expect(parseDurationString("1:2:3")).toBe(0); // minutes and seconds must be 2 digits
    expect(parseDurationString("1:2")).toBe(0); // missing seconds
    expect(parseDurationString("100:00:00")).toBe(0); // 3+ digit hours
  });
});

describe("parseStrongCsv — field-level assertions", () => {
  const csvHeader =
    "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE";

  it("default field values when fields are empty", () => {
    // All 12 fields present but some empty
    const csv = [csvHeader, "2024-11-02 10:00:00,Day,1h,Bench,0,,,,,,,"].join("\n");
    const groups = parseStrongCsv(csv);
    const set = groups[0]?.sets[0];
    expect(set?.date).toBe("2024-11-02 10:00:00");
    expect(set?.workoutName).toBe("Day");
    expect(set?.exerciseName).toBe("Bench");
    expect(set?.setOrder).toBe(0);
    expect(set?.weight).toBeNull();
    expect(set?.reps).toBeNull();
    expect(set?.distance).toBeNull();
    expect(set?.seconds).toBeNull();
    expect(set?.notes).toBeNull();
    expect(set?.rpe).toBeNull();
  });

  it("CSV with single-char unquoted fields", () => {
    const csv = [csvHeader, "D,N,1h,E,1,0,0,,,,,,"].join("\n");
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.date).toBe("D");
    expect(groups[0]?.workoutName).toBe("N");
    expect(groups[0]?.sets[0]?.exerciseName).toBe("E");
  });

  it("field at end of line without trailing comma", () => {
    const csv = [csvHeader, '2024-11-02 10:00:00,"Day","1h","Bench",1,135,10,,,,,9.5'].join("\n");
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.rpe).toBe(9.5);
  });

  it("weight and distance parse as float not int", () => {
    const csv = [csvHeader, '2024-11-02 10:00:00,"Day","30m","Run",1,67.5,12,3.2,,,,,'].join("\n");
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.weight).toBe(67.5);
    expect(groups[0]?.sets[0]?.distance).toBe(3.2);
  });

  it("reps and seconds parse as integer", () => {
    const csv = [csvHeader, '2024-11-02 10:00:00,"Day","30m","Plank",1,,0,,60,,,,'].join("\n");
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.reps).toBe(0);
    expect(groups[0]?.sets[0]?.seconds).toBe(60);
  });

  it("quoted field at last position", () => {
    const csv = [csvHeader, '2024-11-02,Day,1h,Bench,1,100,10,,,,,"9"'].join("\n");
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.rpe).toBe(9);
  });

  it("quoted field with escaped quotes inside", () => {
    const csv = [csvHeader, '2024-11-02,Day,1h,"Bench ""Heavy""",1,100,10,,,,,,'].join("\n");
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.exerciseName).toBe('Bench "Heavy"');
  });

  it("empty quoted field produces empty string", () => {
    const csv = [csvHeader, '2024-11-02,Day,1h,"",1,100,10,,,,,,'].join("\n");
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.exerciseName).toBe("");
  });

  it("verifies each field index maps to correct property", () => {
    // Explicit: Date(0), WorkoutName(1), Duration(2), ExerciseName(3), SetOrder(4),
    // Weight(5), Reps(6), Distance(7), Seconds(8), Notes(9), WorkoutNotes(10), RPE(11)
    const csv = [
      csvHeader,
      "2024-12-25 08:00:00,Xmas,2h,Squat (Barbell),2,200.5,5,1.5,90,Heavy set,Great session,9.5",
    ].join("\n");
    const groups = parseStrongCsv(csv);
    const set = groups[0]?.sets[0];
    expect(set?.date).toBe("2024-12-25 08:00:00");
    expect(set?.workoutName).toBe("Xmas");
    expect(set?.duration).toBe("2h");
    expect(set?.exerciseName).toBe("Squat (Barbell)");
    expect(set?.setOrder).toBe(2);
    expect(set?.weight).toBe(200.5);
    expect(set?.reps).toBe(5);
    expect(set?.distance).toBe(1.5);
    expect(set?.seconds).toBe(90);
    expect(set?.notes).toBe("Heavy set");
    expect(set?.workoutNotes).toBe("Great session");
    expect(set?.rpe).toBe(9.5);
  });

  it("non-numeric weight returns null", () => {
    const csv = [csvHeader, "2024-11-02,Day,1h,Bench,1,abc,10,,,,,,"].join("\n");
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.weight).toBeNull();
  });

  it("whitespace-only weight returns null", () => {
    const csv = [csvHeader, '2024-11-02,Day,1h,Bench,1," ",10,,,,,,'].join("\n");
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.weight).toBeNull();
  });

  it("parseStrongCsv strips BOM before splitting", () => {
    const csv = `\uFEFF${csvHeader}\n2024-11-02,Day,1h,Bench,1,100,10,,,,,,`;
    const groups = parseStrongCsv(csv);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.date).toBe("2024-11-02");
  });
});

// ============================================================
// isStrongCsvFormat
// ============================================================

describe("isStrongCsvFormat", () => {
  it("returns true for standard CSV header", () => {
    const csv =
      "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE\n2024-11-02,Day,1h,Bench,1,100,10,,,,,,";
    expect(isStrongCsvFormat(csv)).toBe(true);
  });

  it("returns true for CSV with BOM", () => {
    const csv =
      "\uFEFFDate,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE\n2024-11-02,Day,1h,Bench,1,100,10,,,,,,";
    expect(isStrongCsvFormat(csv)).toBe(true);
  });

  it("returns false for single-workout text format", () => {
    const text =
      "Home\nFriday, April 10, 2026 at 16:39\n\nBench Press (Dumbbell)\nSet 1: 50 lb × 13";
    expect(isStrongCsvFormat(text)).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isStrongCsvFormat("")).toBe(false);
  });
});

// ============================================================
// parseStrongTextDate
// ============================================================

describe("parseStrongTextDate", () => {
  it("parses full date with day of week", () => {
    const date = parseStrongTextDate("Friday, April 10, 2026 at 16:39");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(3); // April = 3
    expect(date.getDate()).toBe(10);
    expect(date.getHours()).toBe(16);
    expect(date.getMinutes()).toBe(39);
  });

  it("parses date with single-digit day", () => {
    const date = parseStrongTextDate("Monday, January 5, 2026 at 9:00");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(0); // January = 0
    expect(date.getDate()).toBe(5);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(0);
  });

  it("parses all month names", () => {
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    for (let index = 0; index < months.length; index++) {
      const month = months[index];
      const date = parseStrongTextDate(`Monday, ${month} 1, 2026 at 12:00`);
      expect(date.getMonth()).toBe(index);
    }
  });

  it("returns Invalid Date for unrecognized format", () => {
    const date = parseStrongTextDate("not a date");
    expect(Number.isNaN(date.getTime())).toBe(true);
  });
});

// ============================================================
// parseStrongText — single workout text format
// ============================================================

describe("parseStrongText", () => {
  const sampleText = `Home
Friday, April 10, 2026 at 16:39

Bench Press (Dumbbell)
Set 1: 50 lb × 13
Set 2: 50 lb × 12
Set 3: 50 lb × 8

Bicep Curl (Dumbbell)
Set 1: 40 lb × 4
Set 2: 30 lb × 8
Set 3: 30 lb × 7

Overhead Press (Dumbbell)
Set 1: 40 lb × 7
Set 2: 40 lb × 8 [Failure]
Set 3: 40 lb × 7

Pull Up
Set 1: 8 reps
Set 2: 4 reps [Failure]
Set 3: 4 reps [Failure]

Crunch
Set 1: 17 reps
Set 2: 14 reps
Set 3: 14 reps
https://link.strong.app/uznhjfcx`;

  it("parses a single workout into one group", () => {
    const result = parseStrongText(sampleText);
    expect(result.groups).toHaveLength(1);
  });

  it("extracts workout name from first line", () => {
    const result = parseStrongText(sampleText);
    expect(result.groups[0]?.workoutName).toBe("Home");
  });

  it("parses the date correctly", () => {
    const result = parseStrongText(sampleText);
    const date = new Date(result.groups[0]?.date ?? "");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(3); // April
    expect(date.getDate()).toBe(10);
    expect(date.getHours()).toBe(16);
    expect(date.getMinutes()).toBe(39);
  });

  it("parses all exercises", () => {
    const result = parseStrongText(sampleText);
    const exerciseNames = new Set(result.groups[0]?.sets.map((set) => set.exerciseName));
    expect(exerciseNames).toEqual(
      new Set([
        "Bench Press (Dumbbell)",
        "Bicep Curl (Dumbbell)",
        "Overhead Press (Dumbbell)",
        "Pull Up",
        "Crunch",
      ]),
    );
  });

  it("parses weighted sets with lb unit", () => {
    const result = parseStrongText(sampleText);
    const benchSets = result.groups[0]?.sets.filter(
      (set) => set.exerciseName === "Bench Press (Dumbbell)",
    );
    expect(benchSets).toHaveLength(3);
    expect(benchSets?.[0]?.weight).toBe(50);
    expect(benchSets?.[0]?.reps).toBe(13);
    expect(benchSets?.[1]?.weight).toBe(50);
    expect(benchSets?.[1]?.reps).toBe(12);
    expect(benchSets?.[2]?.weight).toBe(50);
    expect(benchSets?.[2]?.reps).toBe(8);
  });

  it("detects weight unit as lbs from lb text", () => {
    const result = parseStrongText(sampleText);
    expect(result.weightUnit).toBe("lbs");
  });

  it("parses bodyweight sets (reps only)", () => {
    const result = parseStrongText(sampleText);
    const pullUpSets = result.groups[0]?.sets.filter((set) => set.exerciseName === "Pull Up");
    expect(pullUpSets).toHaveLength(3);
    expect(pullUpSets?.[0]?.weight).toBeNull();
    expect(pullUpSets?.[0]?.reps).toBe(8);
    expect(pullUpSets?.[1]?.reps).toBe(4);
  });

  it("parses set order correctly", () => {
    const result = parseStrongText(sampleText);
    const benchSets = result.groups[0]?.sets.filter(
      (set) => set.exerciseName === "Bench Press (Dumbbell)",
    );
    expect(benchSets?.[0]?.setOrder).toBe(1);
    expect(benchSets?.[1]?.setOrder).toBe(2);
    expect(benchSets?.[2]?.setOrder).toBe(3);
  });

  it("ignores share URL at end", () => {
    const result = parseStrongText(sampleText);
    const exerciseNames = result.groups[0]?.sets.map((set) => set.exerciseName);
    expect(exerciseNames).not.toContain("https://link.strong.app/uznhjfcx");
  });

  it("sets duration to empty string (not available in text format)", () => {
    const result = parseStrongText(sampleText);
    expect(result.groups[0]?.duration).toBe("");
  });

  it("handles kg weight unit", () => {
    const kgText = `Workout
Monday, January 5, 2026 at 9:00

Squat (Barbell)
Set 1: 100 kg × 5
Set 2: 100 kg × 5`;
    const result = parseStrongText(kgText);
    expect(result.weightUnit).toBe("kg");
    expect(result.groups[0]?.sets[0]?.weight).toBe(100);
  });

  it("handles text without trailing URL", () => {
    const text = `Gym
Monday, January 5, 2026 at 9:00

Pull Up
Set 1: 10 reps
Set 2: 8 reps`;
    const result = parseStrongText(text);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.sets).toHaveLength(2);
  });

  it("returns empty groups for empty input", () => {
    const result = parseStrongText("");
    expect(result.groups).toEqual([]);
  });

  it("handles sets with varying weights within same exercise", () => {
    const text = `Workout
Monday, January 5, 2026 at 9:00

Bicep Curl (Dumbbell)
Set 1: 40 lb × 4
Set 2: 30 lb × 8
Set 3: 30 lb × 7`;
    const result = parseStrongText(text);
    const sets = result.groups[0]?.sets;
    expect(sets?.[0]?.weight).toBe(40);
    expect(sets?.[1]?.weight).toBe(30);
    expect(sets?.[2]?.weight).toBe(30);
  });

  it("defaults to kg when no weighted sets exist", () => {
    const text = `Bodyweight
Monday, January 5, 2026 at 9:00

Pull Up
Set 1: 10 reps
Set 2: 8 reps`;
    const result = parseStrongText(text);
    expect(result.weightUnit).toBe("kg");
  });

  it("handles decimal weights", () => {
    const text = `Workout
Monday, January 5, 2026 at 9:00

Bench Press (Barbell)
Set 1: 67.5 kg × 8`;
    const result = parseStrongText(text);
    expect(result.groups[0]?.sets[0]?.weight).toBe(67.5);
  });
});

describe("parseOptionalFloat", () => {
  it("returns number for valid float", () => {
    expect(parseOptionalFloat("12.5")).toBe(12.5);
  });

  it("returns number for valid integer string", () => {
    expect(parseOptionalFloat("100")).toBe(100);
  });

  it("returns null for empty string", () => {
    expect(parseOptionalFloat("")).toBeNull();
  });

  it("returns null for whitespace-only", () => {
    expect(parseOptionalFloat("  ")).toBeNull();
  });

  it("returns null for non-numeric", () => {
    expect(parseOptionalFloat("abc")).toBeNull();
  });

  it("returns 0 for '0'", () => {
    expect(parseOptionalFloat("0")).toBe(0);
  });

  it("returns 0 for '0.0'", () => {
    expect(parseOptionalFloat("0.0")).toBe(0);
  });

  it("handles leading whitespace", () => {
    expect(parseOptionalFloat("  42.5")).toBe(42.5);
  });

  it("returns null for tab-only", () => {
    expect(parseOptionalFloat("\t")).toBeNull();
  });
});

describe("parseOptionalInt", () => {
  it("returns number for valid integer", () => {
    expect(parseOptionalInt("10")).toBe(10);
  });

  it("returns null for empty string", () => {
    expect(parseOptionalInt("")).toBeNull();
  });

  it("returns null for whitespace-only", () => {
    expect(parseOptionalInt("   ")).toBeNull();
  });

  it("returns null for non-numeric", () => {
    expect(parseOptionalInt("abc")).toBeNull();
  });

  it("returns 0 for '0'", () => {
    expect(parseOptionalInt("0")).toBe(0);
  });

  it("truncates float to int", () => {
    expect(parseOptionalInt("12.5")).toBe(12);
  });

  it("handles leading whitespace", () => {
    expect(parseOptionalInt("  7")).toBe(7);
  });
});
