import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "@zos/fs";
import {
  type HealthUploadResponse,
  parseHealthUploadResponse,
  type ZeppConnectionType,
} from "./health-contract.ts";
import { createImuChunkEnvelope, parseImuEnvelope } from "./imu-upload.ts";
import type { ImuSample } from "./types.ts";

type ImuChunkInput = {
  connectionType: ZeppConnectionType;
  installId: string;
  segmentId: string;
  sessionStartMs: number;
  hasGyroscope: boolean;
  samples: ImuSample[];
};

type ImuEnvelope = ReturnType<typeof createImuChunkEnvelope>;

export interface WatchImuChunkSync {
  enqueue(input: ImuChunkInput): Promise<void>;
  retry(): Promise<void>;
}

type PendingRecord = {
  path: string;
  envelope: ImuEnvelope;
  attempts: number;
};

const RECORD_VERSION = 1;
const MAX_UNACKNOWLEDGED_ATTEMPTS = 3;

function readRecordNames(directory: string): string[] {
  const names = readdirSync({ path: directory });
  if (names) return names.filter((name) => name.endsWith(".json")).sort();
  const result = mkdirSync({ path: directory });
  if (result !== 0) {
    throw new Error(`Could not create the watch IMU chunk directory (${result}).`);
  }
  return [];
}

function recordName(envelope: ImuEnvelope): string {
  const eventId = envelope.events[0]?.eventId;
  if (!eventId) throw new Error("Watch IMU chunk has no event identifier.");
  return `${encodeURIComponent(eventId)}.json`;
}

function persistPending(directory: string, envelope: ImuEnvelope): void {
  const name = recordName(envelope);
  if (readRecordNames(directory).includes(name)) return;
  const path = `${directory}/${name}`;
  const temporaryPath = `${path}.tmp`;
  writeFileSync({
    path: temporaryPath,
    data: JSON.stringify({ version: RECORD_VERSION, envelope, attempts: 0 }),
  });
  const result = renameSync({ oldPath: temporaryPath, newPath: path });
  if (result !== 0) {
    throw new Error(`Could not commit the watch IMU chunk (${result}).`);
  }
}

function readFirstPending(directory: string): PendingRecord | null {
  const name = readRecordNames(directory)[0];
  if (!name) return null;
  const path = `${directory}/${name}`;
  const contents = readFileSync({ path, options: { encoding: "utf8" } });
  if (typeof contents !== "string") {
    throw new Error("Watch IMU chunk record is invalid.");
  }
  const parsed: unknown = JSON.parse(contents);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Reflect.get(parsed, "version") === RECORD_VERSION
  ) {
    const attempts = Reflect.get(parsed, "attempts");
    if (!Number.isInteger(attempts) || Number(attempts) < 0) {
      throw new Error("Watch IMU chunk record is invalid.");
    }
    return {
      path,
      envelope: parseImuEnvelope(Reflect.get(parsed, "envelope")),
      attempts: Number(attempts),
    };
  }
  return { path, envelope: parseImuEnvelope(parsed), attempts: 0 };
}

function writePendingRecord(record: PendingRecord, lastError: string): void {
  const temporaryPath = `${record.path}.tmp`;
  writeFileSync({
    path: temporaryPath,
    data: JSON.stringify({
      version: RECORD_VERSION,
      envelope: record.envelope,
      attempts: record.attempts + 1,
      lastError,
    }),
  });
  const result = renameSync({ oldPath: temporaryPath, newPath: record.path });
  if (result !== 0) throw new Error(`Could not update the watch IMU chunk (${result}).`);
}

function quarantinePending(record: PendingRecord, issues: unknown): void {
  const quarantinePath = `${record.path.slice(0, -".json".length)}.rejected`;
  writeFileSync({
    path: quarantinePath,
    data: JSON.stringify({
      version: RECORD_VERSION,
      envelope: record.envelope,
      attempts: record.attempts + 1,
      issues,
    }),
  });
  acknowledgePending(record.path);
}

function acknowledgePending(path: string): void {
  const result = rmSync({ path });
  if (result !== 0) {
    throw new Error(`Could not acknowledge the watch IMU chunk (${result}).`);
  }
}

async function deliverRecord(
  record: PendingRecord,
  request: (envelope: unknown) => Promise<unknown>,
): Promise<"accepted" | "quarantined"> {
  let response: HealthUploadResponse;
  try {
    response = parseHealthUploadResponse(await request(record.envelope));
  } catch (error) {
    writePendingRecord(record, error instanceof Error ? error.message : String(error));
    throw error;
  }
  const eventId = record.envelope.events[0]?.eventId;
  if (!eventId) throw new Error("Watch IMU chunk has no event identifier.");
  if (response.acceptedEventIds.includes(eventId)) return "accepted";
  const rejected = response.rejected.find((event) => event.eventId === eventId);
  if (rejected) {
    quarantinePending(record, rejected.issues);
    return "quarantined";
  }
  if (record.attempts + 1 >= MAX_UNACKNOWLEDGED_ATTEMPTS) {
    quarantinePending(record, [
      { path: "$", message: "Phone repeatedly omitted the IMU chunk acknowledgement." },
    ]);
    return "quarantined";
  }
  writePendingRecord(record, "Phone did not persist the IMU chunk.");
  throw new Error("Phone did not persist the IMU chunk.");
}

export function createWatchImuChunkSync(
  path: string,
  request: (envelope: unknown) => Promise<unknown>,
): WatchImuChunkSync {
  let drainTask: Promise<void> | null = null;

  function retry(): Promise<void> {
    if (drainTask) return drainTask;
    const task = (async () => {
      while (true) {
        const pending = readFirstPending(path);
        if (!pending) return;
        const result = await deliverRecord(pending, request);
        if (result === "accepted") acknowledgePending(pending.path);
      }
    })();
    drainTask = task;
    const clearTask = () => {
      if (drainTask === task) drainTask = null;
    };
    void task.then(clearTask, clearTask);
    return task;
  }

  return {
    enqueue(input) {
      persistPending(path, createImuChunkEnvelope(input));
      return retry();
    },
    retry,
  };
}
