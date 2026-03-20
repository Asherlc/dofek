import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CategoryRecord,
  extractExportXml,
  type HealthRecord,
  type HealthWorkout,
  type SleepAnalysisRecord,
  streamHealthExport,
} from "./index.ts";

// ============================================================
// Tests for streaming parser edge cases and backpressure
// ============================================================

let tmpDir: string;

beforeAll(() => {
  tmpDir = join(tmpdir(), `apple-health-stream-test-${Date.now()}`);
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

// ============================================================
// Batch-size triggered flushes (BATCH_SIZE = 5000)
// ============================================================

describe("streamHealthExport — batch flushing", () => {
  it("flushes records in batches when count exceeds BATCH_SIZE", async () => {
    // Generate 5500 records to trigger at least one mid-stream flush (BATCH_SIZE = 5000)
    const recordLines: string[] = [];
    for (let i = 0; i < 5500; i++) {
      const hour = String(Math.floor(i / 60) % 24).padStart(2, "0");
      const min = String(i % 60).padStart(2, "0");
      recordLines.push(
        `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" ` +
          `value="${60 + (i % 40)}" ` +
          `startDate="2024-03-01 ${hour}:${min}:00 -0500" ` +
          `endDate="2024-03-01 ${hour}:${min}:05 -0500" ` +
          `creationDate="2024-03-01 ${hour}:${min}:00 -0500"/>`,
      );
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
${recordLines.join("\n")}
</HealthData>`;
    const path = writeXml("large-records.xml", xml);

    const batches: HealthRecord[][] = [];
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async (records) => {
        batches.push([...records]);
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(result.recordCount).toBe(5500);
    // Should have more than one batch since BATCH_SIZE = 5000
    expect(batches.length).toBeGreaterThanOrEqual(2);
    // First batch should be exactly BATCH_SIZE
    expect(batches[0]).toHaveLength(5000);
    // Total records across all batches should match
    const totalAcrossBatches = batches.reduce((sum, b) => sum + b.length, 0);
    expect(totalAcrossBatches).toBe(5500);
  }, 30_000);

  it("flushes sleep records in batches when count exceeds BATCH_SIZE", async () => {
    // Generate 5100 sleep records to trigger a mid-stream flush
    const recordLines: string[] = [];
    for (let i = 0; i < 5100; i++) {
      const day = String(1 + (i % 28)).padStart(2, "0");
      const month = String(1 + (Math.floor(i / 28) % 12)).padStart(2, "0");
      recordLines.push(
        `<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" ` +
          `value="HKCategoryValueSleepAnalysisAsleepCore" ` +
          `startDate="2024-${month}-${day} 23:00:00 -0500" ` +
          `endDate="2024-${month}-${day} 23:30:00 -0500" ` +
          `creationDate="2024-${month}-${day} 23:00:00 -0500"/>`,
      );
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
${recordLines.join("\n")}
</HealthData>`;
    const path = writeXml("large-sleep.xml", xml);

    const batches: SleepAnalysisRecord[][] = [];
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async (records) => {
        batches.push([...records]);
      },
      onWorkoutBatch: async () => {},
    });

    expect(result.sleepCount).toBe(5100);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches[0]).toHaveLength(5000);
  }, 30_000);

  it("flushes category records in batches when count exceeds BATCH_SIZE", async () => {
    const recordLines: string[] = [];
    for (let i = 0; i < 5100; i++) {
      const day = String(1 + (i % 28)).padStart(2, "0");
      const month = String(1 + (Math.floor(i / 28) % 12)).padStart(2, "0");
      recordLines.push(
        `<Record type="HKCategoryTypeIdentifierMindfulSession" sourceName="App" ` +
          `value="1" ` +
          `startDate="2024-${month}-${day} 07:00:00 -0500" ` +
          `endDate="2024-${month}-${day} 07:15:00 -0500" ` +
          `creationDate="2024-${month}-${day} 07:00:00 -0500"/>`,
      );
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
${recordLines.join("\n")}
</HealthData>`;
    const path = writeXml("large-category.xml", xml);

    const batches: CategoryRecord[][] = [];
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
      onCategoryBatch: async (records) => {
        batches.push([...records]);
      },
    });

    expect(result.categoryCount).toBe(5100);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches[0]).toHaveLength(5000);
  }, 30_000);
});

