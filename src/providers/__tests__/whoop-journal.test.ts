import { describe, expect, it } from "vitest";
import { parseWorkout, type WhoopWorkoutRecord } from "../whoop.ts";

// ============================================================
// Tests for parseJournalResponse (internal function, tested
// indirectly via module line coverage) and parseWorkout fallback
// paths that are currently uncovered.
//
// parseJournalResponse is not exported, so we can't test it
// directly. Instead we focus on parseWorkout edge cases that
// cover the uncovered lines 124-148.
// ============================================================

describe("parseWorkout — fallback paths (no `during` field)", () => {
  it("falls back to start/end when `during` is missing", () => {
    const record = {
      activity_id: "uuid-fallback-1",
      timezone_offset: "-05:00",
      sport_id: 0,
      start: "2026-03-01T10:00:00Z",
      end: "2026-03-01T11:00:00Z",
      average_heart_rate: 140,
      max_heart_rate: 175,
      kilojoules: 2000,
      score: 10,
    } as WhoopWorkoutRecord;

    const parsed = parseWorkout(record);
    expect(parsed.startedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
    expect(parsed.endedAt).toEqual(new Date("2026-03-01T11:00:00Z"));
    expect(parsed.durationSeconds).toBe(3600);
    expect(parsed.avgHeartRate).toBe(140);
    expect(parsed.maxHeartRate).toBe(175);
    expect(parsed.calories).toBe(478); // 2000 / 4.184 ≈ 478
  });

  it("falls back to created_at/updated_at when start/end are missing", () => {
    const record = {
      activity_id: "uuid-fallback-2",
      timezone_offset: "-05:00",
      sport_id: 1, // cycling
      created_at: "2026-03-01T09:00:00Z",
      updated_at: "2026-03-01T10:30:00Z",
      score: 8,
    } as WhoopWorkoutRecord;

    const parsed = parseWorkout(record);
    expect(parsed.startedAt).toEqual(new Date("2026-03-01T09:00:00Z"));
    expect(parsed.endedAt).toEqual(new Date("2026-03-01T10:30:00Z"));
    expect(parsed.durationSeconds).toBe(5400);
    expect(parsed.activityType).toBe("cycling");
  });

  it("uses record.id when activity_id is missing", () => {
    const record = {
      id: 98765,
      during: "['2026-03-01T10:00:00Z','2026-03-01T10:30:00Z')",
      timezone_offset: "-05:00",
      sport_id: 44, // yoga
      score: 3,
    } as WhoopWorkoutRecord;

    const parsed = parseWorkout(record);
    expect(parsed.externalId).toBe("98765");
    expect(parsed.activityType).toBe("yoga");
  });

  it("uses empty string when both activity_id and id are missing", () => {
    const record = {
      during: "['2026-03-01T10:00:00Z','2026-03-01T10:30:00Z')",
      timezone_offset: "-05:00",
      sport_id: 0,
      score: 5,
    } as WhoopWorkoutRecord;

    const parsed = parseWorkout(record);
    expect(parsed.externalId).toBe("");
  });

  it("returns undefined calories when kilojoules is 0", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-zero-kj",
      during: "['2026-03-01T10:00:00Z','2026-03-01T10:30:00Z')",
      timezone_offset: "-05:00",
      sport_id: 0,
      kilojoules: 0,
      score: 1,
    };

    const parsed = parseWorkout(record);
    expect(parsed.calories).toBeUndefined();
  });

  it("returns undefined calories when kilojoules is not present", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-no-kj",
      during: "['2026-03-01T10:00:00Z','2026-03-01T10:30:00Z')",
      timezone_offset: "-05:00",
      sport_id: 0,
      score: 2,
    };

    const parsed = parseWorkout(record);
    expect(parsed.calories).toBeUndefined();
  });

  it("always returns undefined for distanceMeters and totalElevationGain", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-no-distance",
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      timezone_offset: "-05:00",
      sport_id: 0,
      score: 5,
      average_heart_rate: 150,
      max_heart_rate: 180,
      kilojoules: 3000,
    };

    const parsed = parseWorkout(record);
    expect(parsed.distanceMeters).toBeUndefined();
    expect(parsed.totalElevationGain).toBeUndefined();
  });
});

describe("WhoopProvider basic properties", () => {
  // Import the provider to test its basic properties
  it("has correct id and name", async () => {
    const { WhoopProvider } = await import("../whoop.ts");
    const provider = new WhoopProvider();
    expect(provider.id).toBe("whoop");
    expect(provider.name).toBe("WHOOP");
  });

  it("validate returns null (always enabled)", async () => {
    const { WhoopProvider } = await import("../whoop.ts");
    const provider = new WhoopProvider();
    expect(provider.validate()).toBeNull();
  });
});
