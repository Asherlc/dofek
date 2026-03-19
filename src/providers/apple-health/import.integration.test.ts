import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import {
  AppleHealthProvider,
  buildPanelMap,
  enrichWorkoutFromStats,
  extractExportXml,
  type FhirDiagnosticReport,
  type FhirObservation,
  type HealthWorkout,
  importAppleHealthFile,
  parseFhirObservation,
  streamHealthExport,
} from "./index.ts";

// ============================================================
// streamHealthExport — tests with minimal XML files
// ============================================================

describe("streamHealthExport", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `apple-health-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  function writeXml(name: string, content: string): string {
    const path = join(tmpDir, name);
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("parses Record elements and calls onRecordBatch", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" value="72" startDate="2024-03-01 10:00:00 -0500" endDate="2024-03-01 10:00:05 -0500" creationDate="2024-03-01 10:00:00 -0500"/>
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" value="85" startDate="2024-03-01 10:05:00 -0500" endDate="2024-03-01 10:05:05 -0500" creationDate="2024-03-01 10:05:00 -0500"/>
</HealthData>`;
    const path = writeXml("records.xml", xml);

    const batches: unknown[][] = [];
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async (records) => {
        batches.push(records);
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(result.recordCount).toBe(2);
    expect(batches.length).toBeGreaterThanOrEqual(1);
    const allRecords = batches.flat();
    expect(allRecords).toHaveLength(2);
  });

  it("filters records by since date", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" value="60" startDate="2020-01-01 10:00:00 -0500" endDate="2020-01-01 10:00:05 -0500" creationDate="2020-01-01 10:00:00 -0500"/>
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" value="70" startDate="2024-06-01 10:00:00 -0500" endDate="2024-06-01 10:00:05 -0500" creationDate="2024-06-01 10:00:00 -0500"/>
</HealthData>`;
    const path = writeXml("records-filtered.xml", xml);

    let totalRecords = 0;
    const result = await streamHealthExport(path, new Date("2024-01-01"), {
      onRecordBatch: async (records) => {
        totalRecords += records.length;
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(result.recordCount).toBe(1);
    expect(totalRecords).toBe(1);
  });

  it("parses sleep analysis records", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" value="HKCategoryValueSleepAnalysisInBed" startDate="2024-03-01 23:00:00 -0500" endDate="2024-03-02 07:00:00 -0500" creationDate="2024-03-01 23:00:00 -0500"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" value="HKCategoryValueSleepAnalysisAsleepDeep" startDate="2024-03-02 00:00:00 -0500" endDate="2024-03-02 01:00:00 -0500" creationDate="2024-03-02 00:00:00 -0500"/>
</HealthData>`;
    const path = writeXml("sleep.xml", xml);

    let sleepRecords = 0;
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async (records) => {
        sleepRecords += records.length;
      },
      onWorkoutBatch: async () => {},
    });

    expect(result.sleepCount).toBe(2);
    expect(sleepRecords).toBe(2);
  });

  it("parses Workout elements with WorkoutStatistics", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" totalDistance="5000" totalDistanceUnit="m" sourceName="Apple Watch" startDate="2024-03-01 18:00:00 -0500" endDate="2024-03-01 18:30:00 -0500">
    <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="150" minimum="120" maximum="180" unit="count/min"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="350" unit="kcal"/>
  </Workout>
</HealthData>`;
    const path = writeXml("workout.xml", xml);

    const workouts: HealthWorkout[] = [];
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async (batch) => {
        workouts.push(...batch);
      },
    });

    expect(result.workoutCount).toBe(1);
    expect(workouts).toHaveLength(1);
    expect(workouts[0]?.activityType).toBe("running");
    // WorkoutStatistics should have been applied via enrichWorkoutFromStats
    expect(workouts[0]?.avgHeartRate).toBe(150);
    expect(workouts[0]?.maxHeartRate).toBe(180);
  });

  it("parses category records (non-sleep)", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKCategoryTypeIdentifierMindfulSession" sourceName="Headspace" value="1" startDate="2024-03-01 07:00:00 -0500" endDate="2024-03-01 07:15:00 -0500" creationDate="2024-03-01 07:00:00 -0500"/>
</HealthData>`;
    const path = writeXml("category.xml", xml);

    let categoryCount = 0;
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
      onCategoryBatch: async (records) => {
        categoryCount += records.length;
      },
    });

    expect(result.categoryCount).toBe(1);
    expect(categoryCount).toBe(1);
  });

  it("skips category records when no onCategoryBatch callback", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKCategoryTypeIdentifierMindfulSession" sourceName="Headspace" value="1" startDate="2024-03-01 07:00:00 -0500" endDate="2024-03-01 07:15:00 -0500" creationDate="2024-03-01 07:00:00 -0500"/>
</HealthData>`;
    const path = writeXml("category-skip.xml", xml);

    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    // Should not count if no callback
    expect(result.categoryCount).toBe(0);
  });

  it("parses ActivitySummary and converts to records", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <ActivitySummary dateComponents="2024-03-01" activeEnergyBurned="500" appleExerciseTime="45" appleStandHours="12"/>
</HealthData>`;
    const path = writeXml("activity-summary.xml", xml);

    let recordCount = 0;
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async (records) => {
        recordCount += records.length;
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    // ActivitySummary with activeEnergyBurned produces one record
    expect(result.recordCount).toBe(1);
    expect(recordCount).toBe(1);
  });

  it("calls onProgress callback", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" value="72" startDate="2024-03-01 10:00:00 -0500" endDate="2024-03-01 10:00:05 -0500" creationDate="2024-03-01 10:00:00 -0500"/>
</HealthData>`;
    const path = writeXml("progress.xml", xml);

    let progressCalled = false;
    await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
      onProgress: (info) => {
        progressCalled = true;
        expect(info.totalBytes).toBeGreaterThan(0);
        expect(info.pct).toBeGreaterThanOrEqual(0);
        expect(info.pct).toBeLessThanOrEqual(100);
      },
    });

    expect(progressCalled).toBe(true);
  });

  it("parses WorkoutRoute locations", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" sourceName="Watch" startDate="2024-03-01 18:00:00 -0500" endDate="2024-03-01 18:30:00 -0500">
    <WorkoutRoute sourceName="Watch" creationDate="2024-03-01 18:30:00 -0500">
      <Location date="2024-03-01 18:00:00 -0500" latitude="40.7128" longitude="-74.0060" altitude="10.5" speed="3.5"/>
      <Location date="2024-03-01 18:01:00 -0500" latitude="40.7130" longitude="-74.0062" altitude="11.0" speed="3.6"/>
    </WorkoutRoute>
  </Workout>
</HealthData>`;
    const path = writeXml("route.xml", xml);

    const workouts: HealthWorkout[] = [];
    await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async (batch) => {
        workouts.push(...batch);
      },
    });

    expect(workouts).toHaveLength(1);
    expect(workouts[0]?.routeLocations).toBeDefined();
    expect(workouts[0]?.routeLocations).toHaveLength(2);
    expect(workouts[0]?.routeLocations?.[0]?.lat).toBeCloseTo(40.7128);
  });

  it("handles empty XML", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
</HealthData>`;
    const path = writeXml("empty.xml", xml);

    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(result.recordCount).toBe(0);
    expect(result.workoutCount).toBe(0);
    expect(result.sleepCount).toBe(0);
    expect(result.categoryCount).toBe(0);
  });

  it("filters workouts by since date", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" sourceName="Watch" startDate="2020-01-01 18:00:00 -0500" endDate="2020-01-01 18:30:00 -0500"/>
  <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="60" durationUnit="min" sourceName="Watch" startDate="2024-06-01 18:00:00 -0500" endDate="2024-06-01 19:00:00 -0500"/>
</HealthData>`;
    const path = writeXml("workout-filter.xml", xml);

    const workouts: HealthWorkout[] = [];
    const result = await streamHealthExport(path, new Date("2024-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async (batch) => {
        workouts.push(...batch);
      },
    });

    expect(result.workoutCount).toBe(1);
    expect(workouts[0]?.activityType).toBe("cycling");
  });
});