// ============================================================
// Backpressure: slow callbacks should not cause data loss
// ============================================================

describe("streamHealthExport — backpressure handling", () => {
  it("handles slow callbacks without losing records", async () => {
    // Generate enough records to trigger multiple flushes
    const recordLines: string[] = [];
    for (let i = 0; i < 6000; i++) {
      const hour = String(Math.floor(i / 60) % 24).padStart(2, "0");
      const min = String(i % 60).padStart(2, "0");
      recordLines.push(
        `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" ` +
          `value="${60 + (i % 40)}" ` +
          `startDate="2024-03-01 ${hour}:${min}:00 -0500" ` +
          `endDate="2024-03-01 ${hour}:${min}:05 -0500" ` +
          `creationDate="2024-03-01 ${hour}:${min}:00 -0500"/>`,
      );
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
${recordLines.join("\n")}
</HealthData>`;
    const path = writeXml("backpressure.xml", xml);

    let totalRecordsReceived = 0;
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async (records) => {
        // Simulate slow DB write
        await new Promise((resolve) => setTimeout(resolve, 10));
        totalRecordsReceived += records.length;
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(result.recordCount).toBe(6000);
    expect(totalRecordsReceived).toBe(6000);
  }, 30_000);
});

// ============================================================
// Sleep records filtered by since date
// ============================================================

describe("streamHealthExport — sleep filtering", () => {
  it("filters sleep records by since date", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch"
    value="HKCategoryValueSleepAnalysisInBed"
    startDate="2020-01-01 23:00:00 -0500"
    endDate="2020-01-02 07:00:00 -0500"
    creationDate="2020-01-01 23:00:00 -0500"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch"
    value="HKCategoryValueSleepAnalysisAsleepDeep"
    startDate="2024-06-01 23:00:00 -0500"
    endDate="2024-06-02 07:00:00 -0500"
    creationDate="2024-06-01 23:00:00 -0500"/>
</HealthData>`;
    const path = writeXml("sleep-filter.xml", xml);

    let sleepCount = 0;
    const result = await streamHealthExport(path, new Date("2024-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async (records) => {
        sleepCount += records.length;
      },
      onWorkoutBatch: async () => {},
    });

    expect(result.sleepCount).toBe(1);
    expect(sleepCount).toBe(1);
  });

  it("filters category records by since date", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKCategoryTypeIdentifierMindfulSession" sourceName="App"
    value="1"
    startDate="2020-01-01 07:00:00 -0500"
    endDate="2020-01-01 07:15:00 -0500"
    creationDate="2020-01-01 07:00:00 -0500"/>
  <Record type="HKCategoryTypeIdentifierMindfulSession" sourceName="App"
    value="1"
    startDate="2024-06-01 07:00:00 -0500"
    endDate="2024-06-01 07:15:00 -0500"
    creationDate="2024-06-01 07:00:00 -0500"/>
</HealthData>`;
    const path = writeXml("category-filter.xml", xml);

    let categoryCount = 0;
    const result = await streamHealthExport(path, new Date("2024-01-01"), {
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
});

// ============================================================
// Workout with route but no stats
// ============================================================

describe("streamHealthExport — workout edge cases", () => {
  it("handles workout with route locations but no WorkoutStatistics", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="60" durationUnit="min"
    sourceName="Watch" startDate="2024-03-01 18:00:00 -0500" endDate="2024-03-01 19:00:00 -0500">
    <WorkoutRoute sourceName="Watch" creationDate="2024-03-01 19:00:00 -0500">
      <Location date="2024-03-01 18:00:00 -0500" latitude="40.7128" longitude="-74.0060" altitude="10"/>
      <Location date="2024-03-01 18:30:00 -0500" latitude="40.7200" longitude="-74.0100" altitude="15"/>
    </WorkoutRoute>
  </Workout>
</HealthData>`;
    const path = writeXml("workout-route-only.xml", xml);

    const workouts: HealthWorkout[] = [];
    await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async (batch) => {
        workouts.push(...batch);
      },
    });

    expect(workouts).toHaveLength(1);
    expect(workouts[0]?.activityType).toBe("cycling");
    expect(workouts[0]?.avgHeartRate).toBeUndefined();
    expect(workouts[0]?.routeLocations).toHaveLength(2);
  });

  it("handles multiple workouts in sequence", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min"
    sourceName="Watch" startDate="2024-03-01 08:00:00 -0500" endDate="2024-03-01 08:30:00 -0500">
    <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="155" maximum="180" unit="count/min"/>
  </Workout>
  <Workout workoutActivityType="HKWorkoutActivityTypeYoga" duration="45" durationUnit="min"
    sourceName="Watch" startDate="2024-03-01 18:00:00 -0500" endDate="2024-03-01 18:45:00 -0500">
    <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="90" maximum="110" unit="count/min"/>
  </Workout>
</HealthData>`;
    const path = writeXml("multiple-workouts.xml", xml);

    const workouts: HealthWorkout[] = [];
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async (batch) => {
        workouts.push(...batch);
      },
    });

    expect(result.workoutCount).toBe(2);
    expect(workouts).toHaveLength(2);
    expect(workouts[0]?.activityType).toBe("running");
    expect(workouts[0]?.avgHeartRate).toBe(155);
    expect(workouts[1]?.activityType).toBe("yoga");
    expect(workouts[1]?.avgHeartRate).toBe(90);
  });

  it("skips workout before since date but keeps workout stats isolated", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min"
    sourceName="Watch" startDate="2020-01-01 08:00:00 -0500" endDate="2020-01-01 08:30:00 -0500">
    <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="155" maximum="180" unit="count/min"/>
  </Workout>
  <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="60" durationUnit="min"
    sourceName="Watch" startDate="2024-06-01 18:00:00 -0500" endDate="2024-06-01 19:00:00 -0500">
    <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="140" maximum="165" unit="count/min"/>
  </Workout>
</HealthData>`;
    const path = writeXml("workout-since-filter.xml", xml);

    const workouts: HealthWorkout[] = [];
    const result = await streamHealthExport(path, new Date("2024-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async (batch) => {
        workouts.push(...batch);
      },
    });

    expect(result.workoutCount).toBe(1);
    expect(workouts).toHaveLength(1);
    expect(workouts[0]?.activityType).toBe("cycling");
    expect(workouts[0]?.avgHeartRate).toBe(140);
  });

  it("handles WorkoutRoute closing tag without locations", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min"
    sourceName="Watch" startDate="2024-03-01 18:00:00 -0500" endDate="2024-03-01 18:30:00 -0500">
    <WorkoutRoute sourceName="Watch" creationDate="2024-03-01 18:30:00 -0500">
    </WorkoutRoute>
  </Workout>
</HealthData>`;
    const path = writeXml("empty-route.xml", xml);

    const workouts: HealthWorkout[] = [];
    await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async (batch) => {
        workouts.push(...batch);
      },
    });

    expect(workouts).toHaveLength(1);
    // Empty route should not be attached
    expect(workouts[0]?.routeLocations).toBeUndefined();
  });
});

// ============================================================
// Correlation elements (blood pressure pairs)
// ============================================================

describe("streamHealthExport — correlations", () => {
  it("parses Record elements nested inside Correlation", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Correlation type="HKCorrelationTypeIdentifierBloodPressure"
    sourceName="Withings"
    startDate="2024-03-01 09:00:00 -0500" endDate="2024-03-01 09:00:00 -0500"
    creationDate="2024-03-01 09:00:00 -0500">
    <Record type="HKQuantityTypeIdentifierBloodPressureSystolic"
      sourceName="Withings" unit="mmHg" value="120"
      startDate="2024-03-01 09:00:00 -0500" endDate="2024-03-01 09:00:00 -0500"
      creationDate="2024-03-01 09:00:00 -0500"/>
    <Record type="HKQuantityTypeIdentifierBloodPressureDiastolic"
      sourceName="Withings" unit="mmHg" value="80"
      startDate="2024-03-01 09:00:00 -0500" endDate="2024-03-01 09:00:00 -0500"
      creationDate="2024-03-01 09:00:00 -0500"/>
  </Correlation>
</HealthData>`;
    const path = writeXml("correlation-bp.xml", xml);

    const records: HealthRecord[] = [];
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async (batch) => {
        records.push(...batch);
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(result.recordCount).toBe(2);
    const systolic = records.find((r) => r.type.includes("Systolic"));
    const diastolic = records.find((r) => r.type.includes("Diastolic"));
    expect(systolic?.value).toBe(120);
    expect(diastolic?.value).toBe(80);
  });
});

