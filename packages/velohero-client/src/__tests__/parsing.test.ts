import { describe, expect, it } from "vitest";
import { parseDurationToSeconds, parseVeloHeroWorkout } from "../parsing.ts";
import type { VeloHeroWorkout } from "../types.ts";

// ============================================================
// parseDurationToSeconds
// ============================================================

describe("parseDurationToSeconds", () => {
  it("parses standard HH:MM:SS format", () => {
    expect(parseDurationToSeconds("01:30:00")).toBe(5400);
  });

  it("parses zero duration", () => {
    expect(parseDurationToSeconds("00:00:00")).toBe(0);
  });

  it("parses seconds only", () => {
    expect(parseDurationToSeconds("00:00:45")).toBe(45);
  });

  it("parses minutes and seconds", () => {
    expect(parseDurationToSeconds("00:15:30")).toBe(930);
  });

  it("parses large hours", () => {
    expect(parseDurationToSeconds("12:00:00")).toBe(43200);
  });

  it("returns 0 for invalid format with fewer than 3 parts", () => {
    expect(parseDurationToSeconds("30:00")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(parseDurationToSeconds("")).toBe(0);
  });

  it("returns 0 for single value", () => {
    expect(parseDurationToSeconds("3600")).toBe(0);
  });

  it("returns 0 for format with more than 3 parts", () => {
    // "1:2:3:4" splits into 4 parts, so parts.length !== 3
    expect(parseDurationToSeconds("1:2:3:4")).toBe(0);
  });
});

// ============================================================
// parseVeloHeroWorkout
// ============================================================

describe("parseVeloHeroWorkout", () => {
  function makeWorkout(overrides: Partial<VeloHeroWorkout> = {}): VeloHeroWorkout {
    return {
      id: "1001",
      date_ymd: "2024-01-15",
      start_time: "08:00:00",
      dur_time: "01:30:00",
      sport_id: "1",
      dist_km: "42.5",
      title: "Morning ride",
      avg_hr: "145",
      max_hr: "175",
      avg_power: "200",
      max_power: "350",
      avg_cadence: "90",
      max_cadence: "110",
      calories: "900",
      ascent: "500",
      descent: "480",
      ...overrides,
    };
  }

  it("parses a complete workout", () => {
    const result = parseVeloHeroWorkout(makeWorkout());

    expect(result.externalId).toBe("1001");
    expect(result.activityType).toBe("cycling");
    expect(result.name).toBe("Morning ride");
    expect(result.startedAt).toEqual(new Date("2024-01-15T08:00:00"));
    expect(result.endedAt).toEqual(new Date("2024-01-15T09:30:00"));

    expect(result.raw.durationSeconds).toBe(5400);
    expect(result.raw.distanceMeters).toBe(42500);
    expect(result.raw.avgHeartRate).toBe(145);
    expect(result.raw.maxHeartRate).toBe(175);
    expect(result.raw.avgPower).toBe(200);
    expect(result.raw.maxPower).toBe(350);
    expect(result.raw.avgCadence).toBe(90);
    expect(result.raw.maxCadence).toBe(110);
    expect(result.raw.calories).toBe(900);
    expect(result.raw.ascent).toBe(500);
    expect(result.raw.descent).toBe(480);
  });

  it("uses default start_time of 00:00:00 when missing", () => {
    const result = parseVeloHeroWorkout(makeWorkout({ start_time: "" }));

    expect(result.startedAt).toEqual(new Date("2024-01-15T00:00:00"));
  });

  it("generates default name from sport when title is empty", () => {
    const result = parseVeloHeroWorkout(makeWorkout({ title: "" }));

    expect(result.name).toBe("cycling workout");
  });

  it("generates default name from sport when title is undefined", () => {
    const result = parseVeloHeroWorkout(makeWorkout({ title: undefined }));

    expect(result.name).toBe("cycling workout");
  });

  it("handles missing optional numeric fields", () => {
    const result = parseVeloHeroWorkout(
      makeWorkout({
        avg_hr: undefined,
        max_hr: undefined,
        avg_power: undefined,
        max_power: undefined,
        avg_cadence: undefined,
        max_cadence: undefined,
        calories: undefined,
        ascent: undefined,
        descent: undefined,
      }),
    );

    expect(result.raw.avgHeartRate).toBeUndefined();
    expect(result.raw.maxHeartRate).toBeUndefined();
    expect(result.raw.avgPower).toBeUndefined();
    expect(result.raw.maxPower).toBeUndefined();
    expect(result.raw.avgCadence).toBeUndefined();
    expect(result.raw.maxCadence).toBeUndefined();
    expect(result.raw.calories).toBeUndefined();
    expect(result.raw.ascent).toBeUndefined();
    expect(result.raw.descent).toBeUndefined();
  });

  it("handles empty string numeric fields", () => {
    const result = parseVeloHeroWorkout(
      makeWorkout({
        dist_km: "",
        avg_hr: "",
        max_hr: "",
        avg_power: "",
        max_power: "",
      }),
    );

    expect(result.raw.distanceMeters).toBeUndefined();
    expect(result.raw.avgHeartRate).toBeUndefined();
    expect(result.raw.maxHeartRate).toBeUndefined();
    expect(result.raw.avgPower).toBeUndefined();
    expect(result.raw.maxPower).toBeUndefined();
  });

  it("handles whitespace-only numeric fields", () => {
    const result = parseVeloHeroWorkout(
      makeWorkout({
        avg_hr: "  ",
        max_hr: "  ",
      }),
    );

    expect(result.raw.avgHeartRate).toBeUndefined();
    expect(result.raw.maxHeartRate).toBeUndefined();
  });

  it("handles non-numeric values in optional fields", () => {
    const result = parseVeloHeroWorkout(
      makeWorkout({
        avg_hr: "not-a-number",
        max_hr: "abc",
      }),
    );

    expect(result.raw.avgHeartRate).toBeUndefined();
    expect(result.raw.maxHeartRate).toBeUndefined();
  });

  it("maps unknown sport_id to other", () => {
    const result = parseVeloHeroWorkout(makeWorkout({ sport_id: "999" }));

    expect(result.activityType).toBe("other");
  });

  it("maps running sport", () => {
    const result = parseVeloHeroWorkout(makeWorkout({ sport_id: "2" }));

    expect(result.activityType).toBe("running");
  });

  it("converts distance km to meters with rounding", () => {
    const result = parseVeloHeroWorkout(makeWorkout({ dist_km: "10.123" }));

    expect(result.raw.distanceMeters).toBe(10123);
  });

  it("rounds distance correctly", () => {
    const result = parseVeloHeroWorkout(makeWorkout({ dist_km: "0.001" }));

    expect(result.raw.distanceMeters).toBe(1);
  });

  it("converts id to string", () => {
    const workout = makeWorkout();
    // The id is already a string, but test the String() conversion
    const result = parseVeloHeroWorkout(workout);
    expect(typeof result.externalId).toBe("string");
  });
});