// ============================================================
// enrichWorkoutFromStats — additional scenarios
// ============================================================

describe("enrichWorkoutFromStats — additional scenarios", () => {
  it("enriches both HR and calories together", () => {
    const workout: HealthWorkout = {
      activityType: "running",
      sourceName: "Watch",
      durationSeconds: 1800,
      startDate: new Date("2024-03-01T18:00:00Z"),
      endDate: new Date("2024-03-01T18:30:00Z"),
    };

    enrichWorkoutFromStats(workout, [
      {
        type: "HKQuantityTypeIdentifierHeartRate",
        average: 155.7,
        maximum: 185.3,
        unit: "count/min",
      },
      {
        type: "HKQuantityTypeIdentifierActiveEnergyBurned",
        sum: 299.6,
        unit: "kcal",
      },
    ]);

    expect(workout.avgHeartRate).toBe(156);
    expect(workout.maxHeartRate).toBe(185);
    expect(workout.calories).toBe(300);
  });

  it("does not set avgHeartRate without average", () => {
    const workout: HealthWorkout = {
      activityType: "cycling",
      sourceName: "Watch",
      durationSeconds: 3600,
      startDate: new Date("2024-03-01T18:00:00Z"),
      endDate: new Date("2024-03-01T19:00:00Z"),
    };

    enrichWorkoutFromStats(workout, [
      {
        type: "HKQuantityTypeIdentifierHeartRate",
        minimum: 100,
        maximum: 180,
        unit: "count/min",
      },
    ]);

    expect(workout.avgHeartRate).toBeUndefined();
    expect(workout.maxHeartRate).toBe(180);
  });
});