// ============================================================
// ActivitySummary date filtering
// ============================================================

describe("streamHealthExport — activity summary skipping", () => {
  it("skips ActivitySummary to avoid double-counting with individual records", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <ActivitySummary dateComponents="2020-01-01" activeEnergyBurned="300"/>
  <ActivitySummary dateComponents="2024-06-01" activeEnergyBurned="500"/>
</HealthData>`;
    const path = writeXml("activity-filter.xml", xml);

    const records: HealthRecord[] = [];
    const result = await streamHealthExport(path, new Date("2024-01-01"), {
      onRecordBatch: async (batch) => {
        records.push(...batch);
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    // ActivitySummary no longer generates records — individual records are
    // the authoritative source for additive daily metrics
    expect(result.recordCount).toBe(0);
    expect(records).toHaveLength(0);
  });

  it("skips ActivitySummary even when activeEnergyBurned is present", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <ActivitySummary dateComponents="2024-06-01" activeEnergyBurned="500" appleExerciseTime="45" appleStandHours="12"/>
</HealthData>`;
    const path = writeXml("activity-no-energy.xml", xml);

    const records: HealthRecord[] = [];
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async (batch) => {
        records.push(...batch);
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(result.recordCount).toBe(0);
    expect(records).toHaveLength(0);
  });
});

