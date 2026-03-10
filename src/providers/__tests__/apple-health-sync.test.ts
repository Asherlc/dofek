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

 <Workout workoutActivityType="HKWorkoutActivityTypeRunning"
  duration="30.5" durationUnit="min"
  totalDistance="5200" totalDistanceUnit="m"
  totalEnergyBurned="320" totalEnergyBurnedUnit="kcal"
  sourceName="Apple Watch"
  creationDate="2024-03-01 18:30:00 -0500"
  startDate="2024-03-01 18:00:00 -0500"
  endDate="2024-03-01 18:30:30 -0500"/>

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
});
