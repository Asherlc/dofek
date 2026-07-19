import { readFileSync, writeFileSync } from "@zos/fs";
import type { LiveWorkoutSnapshot, SportDataType } from "./workout-live.ts";

const LIVE_WORKOUT_FILE = "data://workout/live.json";

export interface LiveWorkoutBatch {
  externalId: string;
  snapshots: LiveWorkoutSnapshot[];
}

export interface LiveWorkoutBuffer {
  batches: LiveWorkoutBatch[];
}

function emptyBuffer(): LiveWorkoutBuffer {
  return { batches: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshot(value: unknown): LiveWorkoutSnapshot | undefined {
  if (!isRecord(value) || typeof value.recordedAt !== "string" || !isRecord(value.metrics)) {
    return undefined;
  }
  const metrics: Partial<Record<SportDataType, number>> = {};
  for (const [metric, metricValue] of Object.entries(value.metrics)) {
    if (typeof metricValue === "number") {
      Reflect.set(metrics, metric, metricValue);
    }
  }
  return {
    recordedAt: value.recordedAt,
    heartRate: typeof value.heartRate === "number" ? value.heartRate : undefined,
    metrics,
  };
}

export function parseLiveWorkoutBuffer(serialized: string): LiveWorkoutBuffer {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || !Array.isArray(parsed.batches)) return emptyBuffer();
    return {
      batches: parsed.batches.flatMap((value) => {
        if (
          !isRecord(value) ||
          typeof value.externalId !== "string" ||
          !Array.isArray(value.snapshots)
        ) {
          return [];
        }
        return [
          {
            externalId: value.externalId,
            snapshots: value.snapshots.flatMap((snapshotValue) => {
              const snapshot = parseSnapshot(snapshotValue);
              return snapshot ? [snapshot] : [];
            }),
          },
        ];
      }),
    };
  } catch {
    return emptyBuffer();
  }
}

export function removeUploadedLiveWorkoutSnapshots(
  buffer: LiveWorkoutBuffer,
  externalId: string,
  uploadedSnapshots: LiveWorkoutSnapshot[],
): LiveWorkoutBuffer {
  const uploadedSnapshotSet = new Set(uploadedSnapshots);
  return {
    batches: buffer.batches.flatMap((batch) => {
      if (batch.externalId !== externalId) return [batch];
      const remainingSnapshots = batch.snapshots.filter(
        (snapshot) => !uploadedSnapshotSet.has(snapshot),
      );
      return remainingSnapshots.length > 0 ? [{ ...batch, snapshots: remainingSnapshots }] : [];
    }),
  };
}

export function readLiveWorkoutBuffer(): LiveWorkoutBuffer {
  try {
    const contents = readFileSync({
      path: LIVE_WORKOUT_FILE,
      options: { encoding: "utf8" },
    });
    return typeof contents === "string" ? parseLiveWorkoutBuffer(contents) : emptyBuffer();
  } catch {
    return emptyBuffer();
  }
}

export function writeLiveWorkoutBuffer(buffer: LiveWorkoutBuffer): void {
  writeFileSync({ path: LIVE_WORKOUT_FILE, data: JSON.stringify(buffer) });
}