// ============================================================
// Error handling in stream
// ============================================================

describe("streamHealthExport — error handling", () => {
  it("rejects on malformed XML", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch"
    THIS IS NOT VALID XML &%$#
</HealthData>`;
    const path = writeXml("malformed.xml", xml);

    await expect(
      streamHealthExport(path, new Date("2020-01-01"), {
        onRecordBatch: async () => {},
        onSleepBatch: async () => {},
        onWorkoutBatch: async () => {},
      }),
    ).rejects.toThrow();
  });

  it("rejects when callback throws", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" value="72"
    startDate="2024-03-01 10:00:00 -0500" endDate="2024-03-01 10:00:05 -0500"
    creationDate="2024-03-01 10:00:00 -0500"/>
</HealthData>`;
    const path = writeXml("callback-error.xml", xml);

    await expect(
      streamHealthExport(path, new Date("2020-01-01"), {
        onRecordBatch: async () => {
          throw new Error("DB connection failed");
        },
        onSleepBatch: async () => {},
        onWorkoutBatch: async () => {},
      }),
    ).rejects.toThrow("DB connection failed");
  });

  it("stops the file stream after a mid-stream callback error (no orphaned callbacks)", async () => {
    // Generate enough records to trigger multiple mid-stream flushes.
    // When the first flush fails, the stream should be destroyed so that
    // subsequent batches don't fire callbacks that become unhandled rejections.
    const recordLines: string[] = [];
    for (let i = 0; i < 15_000; i++) {
      const hour = String(Math.floor(i / 60) % 24).padStart(2, "0");
      const min = String(i % 60).padStart(2, "0");
      recordLines.push(
        `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" ` +
          `value="${60 + (i % 40)}" ` +
          `startDate="2024-03-01 ${hour}:${min}:00 -0500" ` +
          `endDate="2024-03-01 ${hour}:${min}:05 -0500" ` +
          `creationDate="2024-03-01 ${hour}:${min}:00 -0500"/>`,
      );
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
${recordLines.join("\n")}
</HealthData>`;
    const path = writeXml("mid-stream-error.xml", xml);

    let callCount = 0;
    await expect(
      streamHealthExport(path, new Date("2020-01-01"), {
        onRecordBatch: async () => {
          callCount++;
          if (callCount === 1) {
            // First batch succeeds (with delay to allow concurrent flushes)
            await new Promise((resolve) => setTimeout(resolve, 20));
          } else {
            // Second batch fails — should stop the stream
            throw new Error("ON CONFLICT DO UPDATE command cannot affect row a second time");
          }
        },
        onSleepBatch: async () => {},
        onWorkoutBatch: async () => {},
      }),
    ).rejects.toThrow("ON CONFLICT");

    // The stream should have been destroyed, so no further batches fire.
    // Without the fix, callCount would be 3 (15000 / 5000 = 3 batches).
    expect(callCount).toBeLessThanOrEqual(2);
  }, 30_000);

  it("does not start new flushes after a mid-stream error", async () => {
    // After a trackFlush error, the errored flag should prevent new flushes
    // from being started, even if more records are parsed before the stream
    // is fully destroyed.
    const recordLines: string[] = [];
    for (let i = 0; i < 15_000; i++) {
      const hour = String(Math.floor(i / 60) % 24).padStart(2, "0");
      const min = String(i % 60).padStart(2, "0");
      recordLines.push(
        `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" ` +
          `value="${60 + (i % 40)}" ` +
          `startDate="2024-03-01 ${hour}:${min}:00 -0500" ` +
          `endDate="2024-03-01 ${hour}:${min}:05 -0500" ` +
          `creationDate="2024-03-01 ${hour}:${min}:00 -0500"/>`,
      );
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
${recordLines.join("\n")}
</HealthData>`;
    const path = writeXml("no-new-flushes.xml", xml);

    let callCount = 0;
    const error = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {
        callCount++;
        if (callCount >= 2) {
          throw new Error("DB conflict error");
        }
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toBe("DB conflict error");
    }
    // Should not have called the callback more than the batch that errored
    // plus at most one more that was already in-flight
    expect(callCount).toBeLessThanOrEqual(3);
  }, 30_000);

  it("rejects when final flush callback throws (no unhandled rejection)", async () => {
    // Generate records that will only be flushed in the final flush (< BATCH_SIZE)
    // along with enough records to create pending mid-stream flushes.
    // This tests that errors in final flushes are properly caught even when
    // there are pending mid-stream flushes draining concurrently.
    const recordLines: string[] = [];
    for (let i = 0; i < 5500; i++) {
      const hour = String(Math.floor(i / 60) % 24).padStart(2, "0");
      const min = String(i % 60).padStart(2, "0");
      recordLines.push(
        `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" ` +
          `value="${60 + (i % 40)}" ` +
          `startDate="2024-03-01 ${hour}:${min}:00 -0500" ` +
          `endDate="2024-03-01 ${hour}:${min}:05 -0500" ` +
          `creationDate="2024-03-01 ${hour}:${min}:00 -0500"/>`,
      );
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
${recordLines.join("\n")}
</HealthData>`;
    const path = writeXml("final-flush-error.xml", xml);

    let callCount = 0;
    await expect(
      streamHealthExport(path, new Date("2020-01-01"), {
        onRecordBatch: async () => {
          callCount++;
          // Simulate slow DB write on mid-stream flushes, then fail on final
          if (callCount === 1) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          } else {
            throw new Error("Final flush DB error");
          }
        },
        onSleepBatch: async () => {},
        onWorkoutBatch: async () => {},
      }),
    ).rejects.toThrow();
  }, 30_000);
});

// ============================================================
// extractExportXml — ZIP extraction
// ============================================================

describe("extractExportXml", () => {
  it("extracts export.xml from a ZIP file", async () => {
    // Create a ZIP file using the zip CLI
    const zipDir = join(tmpDir, "zip-content");
    const subDir = join(zipDir, "apple_health_export");
    mkdirSync(subDir, { recursive: true });
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" value="72"
    startDate="2024-03-01 10:00:00 -0500" endDate="2024-03-01 10:00:05 -0500"
    creationDate="2024-03-01 10:00:00 -0500"/>
</HealthData>`;
    writeFileSync(join(subDir, "export.xml"), xmlContent, "utf8");
    const zipPath = join(tmpDir, "test-export.zip");
    execSync(`cd "${zipDir}" && zip -r "${zipPath}" apple_health_export/export.xml`);

    const extractedPath = await extractExportXml(zipPath);
    expect(extractedPath).toContain("export.xml");

    // Verify the extracted content is parseable
    const records: HealthRecord[] = [];
    await streamHealthExport(extractedPath, new Date("2020-01-01"), {
      onRecordBatch: async (batch) => {
        records.push(...batch);
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.value).toBe(72);

    // Clean up extracted temp dir
    try {
      rmSync(dirname(extractedPath), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("rejects when ZIP has no export.xml", async () => {
    const zipDir2 = join(tmpDir, "zip-no-export");
    mkdirSync(zipDir2, { recursive: true });
    writeFileSync(join(zipDir2, "other.txt"), "hello");
    const zipPath = join(tmpDir, "no-export.zip");
    execSync(`cd "${zipDir2}" && zip "${zipPath}" other.txt`);

    await expect(extractExportXml(zipPath)).rejects.toThrow("No export.xml found");
  });

  it("rejects for invalid ZIP file", async () => {
    const badZipPath = join(tmpDir, "bad.zip");
    writeFileSync(badZipPath, "this is not a zip file");

    await expect(extractExportXml(badZipPath)).rejects.toThrow();
  });
});

// ============================================================
// Mixed record types in a single stream
// ============================================================

describe("streamHealthExport — mixed record types", () => {
  it("correctly routes different record types to appropriate callbacks", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" value="72"
    startDate="2024-03-01 10:00:00 -0500" endDate="2024-03-01 10:00:05 -0500"
    creationDate="2024-03-01 10:00:00 -0500"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch"
    value="HKCategoryValueSleepAnalysisAsleepDeep"
    startDate="2024-03-01 23:00:00 -0500" endDate="2024-03-02 00:00:00 -0500"
    creationDate="2024-03-01 23:00:00 -0500"/>
  <Record type="HKCategoryTypeIdentifierMindfulSession" sourceName="App" value="1"
    startDate="2024-03-01 07:00:00 -0500" endDate="2024-03-01 07:15:00 -0500"
    creationDate="2024-03-01 07:00:00 -0500"/>
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min"
    sourceName="Watch" startDate="2024-03-01 18:00:00 -0500" endDate="2024-03-01 18:30:00 -0500"/>
  <ActivitySummary dateComponents="2024-03-01" activeEnergyBurned="500"/>
</HealthData>`;
    const path = writeXml("mixed-types.xml", xml);

    let recordCount = 0;
    let sleepCount = 0;
    let categoryCount = 0;
    let workoutCount = 0;
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async (records) => {
        recordCount += records.length;
      },
      onSleepBatch: async (records) => {
        sleepCount += records.length;
      },
      onWorkoutBatch: async (workouts) => {
        workoutCount += workouts.length;
      },
      onCategoryBatch: async (records) => {
        categoryCount += records.length;
      },
    });

    // 1 HR record (ActivitySummary is intentionally skipped)
    expect(result.recordCount).toBe(1);
    expect(recordCount).toBe(1);
    expect(result.sleepCount).toBe(1);
    expect(sleepCount).toBe(1);
    expect(result.categoryCount).toBe(1);
    expect(categoryCount).toBe(1);
    expect(result.workoutCount).toBe(1);
    expect(workoutCount).toBe(1);
  });
});

// ============================================================
// Invalid/unparseable records should be silently skipped
// ============================================================

describe("streamHealthExport — unparseable records", () => {
  it("skips records with NaN values without crashing", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" value="not-a-number"
    startDate="2024-03-01 10:00:00 -0500" endDate="2024-03-01 10:00:05 -0500"
    creationDate="2024-03-01 10:00:00 -0500"/>
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" value="72"
    startDate="2024-03-01 10:05:00 -0500" endDate="2024-03-01 10:05:05 -0500"
    creationDate="2024-03-01 10:05:00 -0500"/>
</HealthData>`;
    const path = writeXml("nan-value.xml", xml);

    let recordCount = 0;
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async (records) => {
        recordCount += records.length;
      },
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    // Only the valid record should be counted
    expect(result.recordCount).toBe(1);
    expect(recordCount).toBe(1);
  });

  it("skips sleep records with unknown stage values", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch"
    value="HKCategoryValueSleepAnalysisUnknownFuture"
    startDate="2024-03-01 23:00:00 -0500" endDate="2024-03-02 07:00:00 -0500"
    creationDate="2024-03-01 23:00:00 -0500"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch"
    value="HKCategoryValueSleepAnalysisAsleepDeep"
    startDate="2024-03-02 23:00:00 -0500" endDate="2024-03-03 01:00:00 -0500"
    creationDate="2024-03-02 23:00:00 -0500"/>
</HealthData>`;
    const path = writeXml("unknown-sleep.xml", xml);

    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    // Only the valid deep sleep should be counted
    expect(result.sleepCount).toBe(1);
  });

  it("skips records without a type attribute", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record sourceName="Watch" unit="count/min" value="72"
    startDate="2024-03-01 10:00:00 -0500" endDate="2024-03-01 10:00:05 -0500"
    creationDate="2024-03-01 10:00:00 -0500"/>
</HealthData>`;
    const path = writeXml("no-type.xml", xml);

    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(result.recordCount).toBe(0);
  });
});

// ============================================================
// Workout batch flushing (large number of workouts)
// ============================================================

describe("streamHealthExport — workout batch flushing", () => {
  it("flushes workouts in batches when count exceeds BATCH_SIZE", async () => {
    // Generate 5100 workouts to trigger mid-stream flush
    const workoutLines: string[] = [];
    for (let i = 0; i < 5100; i++) {
      const day = String(1 + (i % 28)).padStart(2, "0");
      const month = String(1 + (Math.floor(i / 28) % 12)).padStart(2, "0");
      workoutLines.push(
        `<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" ` +
          `sourceName="Watch" startDate="2024-${month}-${day} 08:${String(i % 60).padStart(2, "0")}:00 -0500" ` +
          `endDate="2024-${month}-${day} 08:${String(i % 60).padStart(2, "0")}:30 -0500"/>`,
      );
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
${workoutLines.join("\n")}
</HealthData>`;
    const path = writeXml("large-workouts.xml", xml);

    const batches: HealthWorkout[][] = [];
    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async (batch) => {
        batches.push([...batch]);
      },
    });

    expect(result.workoutCount).toBe(5100);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches[0]).toHaveLength(5000);
  }, 30_000);
});

// ============================================================
// XML with DOCTYPE and Me elements (real exports have these)
// ============================================================

describe("streamHealthExport — real-world XML structure", () => {
  it("handles DOCTYPE declarations and Me elements", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!ELEMENT HealthData (ExportDate,Me,(Record|Workout|ActivitySummary)*)>
]>
<HealthData locale="en_US">
  <ExportDate value="2024-03-02 12:00:00 -0500"/>
  <Me HKCharacteristicTypeIdentifierDateOfBirth="1990-01-01"
      HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" value="72"
    startDate="2024-03-01 10:00:00 -0500" endDate="2024-03-01 10:00:05 -0500"
    creationDate="2024-03-01 10:00:00 -0500"/>
</HealthData>`;
    const path = writeXml("doctype.xml", xml);

    const result = await streamHealthExport(path, new Date("2020-01-01"), {
      onRecordBatch: async () => {},
      onSleepBatch: async () => {},
      onWorkoutBatch: async () => {},
    });

    expect(result.recordCount).toBe(1);
  });
});
