import { describe, expect, it } from "vitest";
import { parseDurationString, parseStrongCsv, parseStrongExerciseName } from "../strong-csv.ts";

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
    const group = groups[0]!;
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
    const set = groups[0]!.sets[0]!;
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
});
