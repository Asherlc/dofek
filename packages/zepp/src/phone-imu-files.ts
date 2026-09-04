import type { ZeppConnectionType } from "./health-contract.ts";
import type { SettingsStorage } from "./phone-health-outbox.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";

const VERSION = 1;

export interface ReceivedImuFile {
  segmentId: string;
  source: ZeppConnectionType;
  path: string;
  sampleCount: number;
  receivedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReceivedImuFile(value: unknown): ReceivedImuFile {
  if (
    !isRecord(value) ||
    typeof value.segmentId !== "string" ||
    !value.segmentId.trim() ||
    (value.source !== "zepp" && value.source !== "zepp-workout") ||
    typeof value.path !== "string" ||
    !value.path.trim() ||
    typeof value.sampleCount !== "number" ||
    !Number.isInteger(value.sampleCount) ||
    value.sampleCount < 0 ||
    typeof value.receivedAt !== "string" ||
    !value.receivedAt.trim()
  ) {
    throw new Error("Received IMU file registry is invalid.");
  }
  return {
    segmentId: value.segmentId,
    source: value.source,
    path: value.path,
    sampleCount: value.sampleCount,
    receivedAt: value.receivedAt,
  };
}

export function readReceivedImuFiles(storage: SettingsStorage): ReceivedImuFile[] {
  const serialized = storage.getItem(STORAGE_KEYS.PHONE_IMU_FILES);
  if (!serialized) return [];
  const parsed: unknown = JSON.parse(serialized);
  if (!isRecord(parsed) || parsed.version !== VERSION || !Array.isArray(parsed.files)) {
    throw new Error("Received IMU file registry is invalid.");
  }
  return parsed.files.map(parseReceivedImuFile);
}

export function persistReceivedImuFile(
  storage: SettingsStorage,
  file: ReceivedImuFile,
  reportCorruption: (error: unknown) => void,
): void {
  const validatedFile = parseReceivedImuFile(file);
  let files: ReceivedImuFile[];
  try {
    files = readReceivedImuFiles(storage);
  } catch (error) {
    reportCorruption(error);
    files = [];
  }
  const withoutReplay = files.filter(
    (candidate) =>
      candidate.segmentId !== validatedFile.segmentId || candidate.source !== validatedFile.source,
  );
  storage.setItem(
    STORAGE_KEYS.PHONE_IMU_FILES,
    JSON.stringify({ version: VERSION, files: [...withoutReplay, validatedFile] }),
  );
}

export function acknowledgeReceivedImuFile(
  storage: SettingsStorage,
  segmentId: string,
  source: ZeppConnectionType,
): boolean {
  const files = readReceivedImuFiles(storage);
  const remaining = files.filter((file) => file.segmentId !== segmentId || file.source !== source);
  if (remaining.length === files.length) return false;
  if (remaining.length === 0) {
    storage.removeItem(STORAGE_KEYS.PHONE_IMU_FILES);
  } else {
    storage.setItem(
      STORAGE_KEYS.PHONE_IMU_FILES,
      JSON.stringify({ version: VERSION, files: remaining }),
    );
  }
  return true;
}
