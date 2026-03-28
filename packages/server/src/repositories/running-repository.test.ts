import { describe, expect, it, vi } from "vitest";
import {
  PaceTrendActivity,
  RunningDynamicsActivity,
  RunningRepository,
} from "./running-repository.ts";

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

describe("RunningDynamicsActivity", () => {
  function makeRow(
    overrides: Partial<RunningDynamicsActivity["toDetail"]> & Record<string, unknown> = {},
  ) {
    return {
      date: "2024-06-10",
      activityName: "Morning Run",
      avgCadence: 180,
      avgStrideLengthMeters: 1.2 satisfies number | null,
      avgStanceTimeMs: 220 satisfies number | null,
      avgVerticalOscillationMm: 85 satisfies number | null,
      avgSpeed: 3.5,
      totalDistance: 10000,
      ...overrides,
    };
  }

  it("exposes date and activityName", () => {
    const activity = new RunningDynamicsActivity(makeRow());
    expect(activity.date).toBe("2024-06-10");
    expect(activity.activityName).toBe("Morning Run");
  });

  it("exposes cadence", () => {
    const activity = new RunningDynamicsActivity(makeRow({ avgCadence: 175 }));
    expect(activity.cadence).toBe(175);
  });

  it("exposes stride length, stance time, and vertical oscillation", () => {
    const activity = new RunningDynamicsActivity(makeRow());
    expect(activity.strideLengthMeters).toBe(1.2);
    expect(activity.stanceTimeMs).toBe(220);
    expect(activity.verticalOscillationMm).toBe(85);
  });

  it("handles null optional fields", () => {
    const activity = new RunningDynamicsActivity(
      makeRow({
        avgStrideLengthMeters: null,
        avgStanceTimeMs: null,
        avgVerticalOscillationMm: null,
      }),
    );
    expect(activity.strideLengthMeters).toBeNull();
    expect(activity.stanceTimeMs).toBeNull();
    expect(activity.verticalOscillationMm).toBeNull();
  });

  it("computes pace from average speed using 1000 / avgSpeed", () => {
    // 1000 / 3.5 = 285.71... => rounds to 286
    const activity = new RunningDynamicsActivity(makeRow({ avgSpeed: 3.5 }));
    expect(activity.paceSecondsPerKm).toBe(286);
  });

  it("uses 1000 (not 1609 for miles) in pace formula", () => {
    // 1000 / 2.5 = 400 exactly
    const activity = new RunningDynamicsActivity(makeRow({ avgSpeed: 2.5 }));
    expect(activity.paceSecondsPerKm).toBe(400);
    // If it used 1609 (miles), the result would be 644
    expect(activity.paceSecondsPerKm).not.toBe(644);
  });

  it("divides (not multiplies) 1000 by speed for pace", () => {
    // If it multiplied 1000 * speed, we'd get 1000 * 5 = 5000
    // Division gives 1000 / 5 = 200
    const activity = new RunningDynamicsActivity(makeRow({ avgSpeed: 5 }));
    expect(activity.paceSecondsPerKm).toBe(200);
    expect(activity.paceSecondsPerKm).not.toBe(5000);
  });

  it("returns 0 pace when speed is 0", () => {
    const activity = new RunningDynamicsActivity(makeRow({ avgSpeed: 0 }));
    expect(activity.paceSecondsPerKm).toBe(0);
  });

  it("computes distance in km by dividing by 1000 (m to km)", () => {
    // 10000 / 1000 = 10.0
    const activity = new RunningDynamicsActivity(makeRow({ totalDistance: 10000 }));
    expect(activity.distanceKm).toBe(10.0);
  });

  it("divides totalDistance by 1000 for km conversion", () => {
    // 5000 / 1000 = 5.0
    const activity = new RunningDynamicsActivity(makeRow({ totalDistance: 5000 }));
    expect(activity.distanceKm).toBe(5.0);
  });

  it("rounds distance correctly for non-round values", () => {
    // 7550 / 1000 = 7.55 => 7.55 * 10 = 75.5 => round = 76 => /10 = 7.6
    const activity = new RunningDynamicsActivity(makeRow({ totalDistance: 7550 }));
    expect(activity.distanceKm).toBe(7.6);
  });

  it("serializes to API shape via toDetail()", () => {
    const activity = new RunningDynamicsActivity(makeRow());
    const detail = activity.toDetail();

    expect(detail).toEqual({
      date: "2024-06-10",
      activityName: "Morning Run",
      cadence: 180,
      strideLengthMeters: 1.2,
      stanceTimeMs: 220,
      verticalOscillationMm: 85,
      paceSecondsPerKm: 286,
      distanceKm: 10.0,
    });
  });
});

