import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.js";
import { streamHealthExport } from "../apple-health.js";
import * as schema from "../../db/schema.js";

// ============================================================
// Integration test — stream Apple Health XML → DB
// ============================================================

// Minimal but representative Apple Health export XML
const SAMPLE_EXPORT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!ELEMENT HealthData (ExportDate,Me,(Record|Workout|ActivitySummary)*)>
]>
<HealthData locale="en_US">
 <ExportDate value="2024-03-02 12:00:00 -0500"/>
 <Me HKCharacteristicTypeIdentifierDateOfBirth="1990-01-01"/>

 <Record type="HKQuantityTypeIdentifierHeartRate"
  sourceName="Apple Watch" unit="count/min"
  creationDate="2024-03-01 10:00:00 -0500"
  startDate="2024-03-01 10:00:00 -0500"
  endDate="2024-03-01 10:00:05 -0500"
  value="72"/>

 <Record type="HKQuantityTypeIdentifierHeartRate"
  sourceName="Apple Watch" unit="count/min"
  creationDate="2024-03-01 10:00:05 -0500"
  startDate="2024-03-01 10:00:05 -0500"
  endDate="2024-03-01 10:00:10 -0500"
  value="74"/>

 <Record type="HKQuantityTypeIdentifierBodyMass"
  sourceName="Withings" unit="kg"
  creationDate="2024-03-01 08:00:00 -0500"
  startDate="2024-03-01 08:00:00 -0500"
  endDate="2024-03-01 08:00:00 -0500"
  value="72.5"/>

 <Record type="HKQuantityTypeIdentifierBodyFatPercentage"
  sourceName="Withings" unit="%"
  creationDate="2024-03-01 08:00:00 -0500"
  startDate="2024-03-01 08:00:00 -0500"
  endDate="2024-03-01 08:00:00 -0500"
  value="0.215"/>

 <Record type="HKQuantityTypeIdentifierRestingHeartRate"
  sourceName="Apple Watch" unit="count/min"
  creationDate="2024-03-01 00:00:00 -0500"
  startDate="2024-03-01 00:00:00 -0500"
  endDate="2024-03-01 00:00:00 -0500"
  value="52"/>

 <Record type="HKQuantityTypeIdentifierStepCount"
  sourceName="iPhone" unit="count"
  creationDate="2024-03-01 14:00:00 -0500"
  startDate="2024-03-01 14:00:00 -0500"
  endDate="2024-03-01 14:15:00 -0500"
  value="1250"/>

 <Record type="HKQuantityTypeIdentifierStepCount"
  sourceName="iPhone" unit="count"
  creationDate="2024-03-01 15:00:00 -0500"
  startDate="2024-03-01 15:00:00 -0500"
  endDate="2024-03-01 15:15:00 -0500"
  value="800"/>

 <Record type="HKQuantityTypeIdentifierOxygenSaturation"
  sourceName="Apple Watch" unit="%"
  creationDate="2024-03-01 03:00:00 -0500"
  startDate="2024-03-01 03:00:00 -0500"
  endDate="2024-03-01 03:00:05 -0500"
  value="0.97"/>

 <Record type="HKCategoryTypeIdentifierSleepAnalysis"
  sourceName="Apple Watch"
  creationDate="2024-03-01 23:00:00 -0500"
  startDate="2024-03-01 23:00:00 -0500"
  endDate="2024-03-02 07:00:00 -0500"
  value="HKCategoryValueSleepAnalysisInBed"/>

 <Record type="HKCategoryTypeIdentifierSleepAnalysis"
  sourceName="Apple Watch"
  creationDate="2024-03-01 23:30:00 -0500"
  startDate="2024-03-01 23:30:00 -0500"
  endDate="2024-03-02 01:00:00 -0500"
  value="HKCategoryValueSleepAnalysisAsleepCore"/>

 <Record type="HKCategoryTypeIdentifierSleepAnalysis"
  sourceName="Apple Watch"
  creationDate="2024-03-02 01:00:00 -0500"
  startDate="2024-03-02 01:00:00 -0500"
  endDate="2024-03-02 02:00:00 -0500"
  value="HKCategoryValueSleepAnalysisAsleepDeep"/>

 <Record type="HKCategoryTypeIdentifierSleepAnalysis"
  sourceName="Apple Watch"
  creationDate="2024-03-02 02:00:00 -0500"
  startDate="2024-03-02 02:00:00 -0500"
  endDate="2024-03-02 03:30:00 -0500"
  value="HKCategoryValueSleepAnalysisAsleepREM"/>

 <Correlation type="HKCorrelationTypeIdentifierBloodPressure"
  sourceName="Withings"
  creationDate="2024-03-01 09:00:00 -0500"
  startDate="2024-03-01 09:00:00 -0500"
  endDate="2024-03-01 09:00:00 -0500">
  <Record type="HKQuantityTypeIdentifierBloodPressureSystolic"
   sourceName="Withings" unit="mmHg"
   creationDate="2024-03-01 09:00:00 -0500"
   startDate="2024-03-01 09:00:00 -0500"
   endDate="2024-03-01 09:00:00 -0500"
   value="120"/>
  <Record type="HKQuantityTypeIdentifierBloodPressureDiastolic"
   sourceName="Withings" unit="mmHg"
   creationDate="2024-03-01 09:00:00 -0500"
   startDate="2024-03-01 09:00:00 -0500"
   endDate="2024-03-01 09:00:00 -0500"
   value="80"/>
 </Correlation>

 <Workout workoutActivityType="HKWorkoutActivityTypeRunning"
  duration="30.5" durationUnit="min"
  totalDistance="5200" totalDistanceUnit="m"
  totalEnergyBurned="320" totalEnergyBurnedUnit="kcal"
  sourceName="Apple Watch"
  creationDate="2024-03-01 18:30:00 -0500"
  startDate="2024-03-01 18:00:00 -0500"
  endDate="2024-03-01 18:30:30 -0500">
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate"
   startDate="2024-03-01 18:00:00 -0500"
   endDate="2024-03-01 18:30:30 -0500"
   average="148" minimum="120" maximum="175" unit="count/min"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned"
   startDate="2024-03-01 18:00:00 -0500"
   endDate="2024-03-01 18:30:30 -0500"
   sum="320" unit="kcal"/>
  <WorkoutRoute sourceName="Apple Watch" creationDate="2024-03-01 18:30:30 -0500">
   <Location date="2024-03-01 18:00:00 -0500" latitude="40.712800" longitude="-74.006000" altitude="10.5" horizontalAccuracy="5" verticalAccuracy="3" course="180" speed="3.5"/>
   <Location date="2024-03-01 18:00:05 -0500" latitude="40.712900" longitude="-74.005900" altitude="10.8" horizontalAccuracy="4" verticalAccuracy="3" course="175" speed="3.6"/>
   <Location date="2024-03-01 18:00:10 -0500" latitude="40.713000" longitude="-74.005800" altitude="11.0" horizontalAccuracy="3" verticalAccuracy="2" course="170" speed="3.7"/>
  </WorkoutRoute>
 </Workout>

 <ActivitySummary dateComponents="2024-03-01"
  activeEnergyBurned="523.4"
  activeEnergyBurnedGoal="600"
  activeEnergyBurnedUnit="kcal"
  appleExerciseTime="45"
  appleExerciseTimeGoal="30"
  appleStandHours="12"
  appleStandHoursGoal="12"/>

 <Record type="HKQuantityTypeIdentifierBloodGlucose"
  sourceName="Dexcom G7" unit="mmol/L"
  creationDate="2024-03-01 12:00:00 -0500"
  startDate="2024-03-01 12:00:00 -0500"
  endDate="2024-03-01 12:00:00 -0500"
  value="5.4"/>

 <Record type="HKQuantityTypeIdentifierDietaryProtein"
  sourceName="MyFitnessPal" unit="g"
  creationDate="2024-03-01 20:00:00 -0500"
  startDate="2024-03-01 20:00:00 -0500"
  endDate="2024-03-01 20:00:00 -0500"
  value="45.5"/>

 <Record type="HKQuantityTypeIdentifierDietaryEnergyConsumed"
  sourceName="MyFitnessPal" unit="kcal"
  creationDate="2024-03-01 20:00:00 -0500"
  startDate="2024-03-01 20:00:00 -0500"
  endDate="2024-03-01 20:00:00 -0500"
  value="650"/>

 <Record type="HKQuantityTypeIdentifierDistanceWalkingRunning"
  sourceName="iPhone" unit="m"
  creationDate="2024-03-01 14:00:00 -0500"
  startDate="2024-03-01 14:00:00 -0500"
  endDate="2024-03-01 14:15:00 -0500"
  value="523.7"/>

 <Record type="HKQuantityTypeIdentifierFlightsClimbed"
  sourceName="iPhone" unit="count"
  creationDate="2024-03-01 14:00:00 -0500"
  startDate="2024-03-01 14:00:00 -0500"
  endDate="2024-03-01 14:15:00 -0500"
  value="3"/>

 <Record type="HKCategoryTypeIdentifierMindfulSession"
  sourceName="Headspace"
  creationDate="2024-03-01 07:00:00 -0500"
  startDate="2024-03-01 07:00:00 -0500"
  endDate="2024-03-01 07:15:00 -0500"
  value="1"/>

 <Record type="HKQuantityTypeIdentifierHeartRate"
  sourceName="Apple Watch" unit="count/min"
  creationDate="2023-01-01 10:00:00 -0500"
  startDate="2023-01-01 10:00:00 -0500"
  endDate="2023-01-01 10:00:05 -0500"
  value="65"/>

