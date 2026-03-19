import { createReadStream, statSync } from "node:fs";
import sax from "sax";
import { getStringAttrs, parseHealthDate } from "./dates.ts";
import {
  type CategoryRecord,
  type HealthRecord,
  parseCategoryRecord,
  parseRecord,
  parseRouteLocation,
  type RouteLocation,
} from "./records.ts";
import { parseSleepAnalysis, type SleepAnalysisRecord } from "./sleep.ts";
import {
  enrichWorkoutFromStats,
  type HealthWorkout,
  parseActivitySummary,
  parseWorkout,
  parseWorkoutStatistics,
  type WorkoutStatistics,
} from "./workouts.ts";

export interface ProgressInfo {
  bytesRead: number;
  totalBytes: number;
  pct: number;
  recordCount: number;
  workoutCount: number;
  sleepCount: number;
}

export interface StreamCallbacks {
  onRecordBatch: (records: HealthRecord[]) => Promise<void>;
  onSleepBatch: (records: SleepAnalysisRecord[]) => Promise<void>;
  onWorkoutBatch: (workouts: HealthWorkout[]) => Promise<void>;
  onCategoryBatch?: (records: CategoryRecord[]) => Promise<void>;
  onProgress?: (info: ProgressInfo) => void;
}

const BATCH_SIZE = 5000;

/**
 * Stream-parse an Apple Health export.xml file.
 * Calls back in batches for constant memory usage on large (1GB+) files.
 * Only processes records with startDate >= since.
 */