describe("PaceTrendActivity", () => {
  function makeRow(overrides: Record<string, unknown> = {}) {
    return {
      date: "2024-06-10",
      activityName: "Evening Run",
      avgSpeed: 4.0,
      totalDistance: 8000,
      durationSeconds: 2400,
      ...overrides,
    };
  }

  it("exposes date and activityName", () => {
    const activity = new PaceTrendActivity(makeRow());
    expect(activity.date).toBe("2024-06-10");
    expect(activity.activityName).toBe("Evening Run");
  });

  it("computes pace from average speed", () => {
    // 1000 / 4.0 = 250
    const activity = new PaceTrendActivity(makeRow({ avgSpeed: 4.0 }));
    expect(activity.paceSecondsPerKm).toBe(250);
  });

  it("returns 0 pace when speed is 0", () => {
    const activity = new PaceTrendActivity(makeRow({ avgSpeed: 0 }));
    expect(activity.paceSecondsPerKm).toBe(0);
  });

  it("computes distance in km rounded to 1 decimal", () => {
    const activity = new PaceTrendActivity(makeRow({ totalDistance: 8000 }));
    expect(activity.distanceKm).toBe(8.0);
  });

  it("computes duration in whole minutes by dividing seconds by 60", () => {
    // 2400 / 60 = 40
    const activity = new PaceTrendActivity(makeRow({ durationSeconds: 2400 }));
    expect(activity.durationMinutes).toBe(40);
  });

  it("divides by 60 (not 3600) for seconds-to-minutes conversion", () => {
    // 3600 / 60 = 60 minutes
    // If divided by 3600, would give 1
    const activity = new PaceTrendActivity(makeRow({ durationSeconds: 3600 }));
    expect(activity.durationMinutes).toBe(60);
    expect(activity.durationMinutes).not.toBe(1);
  });

  it("rounds duration to nearest minute", () => {
    // 2530 / 60 = 42.16... => rounds to 42
    const activity = new PaceTrendActivity(makeRow({ durationSeconds: 2530 }));
    expect(activity.durationMinutes).toBe(42);
  });

  it("serializes to API shape via toDetail()", () => {
    const activity = new PaceTrendActivity(makeRow());
    const detail = activity.toDetail();

    expect(detail).toEqual({
      date: "2024-06-10",
      activityName: "Evening Run",
      paceSecondsPerKm: 250,
      distanceKm: 8.0,
      durationMinutes: 40,
    });
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("RunningRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const db = { execute };
    const repo = new RunningRepository(db, "user-1", "UTC");
    return { repo, execute };
  }

  describe("getDynamics", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getDynamics(90);
      expect(result).toEqual([]);
    });

    it("returns RunningDynamicsActivity instances", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-06-10",
          name: "Morning Run",
          avg_cadence: 180,
          avg_stride_length: 1.2,
          avg_stance_time: 220,
          avg_vertical_osc: 85,
          avg_speed: 3.5,
          total_distance: 10000,
        },
      ]);
      const result = await repo.getDynamics(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(RunningDynamicsActivity);
      expect(result[0]?.paceSecondsPerKm).toBe(286);
      expect(result[0]?.distanceKm).toBe(10.0);
    });

    it("passes days parameter to query", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getDynamics(30);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getPaceTrend", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getPaceTrend(90);
      expect(result).toEqual([]);
    });

    it("returns PaceTrendActivity instances", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-06-10",
          name: "Evening Run",
          avg_speed: 4.0,
          total_distance: 8000,
          duration_seconds: 2400,
        },
      ]);
      const result = await repo.getPaceTrend(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(PaceTrendActivity);
      expect(result[0]?.paceSecondsPerKm).toBe(250);
      expect(result[0]?.distanceKm).toBe(8.0);
      expect(result[0]?.durationMinutes).toBe(40);
    });

    it("passes days parameter to query", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getPaceTrend(60);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});