</HealthData>`;

let ctx: TestContext;
let tmpDir: string;
let xmlPath: string;

describe("Apple Health streaming import (integration)", () => {
  beforeAll(async () => {
    ctx = await setupTestDatabase();

    // Register the apple_health provider
    await ctx.db.insert(schema.provider).values({
      id: "apple_health",
      name: "Apple Health",
    });

    // Write sample XML to a temp file
    tmpDir = join(tmpdir(), `apple-health-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    xmlPath = join(tmpDir, "export.xml");
    writeFileSync(xmlPath, SAMPLE_EXPORT);
  }, 60_000);

  afterAll(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    await ctx.cleanup();
  });

  it("streams records and inserts into metric_stream", async () => {
    let metricCount = 0;
    const since = new Date("2024-01-01");

    const counts = await streamHealthExport(xmlPath, since, {
      onRecordBatch: async (records) => {
        for (const r of records) {
          if (r.type === "HKQuantityTypeIdentifierHeartRate") {
            await ctx.db.insert(schema.metricStream).values({
              providerId: "apple_health",
              recordedAt: r.startDate,
              heartRate: Math.round(r.value),
            });
            metricCount++;
          }
        }
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    // Should have 2 HR records from 2024 (the 2023 one is still >= since)
    expect(counts.recordCount).toBeGreaterThanOrEqual(2);
    expect(metricCount).toBeGreaterThanOrEqual(2);

    const rows = await ctx.db.select().from(schema.metricStream);
    const hrRows = rows.filter((r) => r.heartRate !== null);
    expect(hrRows.length).toBeGreaterThanOrEqual(2);
    expect(hrRows.some((r) => r.heartRate === 72)).toBe(true);
    expect(hrRows.some((r) => r.heartRate === 74)).toBe(true);
  }, 30_000);

  it("filters records older than since date", async () => {
    const since = new Date("2024-03-01T00:00:00-05:00");
    let oldRecordSeen = false;

    await streamHealthExport(xmlPath, since, {
      onRecordBatch: async (records) => {
        for (const r of records) {
          if (r.startDate < since) oldRecordSeen = true;
        }
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(oldRecordSeen).toBe(false);
  });

  it("parses workouts from stream", async () => {
    const since = new Date("2024-01-01");
    const workouts: unknown[] = [];

    await streamHealthExport(xmlPath, since, {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async (batch) => { workouts.push(...batch); },
    });

    expect(workouts.length).toBe(1);
  });

  it("parses sleep records from stream", async () => {
    const since = new Date("2024-01-01");
    let sleepCount = 0;

    const counts = await streamHealthExport(xmlPath, since, {
      onRecordBatch: async () => {},
      onSleepBatch: async (batch) => { sleepCount += batch.length; },
      onWorkoutBatch: async () => {},
    });

    // 4 sleep records: inBed, core, deep, REM
    expect(counts.sleepCount).toBe(4);
    expect(sleepCount).toBe(4);
  });

  it("aggregates step counts by day for daily_metrics", async () => {
    const since = new Date("2024-01-01");

    // Collect step records and aggregate manually like the sync does
    const stepsByDay = new Map<string, number>();

    await streamHealthExport(xmlPath, since, {
      onRecordBatch: async (records) => {
        for (const r of records) {
          if (r.type === "HKQuantityTypeIdentifierStepCount") {
            const dateKey = r.startDate.toISOString().slice(0, 10);
            stepsByDay.set(dateKey, (stepsByDay.get(dateKey) ?? 0) + r.value);
          }
        }
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    // 1250 + 800 = 2050 steps for 2024-03-01
    expect(stepsByDay.get("2024-03-01")).toBe(2050);
  });

  it("parses BP records from Correlation elements", async () => {
    const since = new Date("2024-01-01");
    const bpRecords: { type: string; value: number }[] = [];

    await streamHealthExport(xmlPath, since, {
      onRecordBatch: async (records) => {
        for (const r of records) {
          if (r.type.includes("BloodPressure")) {
            bpRecords.push({ type: r.type, value: r.value });
          }
        }
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(bpRecords).toEqual(
      expect.arrayContaining([
        { type: "HKQuantityTypeIdentifierBloodPressureSystolic", value: 120 },
        { type: "HKQuantityTypeIdentifierBloodPressureDiastolic", value: 80 },
      ]),
    );
  });

  it("enriches workouts with WorkoutStatistics HR data", async () => {
    const since = new Date("2024-01-01");
    const workouts: import("../apple-health.js").HealthWorkout[] = [];

    await streamHealthExport(xmlPath, since, {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async (batch) => { workouts.push(...batch); },
    });

    expect(workouts.length).toBe(1);
    expect(workouts[0].avgHeartRate).toBe(148);
    expect(workouts[0].maxHeartRate).toBe(175);
  });

  it("parses WorkoutRoute GPS locations and attaches to workout", async () => {
    const since = new Date("2024-01-01");
    const workouts: import("../apple-health.js").HealthWorkout[] = [];

    await streamHealthExport(xmlPath, since, {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async (batch) => { workouts.push(...batch); },
    });

    expect(workouts.length).toBe(1);
    expect(workouts[0].routeLocations).toBeDefined();
    expect(workouts[0].routeLocations!.length).toBe(3);

    const first = workouts[0].routeLocations![0];
    expect(first.lat).toBeCloseTo(40.7128);
    expect(first.lng).toBeCloseTo(-74.006);
    expect(first.altitude).toBeCloseTo(10.5);
    expect(first.speed).toBeCloseTo(3.5);
    expect(first.date).toBeInstanceOf(Date);

    const last = workouts[0].routeLocations![2];
    expect(last.lat).toBeCloseTo(40.713);
    expect(last.speed).toBeCloseTo(3.7);
  });

  it("parses blood glucose into record batch", async () => {
    const since = new Date("2024-01-01");
    const bgRecords: import("../apple-health.js").HealthRecord[] = [];

    await streamHealthExport(xmlPath, since, {
      onRecordBatch: async (records) => {
        for (const r of records) {
          if (r.type === "HKQuantityTypeIdentifierBloodGlucose") {
            bgRecords.push(r);
          }
        }
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(bgRecords).toHaveLength(1);
    expect(bgRecords[0].value).toBeCloseTo(5.4);
  });

  it("parses nutrition records", async () => {
    const since = new Date("2024-01-01");
    const nutritionRecords: import("../apple-health.js").HealthRecord[] = [];

    await streamHealthExport(xmlPath, since, {
      onRecordBatch: async (records) => {
        for (const r of records) {
          if (r.type.startsWith("HKQuantityTypeIdentifierDietary")) {
            nutritionRecords.push(r);
          }
        }
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(nutritionRecords).toHaveLength(2);
    const protein = nutritionRecords.find((r) => r.type.includes("Protein"))!;
    expect(protein.value).toBeCloseTo(45.5);
    const energy = nutritionRecords.find((r) => r.type.includes("Energy"))!;
    expect(energy.value).toBe(650);
  });

  it("parses category records (mindful sessions)", async () => {
    const since = new Date("2024-01-01");
    const categories: import("../apple-health.js").CategoryRecord[] = [];

    await streamHealthExport(xmlPath, since, {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
      onCategoryBatch: async (records) => { categories.push(...records); },
    });

    expect(categories.length).toBeGreaterThanOrEqual(1);
    const mindful = categories.find((c) => c.type === "HKCategoryTypeIdentifierMindfulSession");
    expect(mindful).toBeDefined();
    expect(mindful!.sourceName).toBe("Headspace");
  });

  it("routes walking distance and flights climbed", async () => {
    const since = new Date("2024-01-01");
    const distanceRecords: import("../apple-health.js").HealthRecord[] = [];
    const flightRecords: import("../apple-health.js").HealthRecord[] = [];

    await streamHealthExport(xmlPath, since, {
      onRecordBatch: async (records) => {
        for (const r of records) {
          if (r.type === "HKQuantityTypeIdentifierDistanceWalkingRunning") distanceRecords.push(r);
          if (r.type === "HKQuantityTypeIdentifierFlightsClimbed") flightRecords.push(r);
        }
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(distanceRecords).toHaveLength(1);
    expect(distanceRecords[0].value).toBeCloseTo(523.7);
    expect(flightRecords).toHaveLength(1);
    expect(flightRecords[0].value).toBe(3);
  });

  it("parses ActivitySummary as active energy records", async () => {
    const since = new Date("2024-01-01");
    let activitySummaryEnergyCount = 0;

    await streamHealthExport(xmlPath, since, {
      onRecordBatch: async (records) => {
        for (const r of records) {
          if (r.type === "HKQuantityTypeIdentifierActiveEnergyBurned" && r.sourceName === "ActivitySummary") {
            activitySummaryEnergyCount++;
            expect(r.value).toBeCloseTo(523.4);
          }
        }
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(activitySummaryEnergyCount).toBe(1);
  });
});
