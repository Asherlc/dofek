import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "@zos/fs";
import { parseHealthUploadResponse, type ZeppConnectionType } from "./health-contract.ts";
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
};

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
  writeFileSync({ path: temporaryPath, data: JSON.stringify(envelope) });
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
  return { path, envelope: parseImuEnvelope(JSON.parse(contents)) };
}

function acknowledgePending(path: string): void {
  const result = rmSync({ path });
  if (result !== 0) {
    throw new Error(`Could not acknowledge the watch IMU chunk (${result}).`);
  }
}

async function deliverEnvelope(
  envelope: ImuEnvelope,
  request: (envelope: unknown) => Promise<unknown>,
): Promise<void> {
  const response = parseHealthUploadResponse(await request(envelope));
  const eventId = envelope.events[0]?.eventId;
  if (!eventId || !response.acceptedEventIds.includes(eventId)) {
    throw new Error("Phone did not persist the IMU chunk.");
  }
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
        await deliverEnvelope(pending.envelope, request);
        acknowledgePending(pending.path);
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