// ============================================================
// AppleHealthProvider — validate and sync edge cases
// ============================================================

describe("AppleHealthProvider", () => {
  const originalEnv = { ...process.env };

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  it("validate returns error when APPLE_HEALTH_IMPORT_DIR is not set", () => {
    delete process.env.APPLE_HEALTH_IMPORT_DIR;
    const provider = new AppleHealthProvider();
    expect(provider.validate()).toContain("APPLE_HEALTH_IMPORT_DIR");
  });

  it("validate returns null when APPLE_HEALTH_IMPORT_DIR is set", () => {
    process.env.APPLE_HEALTH_IMPORT_DIR = "/tmp/some-dir";
    const provider = new AppleHealthProvider();
    expect(provider.validate()).toBeNull();
  });

  it("has correct id and name", () => {
    const provider = new AppleHealthProvider();
    expect(provider.id).toBe("apple_health");
    expect(provider.name).toBe("Apple Health");
  });

  it("sync returns error when no export file is found", async () => {
    const emptyDir = join(tmpdir(), `ah-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    process.env.APPLE_HEALTH_IMPORT_DIR = emptyDir;

    const provider = new AppleHealthProvider();
    const mockDb = Object.create(null);
    const result = await provider.sync(mockDb, new Date());

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No Apple Health export found");

    rmSync(emptyDir, { recursive: true, force: true });
  });
});

// ============================================================
// parseFhirObservation — additional edge cases
// ============================================================

describe("parseFhirObservation — additional edge cases", () => {
  it("uses issued date when effectiveDateTime is missing", () => {
    const obs: FhirObservation = {
      resourceType: "Observation",
      id: "obs-issued-only",
      status: "final",
      code: { text: "Test", coding: [{ system: "http://loinc.org", code: "1234-5" }] },
      valueQuantity: { value: 42, unit: "mg/dL" },
      issued: "2024-01-15T10:00:00Z",
    };

    const result = parseFhirObservation(obs, "Lab");
    expect(result.recordedAt).toEqual(new Date("2024-01-15T10:00:00Z"));
  });

  it("throws when both effectiveDateTime and issued are missing", () => {
    const obs: FhirObservation = {
      resourceType: "Observation",
      id: "obs-no-date",
      code: { text: "Test" },
    };

    expect(() => parseFhirObservation(obs, "Lab")).toThrow(
      "missing both effectiveDateTime and issued",
    );
  });

  it("handles preliminary status", () => {
    const obs: FhirObservation = {
      resourceType: "Observation",
      id: "obs-prelim",
      status: "preliminary",
      code: { text: "Test" },
      effectiveDateTime: "2024-01-15T10:00:00Z",
    };

    const result = parseFhirObservation(obs, "Lab");
    expect(result.status).toBe("preliminary");
  });

  it("returns undefined status for unknown status values", () => {
    const obs: FhirObservation = {
      resourceType: "Observation",
      id: "obs-unknown-status",
      status: "entered-in-error",
      code: { text: "Test" },
      effectiveDateTime: "2024-01-15T10:00:00Z",
    };

    const result = parseFhirObservation(obs, "Lab");
    expect(result.status).toBeUndefined();
  });

  it("handles observation with no code text - falls back to coding display", () => {
    const obs: FhirObservation = {
      resourceType: "Observation",
      id: "obs-no-text",
      code: {
        coding: [{ system: "http://loinc.org", code: "789-0", display: "WBC Count" }],
      },
      effectiveDateTime: "2024-01-15T10:00:00Z",
    };

    const result = parseFhirObservation(obs, "Lab");
    expect(result.testName).toBe("WBC Count");
  });

  it("falls back to code when no text or display", () => {
    const obs: FhirObservation = {
      resourceType: "Observation",
      id: "obs-code-only",
      code: {
        coding: [{ system: "urn:local", code: "ABC-1" }],
      },
      effectiveDateTime: "2024-01-15T10:00:00Z",
    };

    const result = parseFhirObservation(obs, "Lab");
    expect(result.testName).toBe("ABC-1");
  });

  it("handles reference range with both structured and text", () => {
    const obs: FhirObservation = {
      resourceType: "Observation",
      id: "obs-range-both",
      code: { text: "Test" },
      valueQuantity: { value: 100, unit: "mg/dL" },
      referenceRange: [
        {
          low: { value: 50, unit: "mg/dL" },
          high: { value: 150, unit: "mg/dL" },
          text: "50-150",
        },
      ],
      effectiveDateTime: "2024-01-15T10:00:00Z",
    };

    const result = parseFhirObservation(obs, "Lab");
    expect(result.referenceRangeLow).toBe(50);
    expect(result.referenceRangeHigh).toBe(150);
    // text should NOT be set when structured range exists
    expect(result.referenceRangeText).toBeUndefined();
  });
});

// ============================================================
// buildPanelMap — edge cases
// ============================================================

describe("buildPanelMap — edge cases", () => {
  it("handles report with no result array", () => {
    const report: FhirDiagnosticReport = {
      resourceType: "DiagnosticReport",
      id: "dr-no-results",
      code: { coding: [{ display: "Empty Panel" }] },
    };
    const map = buildPanelMap([report]);
    expect(map.size).toBe(0);
  });

  it("handles report with no display - uses code text", () => {
    const report: FhirDiagnosticReport = {
      resourceType: "DiagnosticReport",
      id: "dr-text-only",
      code: { text: "Custom Panel", coding: [] },
      result: [{ reference: "Observation/obs-x" }],
    };
    const map = buildPanelMap([report]);
    expect(map.get("obs-x")).toBe("Custom Panel");
  });
});

// ============================================================
// Integration test — importAppleHealthFile full pipeline → DB
// ============================================================

// Minimal but representative Apple Health export XML for DB integration testing
const IMPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!ELEMENT HealthData (ExportDate,Me,(Record|Workout|ActivitySummary|Correlation)*)>
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
  creationDate="2024-03-01 10:05:00 -0500"
  startDate="2024-03-01 10:05:00 -0500"
  endDate="2024-03-01 10:05:05 -0500"
  value="85"/>

 <Record type="HKQuantityTypeIdentifierOxygenSaturation"
  sourceName="Apple Watch" unit="%"
  creationDate="2024-03-01 03:00:00 -0500"
  startDate="2024-03-01 03:00:00 -0500"
  endDate="2024-03-01 03:00:05 -0500"
  value="0.97"/>

 <Record type="HKQuantityTypeIdentifierBloodGlucose"
  sourceName="Dexcom G7" unit="mmol/L"
  creationDate="2024-03-01 12:00:00 -0500"
  startDate="2024-03-01 12:00:00 -0500"
  endDate="2024-03-01 12:00:00 -0500"
  value="5.4"/>

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
  endDate="2024-03-01 18:30:30 -0500">
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate"
   startDate="2024-03-01 18:00:00 -0500"
   endDate="2024-03-01 18:30:30 -0500"
   average="148" minimum="120" maximum="175" unit="count/min"/>
  <WorkoutRoute sourceName="Apple Watch" creationDate="2024-03-01 18:30:30 -0500">
   <Location date="2024-03-01 18:00:00 -0500" latitude="40.712800" longitude="-74.006000" altitude="10.5" horizontalAccuracy="5" verticalAccuracy="3" course="180" speed="3.5"/>
   <Location date="2024-03-01 18:00:05 -0500" latitude="40.712900" longitude="-74.005900" altitude="10.8" horizontalAccuracy="4" verticalAccuracy="3" course="175" speed="3.6"/>
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

 <Record type="HKCategoryTypeIdentifierMindfulSession"
  sourceName="Headspace"
  creationDate="2024-03-01 07:00:00 -0500"
  startDate="2024-03-01 07:00:00 -0500"
  endDate="2024-03-01 07:15:00 -0500"
  value="1"/>

</HealthData>`;

describe("importAppleHealthFile — full DB integration", () => {
  let ctx: TestContext;
  let tmpDir: string;
  let zipPath: string;

  beforeAll(async () => {
    ctx = await setupTestDatabase();

    // Write sample XML, then zip it
    tmpDir = join(tmpdir(), `ah-import-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const xmlPath = join(tmpDir, "export.xml");
    writeFileSync(xmlPath, IMPORT_XML);
    zipPath = join(tmpDir, "export.zip");
    execSync(`cd "${tmpDir}" && zip "${zipPath}" export.xml`);
  }, 120_000);

  afterAll(async () => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (ctx) await ctx.cleanup();
  });

  it("imports from a .zip and inserts into all tables", async () => {
    const since = new Date("2024-01-01");
    const result = await importAppleHealthFile(ctx.db, zipPath, since, () => {});

    expect(result.provider).toBe("apple_health");
    expect(result.recordsSynced).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  }, 60_000);

  it("creates metric_stream rows for HR, SpO2, and blood glucose", async () => {
    const rows = await ctx.db.select().from(schema.metricStream);
    const hrRows = rows.filter((r) => r.heartRate !== null && r.activityId === null);
    expect(hrRows.length).toBeGreaterThanOrEqual(2);
    expect(hrRows.some((r) => r.heartRate === 72)).toBe(true);
    expect(hrRows.some((r) => r.heartRate === 85)).toBe(true);

    const spo2Rows = rows.filter((r) => r.spo2 !== null);
    expect(spo2Rows.length).toBeGreaterThanOrEqual(1);
    expect(spo2Rows[0]?.spo2).toBeCloseTo(0.97);

    const bgRows = rows.filter((r) => r.bloodGlucose !== null);
    expect(bgRows.length).toBeGreaterThanOrEqual(1);
    expect(bgRows[0]?.bloodGlucose).toBeCloseTo(5.4);
  });

  it("creates body_measurement rows with weight, body fat, and BP", async () => {
    const rows = await ctx.db.select().from(schema.bodyMeasurement);
    // Weight+body fat share a timestamp so should be grouped
    const weightRow = rows.find((r) => r.weightKg !== null);
    expect(weightRow).toBeDefined();
    expect(weightRow?.weightKg).toBeCloseTo(72.5);
    expect(weightRow?.bodyFatPct).toBeCloseTo(21.5); // 0.215 * 100

    // BP at 09:00
    const bpRow = rows.find((r) => r.systolicBp !== null);
    expect(bpRow).toBeDefined();
    expect(bpRow?.systolicBp).toBe(120);
    expect(bpRow?.diastolicBp).toBe(80);
  });

  it("creates daily_metrics rows with aggregated steps, distance, resting HR", async () => {
    const rows = await ctx.db.select().from(schema.dailyMetrics);
    const day = rows.find((r) => r.date === "2024-03-01");
    expect(day).toBeDefined();
    // Steps: 1250 + 800 = 2050
    expect(day?.steps).toBe(2050);
    expect(day?.restingHr).toBe(52);
    expect(day?.flightsClimbed).toBe(3);
    // Distance: 523.7 m → 0.5237 km
    expect(day?.distanceKm).toBeCloseTo(0.5237);
    // Active energy from ActivitySummary: 523.4
    expect(day?.activeEnergyKcal).toBeCloseTo(523.4);
  });

  it("creates nutrition_daily rows with aggregated nutrition", async () => {
    const rows = await ctx.db.select().from(schema.nutritionDaily);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // The dietary records are at 20:00 -0500, which is 2024-03-02 01:00 UTC.
    // dateToString uses toISOString().slice(0,10), so the date key is "2024-03-02".
    const day = rows.find((r) => r.date === "2024-03-02");
    expect(day).toBeDefined();
    expect(day?.calories).toBe(650);
    expect(day?.proteinG).toBeCloseTo(45.5);
  });

  it("creates a sleep_session from inBed + stage records", async () => {
    const rows = await ctx.db.select().from(schema.sleepSession);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const session = rows.find((r) => r.externalId?.startsWith("ah:sleep:"));
    expect(session).toBeDefined();
    // inBed: 23:00 to 07:00 = 480 minutes
    expect(session?.durationMinutes).toBe(480);
    // core: 90 min, deep: 60 min, rem: 90 min
    expect(session?.lightMinutes).toBe(90);
    expect(session?.deepMinutes).toBe(60);
    expect(session?.remMinutes).toBe(90);
    expect(session?.isNap).toBe(false);
  });

  it("creates activity rows for workouts with GPS in metric_stream", async () => {
    const activities = await ctx.db.select().from(schema.activity);
    const run = activities.find((a) => a.activityType === "running");
    expect(run).toBeDefined();
    expect(run?.externalId).toContain("ah:workout:");
    expect(run?.raw).toMatchObject({
      durationSeconds: 1830,
      distanceMeters: 5200,
      calories: 320,
      avgHeartRate: 148,
      maxHeartRate: 175,
    });

    // Check GPS metric_stream rows linked to the activity
    const allMetrics = await ctx.db.select().from(schema.metricStream);
    const gpsRows = allMetrics.filter((r) => r.activityId === run?.id && r.lat !== null);
    expect(gpsRows.length).toBe(2);
    expect(gpsRows.some((r) => r.lat !== null && Math.abs(r.lat - 40.7128) < 0.001)).toBe(true);
    expect(gpsRows.some((r) => r.speed !== null && Math.abs(r.speed - 3.5) < 0.1)).toBe(true);
  });

  it("creates health_event rows for category records (mindful session)", async () => {
    const rows = await ctx.db.select().from(schema.healthEvent);
    const mindful = rows.find((r) => r.type === "HKCategoryTypeIdentifierMindfulSession");
    expect(mindful).toBeDefined();
    expect(mindful?.valueText).toBe("1");
    expect(mindful?.sourceName).toBe("Headspace");
  });

  it("is idempotent — re-import does not duplicate records", async () => {
    const since = new Date("2024-01-01");

    // Count before
    const sleepBefore = await ctx.db.select().from(schema.sleepSession);
    const activitiesBefore = await ctx.db.select().from(schema.activity);
    const bodyBefore = await ctx.db.select().from(schema.bodyMeasurement);

    // Re-import with an XML file (non-zip path to avoid clinical records branch)
    const xmlPath = join(tmpDir, "export.xml");
    await importAppleHealthFile(ctx.db, xmlPath, since, () => {});

    // Count after — should be same due to upsert/conflict handling
    const sleepAfter = await ctx.db.select().from(schema.sleepSession);
    const activitiesAfter = await ctx.db.select().from(schema.activity);
    const bodyAfter = await ctx.db.select().from(schema.bodyMeasurement);

    expect(sleepAfter.length).toBe(sleepBefore.length);
    expect(activitiesAfter.length).toBe(activitiesBefore.length);
    expect(bodyAfter.length).toBe(bodyBefore.length);
  }, 60_000);
});

// ============================================================
// extractExportXml — ZIP extraction
// ============================================================

describe("extractExportXml", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `ah-extract-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("extracts export.xml from a zip file", async () => {
    const xmlContent = `<?xml version="1.0"?><HealthData locale="en_US"></HealthData>`;
    const xmlPath = join(tmpDir, "export.xml");
    writeFileSync(xmlPath, xmlContent);
    const zipPath = join(tmpDir, "test-extract.zip");
    execSync(`cd "${tmpDir}" && zip "${zipPath}" export.xml`);

    const extractedPath = await extractExportXml(zipPath);
    expect(extractedPath).toContain("export.xml");

    const { readFileSync } = await import("node:fs");
    const content = readFileSync(extractedPath, "utf-8");
    expect(content).toContain("<HealthData");

    // Clean up extracted file
    const { dirname } = await import("node:path");
    rmSync(dirname(extractedPath), { recursive: true, force: true });
  });

  it("extracts export.xml from a subdirectory in the zip", async () => {
    const subDir = join(tmpDir, "apple_health_export");
    mkdirSync(subDir, { recursive: true });
    const xmlContent = `<?xml version="1.0"?><HealthData locale="en_US"></HealthData>`;
    writeFileSync(join(subDir, "export.xml"), xmlContent);
    const zipPath = join(tmpDir, "test-subdir.zip");
    execSync(`cd "${tmpDir}" && zip "${zipPath}" apple_health_export/export.xml`);

    const extractedPath = await extractExportXml(zipPath);
    expect(extractedPath).toContain("export.xml");

    const { readFileSync } = await import("node:fs");
    const content = readFileSync(extractedPath, "utf-8");
    expect(content).toContain("<HealthData");

    const { dirname } = await import("node:path");
    rmSync(dirname(extractedPath), { recursive: true, force: true });
  });

  it("rejects when no export.xml found in zip", async () => {
    const otherPath = join(tmpDir, "other.txt");
    writeFileSync(otherPath, "hello");
    const zipPath = join(tmpDir, "no-export.zip");
    execSync(`cd "${tmpDir}" && zip "${zipPath}" other.txt`);

    await expect(extractExportXml(zipPath)).rejects.toThrow("No export.xml");
  });
});
