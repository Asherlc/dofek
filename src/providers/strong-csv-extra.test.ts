import { describe, expect, it } from "vitest";
import {
  parseDurationString,
  parseStrongCsv,
  parseStrongExerciseName,
  STRONG_PROVIDER_ID,
  StrongCsvProvider,
} from "./strong-csv.ts";

// ============================================================
// Tests targeting uncovered CSV parsing paths in strong-csv.ts
// ============================================================

describe("parseStrongExerciseName", () => {
  it("extracts exercise name and equipment from parenthetical format", () => {
    const result = parseStrongExerciseName("Bench Press (Barbell)");
    expect(result.exerciseName).toBe("Bench Press");
    expect(result.equipment).toBe("Barbell");
  });

  it("handles no equipment in parentheses", () => {
    const result = parseStrongExerciseName("Push Up");
    expect(result.exerciseName).toBe("Push Up");
    expect(result.equipment).toBeNull();
  });

  it("trims whitespace", () => {
    const result = parseStrongExerciseName("  Squat (Barbell)  ");
    expect(result.exerciseName).toBe("Squat");
    expect(result.equipment).toBe("Barbell");
  });

  it("handles multiple parenthetical entries", () => {
    const result = parseStrongExerciseName("Curl (Dumbbell)");
    expect(result.exerciseName).toBe("Curl");
    expect(result.equipment).toBe("Dumbbell");
  });
});

describe("parseDurationString", () => {
  it("parses HH:MM:SS format", () => {
    expect(parseDurationString("1:30:00")).toBe(5400);
    expect(parseDurationString("0:45:30")).toBe(2730);
    expect(parseDurationString("2:00:00")).toBe(7200);
  });

  it("parses Xh Ym format", () => {
    expect(parseDurationString("1h 30m")).toBe(5400);
    expect(parseDurationString("2h")).toBe(7200);
    expect(parseDurationString("45m")).toBe(2700);
    expect(parseDurationString("1h 0m")).toBe(3600);
  });

  it("returns 0 for empty string", () => {
    expect(parseDurationString("")).toBe(0);
  });

  it("returns 0 for unrecognized format", () => {
    expect(parseDurationString("invalid")).toBe(0);
  });
});

describe("parseStrongCsv", () => {
  const header =
    "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE";

  it("returns empty for empty input", () => {
    expect(parseStrongCsv("")).toEqual([]);
  });

  it("returns empty for header only", () => {
    expect(parseStrongCsv(header)).toEqual([]);
  });

  it("parses a single workout with sets", () => {
    const rows = [
      "2026-03-01 10:00:00,Full Body,1:00:00,Bench Press (Barbell),1,100,8,,,,,",
      "2026-03-01 10:00:00,Full Body,1:00:00,Bench Press (Barbell),2,100,8,,,,,",
      "2026-03-01 10:00:00,Full Body,1:00:00,Squat (Barbell),1,120,5,,,,,",
    ];
    const csv = `${header}\n${rows.join("\n")}`;
    const groups = parseStrongCsv(csv);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.workoutName).toBe("Full Body");
    expect(groups[0]?.duration).toBe("1:00:00");
    expect(groups[0]?.sets).toHaveLength(3);
    expect(groups[0]?.sets[0]?.exerciseName).toBe("Bench Press (Barbell)");
    expect(groups[0]?.sets[0]?.weight).toBe(100);
    expect(groups[0]?.sets[0]?.reps).toBe(8);
    expect(groups[0]?.sets[0]?.setOrder).toBe(1);
  });

  it("groups by date + workout name", () => {
    const rows = [
      "2026-03-01 10:00:00,Morning,1h,Squat (Barbell),1,100,5,,,,,",
      "2026-03-01 18:00:00,Evening,45m,Bench Press (Barbell),1,80,8,,,,,",
    ];
    const csv = `${header}\n${rows.join("\n")}`;
    const groups = parseStrongCsv(csv);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.workoutName).toBe("Morning");
    expect(groups[1]?.workoutName).toBe("Evening");
  });

  it("parses distance and seconds fields", () => {
    const row = "2026-03-01 10:00:00,Cardio,30m,Treadmill Run,1,,,,1800,,,";
    const csv = `${header}\n${row}`;
    const groups = parseStrongCsv(csv);

    expect(groups[0]?.sets[0]?.seconds).toBe(1800);
    expect(groups[0]?.sets[0]?.weight).toBeNull();
    expect(groups[0]?.sets[0]?.reps).toBeNull();
  });

  it("parses notes and workout notes", () => {
    const row = "2026-03-01 10:00:00,Test,30m,Curl (Dumbbell),1,20,12,,,Set note,Workout note,8";
    const csv = `${header}\n${row}`;
    const groups = parseStrongCsv(csv);

    expect(groups[0]?.sets[0]?.notes).toBe("Set note");
    expect(groups[0]?.workoutNotes).toBe("Workout note");
    expect(groups[0]?.sets[0]?.rpe).toBe(8);
  });

  it("handles BOM-prefixed CSV", () => {
    const csv = `\uFEFF${header}\n2026-03-01 10:00:00,Test,30m,Press,1,50,10,,,,,`;
    const groups = parseStrongCsv(csv);
    expect(groups).toHaveLength(1);
  });

  it("skips lines with too few fields", () => {
    const csv = `${header}\nshort,line`;
    const groups = parseStrongCsv(csv);
    expect(groups).toHaveLength(0);
  });

  it("handles quoted fields with commas", () => {
    const csv = `${header}\n2026-03-01 10:00:00,"Push, Pull",1h,"Deadlift (Barbell)",1,180,3,,,,,`;
    const groups = parseStrongCsv(csv);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.workoutName).toBe("Push, Pull");
  });

  it("captures workout notes from any row when first row lacks them", () => {
    const rows = [
      "2026-03-01 10:00:00,Test,1h,Squat,1,100,5,,,,,,",
      "2026-03-01 10:00:00,Test,1h,Squat,2,100,5,,,Set 2 note,Great workout,",
    ];
    const csv = `${header}\n${rows.join("\n")}`;
    const groups = parseStrongCsv(csv);

    expect(groups[0]?.workoutNotes).toBe("Great workout");
  });

  it("handles distance field", () => {
    const row = "2026-03-01 10:00:00,Cardio,30m,Walk,1,,,2.5,1800,,,";
    const csv = `${header}\n${row}`;
    const groups = parseStrongCsv(csv);
    expect(groups[0]?.sets[0]?.distance).toBe(2.5);
  });
});

describe("StrongCsvProvider", () => {
  it("has correct id and name", () => {
    const provider = new StrongCsvProvider();
    expect(provider.id).toBe(STRONG_PROVIDER_ID);
    expect(provider.name).toBe("Strong");
  });

  it("validate always returns null", () => {
    const provider = new StrongCsvProvider();
    expect(provider.validate()).toBeNull();
  });

  it("sync returns zero records", async () => {
    const provider = new StrongCsvProvider();
    // @ts-expect-error mock DB
    const result = await provider.sync({}, new Date());
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
