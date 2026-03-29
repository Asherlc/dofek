import { describe, expect, it, vi } from "vitest";
import {
  ElevationWeek,
  HikingActivity,
  HikingRepository,
  RepeatedRoute,
  WalkingBiomechanicsSnapshot,
} from "./hiking-repository.ts";

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

describe("HikingActivity", () => {
  function makeRow(overrides: Partial<HikingActivity["row"]> = {}) {
    return {
      date: "2024-01-15",
      activityName: "Morning Hike",
      activityType: "hiking",
      distanceMeters: 5000,
      durationSeconds: 3600,
      elevationGainMeters: 300,
      elevationLossMeters: 100,
      averageGradePercent: 4,
      ...overrides,
    };
  }

  it("computes distance in kilometers", () => {
    const activity = new HikingActivity(makeRow({ distanceMeters: 5000 }));
    expect(activity.distanceKm).toBeCloseTo(5.0, 2);
  });

  it("computes duration in minutes", () => {
    const activity = new HikingActivity(makeRow({ durationSeconds: 3600 }));
    expect(activity.durationMinutes).toBeCloseTo(60.0, 1);
  });

  it("computes average pace (min/km)", () => {
    const activity = new HikingActivity(makeRow({ distanceMeters: 5000, durationSeconds: 3600 }));
    expect(activity.averagePaceMinPerKm).toBeCloseTo(12.0, 2);
  });

  it("returns 0 pace when distance is 0", () => {
    const activity = new HikingActivity(makeRow({ distanceMeters: 0 }));
    expect(activity.averagePaceMinPerKm).toBe(0);
  });

  it("computes grade-adjusted pace (uphill = faster adjusted pace)", () => {
    const activity = new HikingActivity(makeRow({ averageGradePercent: 4 }));
    expect(activity.gradeAdjustedPaceMinPerKm).toBeLessThan(activity.averagePaceMinPerKm);
  });

  it("computes grade-adjusted pace (downhill = slower adjusted pace)", () => {
    const activity = new HikingActivity(
      makeRow({ averageGradePercent: -3, distanceMeters: 5000, durationSeconds: 3000 }),
    );
    expect(activity.gradeAdjustedPaceMinPerKm).toBeGreaterThan(activity.averagePaceMinPerKm);
  });

  it("serializes to API shape", () => {
    const activity = new HikingActivity(makeRow());
    const detail = activity.toDetail();

    expect(detail.date).toBe("2024-01-15");
    expect(detail.activityName).toBe("Morning Hike");
    expect(detail.activityType).toBe("hiking");
    expect(detail.distanceKm).toBe(5);
    expect(detail.durationMinutes).toBe(60);
    expect(detail.averagePaceMinPerKm).toBe(12);
    expect(detail.elevationGainMeters).toBe(300);
    expect(detail.elevationLossMeters).toBe(100);
    expect(typeof detail.gradeAdjustedPaceMinPerKm).toBe("number");
  });
});

describe("ElevationWeek", () => {
  it("serializes to API shape", () => {
    const week = new ElevationWeek({
      week: "2024-01-15",
      elevationGainMeters: 1500,
      activityCount: 3,
      totalDistanceKm: 25.5,
    });
    expect(week.toDetail()).toEqual({
      week: "2024-01-15",
      elevationGainMeters: 1500,
      activityCount: 3,
      totalDistanceKm: 25.5,
    });
  });
});

describe("WalkingBiomechanicsSnapshot", () => {
  it("converts walking speed from m/s to km/h", () => {
    const snapshot = new WalkingBiomechanicsSnapshot({
      date: "2024-01-15",
      walkingSpeedMps: 1.5,
      stepLengthCm: 75,
      doubleSupportPct: 25.3,
      asymmetryPct: null,
      steadiness: null,
    });
    const detail = snapshot.toDetail();
    expect(detail.walkingSpeedKmh).toBeCloseTo(5.4, 2);
  });

  it("returns null speed when source is null", () => {
    const snapshot = new WalkingBiomechanicsSnapshot({
      date: "2024-01-15",
      walkingSpeedMps: null,
      stepLengthCm: null,
      doubleSupportPct: null,
      asymmetryPct: null,
      steadiness: null,
    });
    expect(snapshot.toDetail().walkingSpeedKmh).toBeNull();
  });

  it("preserves null fields", () => {
    const snapshot = new WalkingBiomechanicsSnapshot({
      date: "2024-01-15",
      walkingSpeedMps: 1.5,
      stepLengthCm: null,
      doubleSupportPct: null,
      asymmetryPct: null,
      steadiness: null,
    });
    const detail = snapshot.toDetail();
    expect(detail.stepLengthCm).toBeNull();
    expect(detail.doubleSupportPct).toBeNull();
    expect(detail.asymmetryPct).toBeNull();
    expect(detail.steadiness).toBeNull();
  });
});

