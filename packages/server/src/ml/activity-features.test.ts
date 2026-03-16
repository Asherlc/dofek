import { describe, expect, it } from "vitest";
import type { DailyContext } from "./activity-features.ts";
import {
  ACTIVITY_PREDICTION_TARGETS,
  buildActivityDataset,
  type CardioActivityRow,
  type StrengthWorkoutRow,
} from "./activity-features.ts";

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateDailyContext(n: number, seed: number = 42): DailyContext[] {
  const rng = mulberry32(seed);
  const days: DailyContext[] = [];
  for (let i = 0; i < n; i++) {
    const date = new Date(2024, 0, 1 + i).toISOString().slice(0, 10);
    days.push({
      date,
      hrv: 30 + rng() * 40,
      restingHr: 55 + rng() * 15,
      sleepDurationMin: 360 + rng() * 180,
      deepMin: 40 + rng() * 60,
      sleepEfficiency: 80 + rng() * 15,
      calories: 1800 + rng() * 1200,
      proteinG: 80 + rng() * 80,
      weightKg: 75 + rng() * 5,
      exerciseMinutes: Math.round(rng() * 90),
      steps: Math.round(5000 + rng() * 10000),
    });
  }
  return days;
}

function generateCardioActivities(
  n: number,
  context: DailyContext[],
  seed: number = 99,
): CardioActivityRow[] {
  const rng = mulberry32(seed);
  const activities: CardioActivityRow[] = [];
  // Spread activities over the date range, ~1 every 2-3 days
  let dayIdx = 3;
  for (let i = 0; i < n && dayIdx < context.length; i++) {
    const day = context[dayIdx];
    if (!day) throw new Error("expected day");
    // Avg power is influenced by recent sleep and training
    const recentSleep =
      context
        .slice(Math.max(0, dayIdx - 3), dayIdx)
        .reduce((sum, d) => sum + (d.sleepDurationMin ?? 0), 0) / 3;
    const avgPower = 150 + recentSleep * 0.1 + (rng() - 0.5) * 30;

    activities.push({
      date: day.date,
      activityType: rng() > 0.3 ? "cycling" : "running",
      durationMin: 30 + rng() * 90,
      avgHr: 130 + rng() * 30,
      avgPower: Math.round(avgPower),
      avgSpeed: 4 + rng() * 6,
      totalDistance: 10000 + rng() * 40000,
      elevationGain: rng() > 0.5 ? 100 + rng() * 500 : null,
      avgCadence: 80 + rng() * 20,
    });
    dayIdx += 2 + Math.floor(rng() * 2);
  }
  return activities;
}

function generateStrengthWorkouts(
  n: number,
  context: DailyContext[],
  seed: number = 77,
): StrengthWorkoutRow[] {
  const rng = mulberry32(seed);
  const workouts: StrengthWorkoutRow[] = [];
  let dayIdx = 3;
  for (let i = 0; i < n && dayIdx < context.length; i++) {
    const day = context[dayIdx];
    if (!day) throw new Error("expected day");
    // Volume influenced by recent nutrition
    const recentProtein =
      context
        .slice(Math.max(0, dayIdx - 3), dayIdx)
        .reduce((sum, d) => sum + (d.proteinG ?? 0), 0) / 3;
    const totalVolume = 5000 + recentProtein * 20 + (rng() - 0.5) * 2000;

    workouts.push({
      date: day.date,
      totalVolume: Math.round(totalVolume),
      workingSetCount: 12 + Math.floor(rng() * 12),
      maxWeight: 60 + rng() * 60,
      avgRpe: 6 + rng() * 3,
    });
    dayIdx += 2 + Math.floor(rng() * 3);
  }
  return workouts;
}

describe("buildActivityDataset", () => {
  const context = generateDailyContext(365);

  describe("cardio", () => {
    const target = ACTIVITY_PREDICTION_TARGETS.find((t) => t.id === "cardio_power");
    if (!target) throw new Error("expected cardio_power target");
    const activities = generateCardioActivities(80, context);

    it("builds a dataset from cardio activities", () => {
      const dataset = buildActivityDataset(activities, context, target);
      expect(dataset).not.toBeNull();
      expect(dataset?.X.length).toBeGreaterThan(20);
      expect(dataset?.y.length).toBe(dataset?.X.length);
      expect(dataset?.dates.length).toBe(dataset?.X.length);
      expect(dataset?.featureNames.length).toBeGreaterThan(3);
    });

    it("includes trailing context features", () => {
      const dataset = buildActivityDataset(activities, context, target);
      if (!dataset) throw new Error("expected dataset");
      const hasTrailingFeature = dataset.featureNames.some((n) => n.includes("3d"));
      expect(hasTrailingFeature).toBe(true);
    });

    it("does not include the target metric as a feature", () => {
      const dataset = buildActivityDataset(activities, context, target);
      if (!dataset) throw new Error("expected dataset");
      expect(dataset.featureNames).not.toContain("avg_power");
    });

    it("returns null with insufficient activities", () => {
      const fewActivities = activities.slice(0, 5);
      const dataset = buildActivityDataset(fewActivities, context, target);
      expect(dataset).toBeNull();
    });

    it("skips activities with null avgPower but succeeds when enough have power data", () => {
      // Mix of activities: some with power (cycling with meter), many without (running, hiking)
      const mixed: CardioActivityRow[] = [];
      let dayIdx = 3;
      for (let i = 0; i < 80 && dayIdx < context.length; i++) {
        const day = context[dayIdx];
        if (!day) break;
        const hasPower = i % 3 === 0; // ~27 out of 80 have power
        mixed.push({
          date: day.date,
          activityType: hasPower ? "cycling" : "running",
          durationMin: 45,
          avgHr: 145,
          avgPower: hasPower ? 180 + i : null,
          avgSpeed: 5,
          totalDistance: 15000,
          elevationGain: 200,
          avgCadence: 85,
        });
        dayIdx += 3;
      }
      const dataset = buildActivityDataset(mixed, context, target);
      // Should succeed — enough activities have power data
      expect(dataset).not.toBeNull();
      // All rows in the dataset should have valid target values
      if (dataset) {
        expect(dataset.y.every((v) => typeof v === "number" && !Number.isNaN(v))).toBe(true);
      }
    });
  });

  describe("strength", () => {
    const target = ACTIVITY_PREDICTION_TARGETS.find((t) => t.id === "strength_volume");
    if (!target) throw new Error("expected strength_volume target");
    const workouts = generateStrengthWorkouts(80, context);

    it("builds a dataset from strength workouts", () => {
      const dataset = buildActivityDataset(workouts, context, target);
      expect(dataset).not.toBeNull();
      expect(dataset?.X.length).toBeGreaterThan(20);
      expect(dataset?.featureNames.length).toBeGreaterThan(3);
    });

    it("does not include the target as a feature", () => {
      const dataset = buildActivityDataset(workouts, context, target);
      if (!dataset) throw new Error("expected dataset");
      expect(dataset.featureNames).not.toContain("total_volume");
    });

    it("returns null with insufficient workouts", () => {
      const fewWorkouts = workouts.slice(0, 5);
      const dataset = buildActivityDataset(fewWorkouts, context, target);
      expect(dataset).toBeNull();
    });
  });
});