export function streamHealthExport(
  filePath: string,
  since: Date,
  callbacks: StreamCallbacks,
): Promise<{
  recordCount: number;
  workoutCount: number;
  sleepCount: number;
  categoryCount: number;
}> {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true, { trim: true });
    const fileStream = createReadStream(filePath, { encoding: "utf8" });
    let recordBatch: HealthRecord[] = [];
    let sleepBatch: SleepAnalysisRecord[] = [];
    let workoutBatch: HealthWorkout[] = [];
    let categoryBatch: CategoryRecord[] = [];
    let recordCount = 0;
    let workoutCount = 0;
    let sleepCount = 0;
    let categoryCount = 0;
    let pendingFlushes = 0;
    let drainResolve: (() => void) | null = null;

    // Progress tracking
    const totalBytes = statSync(filePath).size;
    let bytesRead = 0;
    let lastReportedPct = -1;
    fileStream.on("data", (chunk: string | Buffer) => {
      bytesRead += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      const pct = Math.floor((bytesRead / totalBytes) * 100);
      if (pct > lastReportedPct) {
        lastReportedPct = pct;
        callbacks.onProgress?.({
          bytesRead,
          totalBytes,
          pct,
          recordCount,
          workoutCount,
          sleepCount,
        });
      }
    });

    // State for nested elements
    let currentWorkout: HealthWorkout | null = null;
    let currentWorkoutStats: WorkoutStatistics[] = [];
    let currentRouteLocations: RouteLocation[] = [];
    let insideWorkoutRoute = false;

    // Backpressure: pause the file stream while DB writes are in progress.
    // Max concurrent flushes before we pause.
    const MAX_PENDING = 5;

    function trackFlush(fn: () => Promise<void>) {
      pendingFlushes++;
      if (pendingFlushes >= MAX_PENDING) {
        fileStream.pause();
      }
      fn()
        .then(() => {
          pendingFlushes--;
          if (pendingFlushes < MAX_PENDING) {
            fileStream.resume();
          }
          if (pendingFlushes === 0 && drainResolve) {
            drainResolve();
            drainResolve = null;
          }
        })
        .catch((err) => {
          pendingFlushes--;
          fileStream.destroy();
          reject(err);
        });
    }

    function addRecord(record: HealthRecord) {
      recordBatch.push(record);
      recordCount++;
      if (recordBatch.length >= BATCH_SIZE) {
        const batch = recordBatch;
        recordBatch = [];
        trackFlush(() => callbacks.onRecordBatch(batch));
      }
    }

    function addSleep(sleep: SleepAnalysisRecord) {
      sleepBatch.push(sleep);
      sleepCount++;
      if (sleepBatch.length >= BATCH_SIZE) {
        const batch = sleepBatch;
        sleepBatch = [];
        trackFlush(() => callbacks.onSleepBatch(batch));
      }
    }

    function addCategory(cat: CategoryRecord) {
      if (!callbacks.onCategoryBatch) return;
      categoryBatch.push(cat);
      categoryCount++;
      if (categoryBatch.length >= BATCH_SIZE) {
        const batch = categoryBatch;
        categoryBatch = [];
        const onBatch = callbacks.onCategoryBatch;
        if (onBatch) trackFlush(() => onBatch(batch));
      }
    }

    function flushWorkout() {
      if (currentWorkout) {
        if (currentWorkoutStats.length > 0) {
          enrichWorkoutFromStats(currentWorkout, currentWorkoutStats);
        }
        workoutBatch.push(currentWorkout);
        workoutCount++;
        if (workoutBatch.length >= BATCH_SIZE) {
          const batch = workoutBatch;
          workoutBatch = [];
          trackFlush(() => callbacks.onWorkoutBatch(batch));
        }
      }
      currentWorkout = null;
      currentWorkoutStats = [];
    }

    parser.on("opentag", (node) => {
      const attrs = getStringAttrs(node);

      // Records appear at top level and inside Correlations (e.g. BP pairs)
      if (node.name === "Record") {
        // Records appear both at top level and inside Correlations
        if (attrs.type === "HKCategoryTypeIdentifierSleepAnalysis") {
          const sleep = parseSleepAnalysis(attrs);
          if (sleep && sleep.startDate >= since) addSleep(sleep);
        } else if (attrs.type?.startsWith("HKCategoryType")) {
          // Category types (MindfulSession, SexualActivity, etc.) -- non-numeric
          const cat = parseCategoryRecord(attrs);
          if (cat && cat.startDate >= since) addCategory(cat);
        } else {
          const record = parseRecord(attrs);
          if (record && record.startDate >= since) addRecord(record);
        }
      } else if (node.name === "Workout") {
        const workout = parseWorkout(attrs);
        if (workout.startDate >= since) {
          currentWorkout = workout;
          currentWorkoutStats = [];
        }
      } else if (node.name === "WorkoutStatistics" && currentWorkout) {
        const stat = parseWorkoutStatistics(attrs);
        if (stat) currentWorkoutStats.push(stat);
      } else if (node.name === "WorkoutRoute" && currentWorkout) {
        insideWorkoutRoute = true;
        currentRouteLocations = [];
      } else if (node.name === "Location" && insideWorkoutRoute && currentWorkout) {
        const loc = parseRouteLocation(attrs);
        if (loc) currentRouteLocations.push(loc);
      } else if (node.name === "ActivitySummary") {
        // ActivitySummary contains daily ring data -- treat as a record batch
        const summary = parseActivitySummary(attrs);
        if (summary) {
          // Convert to HealthRecords for the daily metrics pipeline
          const date = parseHealthDate(`${summary.date} 00:00:00 +0000`);
          if (date >= since) {
            if (summary.activeEnergyBurned !== undefined) {
              addRecord({
                type: "HKQuantityTypeIdentifierActiveEnergyBurned",
                sourceName: "ActivitySummary",
                unit: "kcal",
                value: summary.activeEnergyBurned,
                startDate: date,
                endDate: date,
                creationDate: date,
              });
            }
          }
        }
      }
    });

    parser.on("closetag", (name) => {
      if (name === "WorkoutRoute") {
        insideWorkoutRoute = false;
        if (currentWorkout && currentRouteLocations.length > 0) {
          currentWorkout.routeLocations = currentRouteLocations;
        }
        currentRouteLocations = [];
      } else if (name === "Workout") {
        flushWorkout();
      }
    });

    parser.on("error", (err) => reject(err));
    parser.on("end", () => {
      // Flush any in-progress workout
      flushWorkout();

      // Wait for all pending flushes to drain, then run final flushes.
      // Final flushes must be created AFTER drain completes so that
      // Promise.all immediately attaches rejection handlers — otherwise
      // a rejection during the drain window would be unhandled.
      const waitForDrain = (): Promise<void> => {
        if (pendingFlushes === 0) return Promise.resolve();
        return new Promise<void>((res) => {
          drainResolve = res;
        });
      };

      waitForDrain()
        .then(() => {
          const finalFlushes: Promise<void>[] = [];
          if (recordBatch.length > 0) finalFlushes.push(callbacks.onRecordBatch(recordBatch));
          if (sleepBatch.length > 0) finalFlushes.push(callbacks.onSleepBatch(sleepBatch));
          if (workoutBatch.length > 0) finalFlushes.push(callbacks.onWorkoutBatch(workoutBatch));
          if (categoryBatch.length > 0 && callbacks.onCategoryBatch) {
            finalFlushes.push(callbacks.onCategoryBatch(categoryBatch));
          }
          return Promise.all(finalFlushes);
        })
        .then(() => resolve({ recordCount, workoutCount, sleepCount, categoryCount }))
        .catch(reject);
    });

    fileStream.pipe(parser);
  });
}