describe("RepeatedRoute", () => {
  it("groups instances under a route name", () => {
    const route = new RepeatedRoute("Trail Loop", [
      {
        date: "2024-01-01",
        durationMinutes: 60,
        averagePaceMinPerKm: 8.5,
        avgHeartRate: 145,
        elevationGainMeters: 200,
      },
      {
        date: "2024-01-15",
        durationMinutes: 55,
        averagePaceMinPerKm: 8.2,
        avgHeartRate: 140,
        elevationGainMeters: 200,
      },
    ]);
    const detail = route.toDetail();
    expect(detail.activityName).toBe("Trail Loop");
    expect(detail.instances).toHaveLength(2);
  });

  it("handles null heart rate in instances", () => {
    const route = new RepeatedRoute("Walk", [
      {
        date: "2024-01-01",
        durationMinutes: 30,
        averagePaceMinPerKm: 10,
        avgHeartRate: null,
        elevationGainMeters: 50,
      },
    ]);
    expect(route.toDetail().instances[0]?.avgHeartRate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("HikingRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const db = { execute };
    const repo = new HikingRepository(db, "user-1", "UTC");
    return { repo, execute };
  }

  describe("getGradeAdjustedPaces", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getGradeAdjustedPaces(90);
      expect(result).toEqual([]);
    });

    it("returns HikingActivity instances", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-01-15",
          activity_name: "Morning Hike",
          activity_type: "hiking",
          distance_m: 5000,
          duration_seconds: 3600,
          elevation_gain_m: 300,
          elevation_loss_m: 100,
          avg_grade: 4,
        },
      ]);
      const result = await repo.getGradeAdjustedPaces(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(HikingActivity);
      expect(result[0]?.distanceKm).toBeCloseTo(5.0, 2);
    });

    it("passes days parameter to query", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getGradeAdjustedPaces(30);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getElevationProfile", () => {
    it("returns ElevationWeek instances", async () => {
      const { repo } = makeRepository([
        { week: "2024-01-15", elevation_gain_m: 1500, activity_count: 3, total_distance_km: 25.5 },
      ]);
      const result = await repo.getElevationProfile(365);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(ElevationWeek);
      expect(result[0]?.toDetail().elevationGainMeters).toBe(1500);
    });
  });

  describe("getWalkingBiomechanics", () => {
    it("returns WalkingBiomechanicsSnapshot instances", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-01-15",
          walking_speed: 1.5,
          step_length: 75,
          double_support_pct: 25.3,
          asymmetry_pct: null,
          steadiness: null,
        },
      ]);
      const result = await repo.getWalkingBiomechanics(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(WalkingBiomechanicsSnapshot);
    });
  });

  describe("getRepeatedRoutes", () => {
    it("returns RepeatedRoute instances grouped by name", async () => {
      const { repo } = makeRepository([
        {
          activity_name: "Trail Loop",
          date: "2024-01-01",
          duration_minutes: 60,
          average_pace_min_per_km: 8.5,
          avg_heart_rate: 145,
          elevation_gain_m: 200,
        },
        {
          activity_name: "Trail Loop",
          date: "2024-01-15",
          duration_minutes: 55,
          average_pace_min_per_km: 8.2,
          avg_heart_rate: 140,
          elevation_gain_m: 200,
        },
      ]);
      const result = await repo.getRepeatedRoutes(365);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(RepeatedRoute);
      expect(result[0]?.toDetail().activityName).toBe("Trail Loop");
      expect(result[0]?.toDetail().instances).toHaveLength(2);
    });

    it("handles null heart rate", async () => {
      const { repo } = makeRepository([
        {
          activity_name: "Walk",
          date: "2024-01-01",
          duration_minutes: 30,
          average_pace_min_per_km: 10,
          avg_heart_rate: null,
          elevation_gain_m: 50,
        },
        {
          activity_name: "Walk",
          date: "2024-01-02",
          duration_minutes: 35,
          average_pace_min_per_km: 9.5,
          avg_heart_rate: 130,
          elevation_gain_m: 55,
        },
      ]);
      const result = await repo.getRepeatedRoutes(365);
      expect(result[0]?.toDetail().instances[0]?.avgHeartRate).toBeNull();
      expect(result[0]?.toDetail().instances[1]?.avgHeartRate).toBe(130);
    });
  });
});
