import { readFileSync, renameSync, writeFileSync } from "@zos/fs";
import type { ImuSegmentResult } from "./imu-session-controller.ts";

const VERSION = 1;

export type ImuFileSlot = "A" | "B";
export type PendingImuTransfer = ImuSegmentResult & { slot: ImuFileSlot };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePending(value: unknown): PendingImuTransfer {
  if (
    !isRecord(value) ||
    (value.slot !== "A" && value.slot !== "B") ||
    typeof value.path !== "string" ||
    !value.path.trim() ||
    !Number.isInteger(value.sampleCount) ||
    !Number.isInteger(value.observedHzX100) ||
    typeof value.hasGyroscope !== "boolean" ||
    !Number.isInteger(value.accelFreqMode) ||
    !Number.isInteger(value.gyroFreqMode) ||
    !Number.isInteger(value.sessionStartMs)
  ) {
    throw new Error("Pending IMU transfer manifest is invalid.");
  }
  return {
    slot: value.slot,
    path: value.path,
    sampleCount: Number(value.sampleCount),
    observedHzX100: Number(value.observedHzX100),
    hasGyroscope: value.hasGyroscope,
    accelFreqMode: Number(value.accelFreqMode),
    gyroFreqMode: Number(value.gyroFreqMode),
    sessionStartMs: Number(value.sessionStartMs),
  };
}

export function readPendingImuTransfers(path: string): PendingImuTransfer[] {
  let contents: ArrayBuffer | string | undefined;
  try {
    contents = readFileSync({ path, options: { encoding: "utf8" } });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
  if (typeof contents !== "string") return [];
  const parsed: unknown = JSON.parse(contents);
  if (!isRecord(parsed) || parsed.version !== VERSION || !Array.isArray(parsed.pending)) {
    throw new Error("Pending IMU transfer manifest is invalid.");
  }
  return parsed.pending.map(parsePending);
}

function writePendingImuTransfers(path: string, pending: PendingImuTransfer[]): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync({ path: temporaryPath, data: JSON.stringify({ version: VERSION, pending }) });
  const result = renameSync({ oldPath: temporaryPath, newPath: path });
  if (result !== 0) {
    throw new Error(`Could not commit the pending IMU transfer manifest (${result}).`);
  }
}

export function savePendingImuTransfer(path: string, entry: PendingImuTransfer): void {
  const pending = readPendingImuTransfers(path).filter(
    (candidate) => candidate.slot !== entry.slot,
  );
  writePendingImuTransfers(path, [...pending, entry]);
}

export function clearPendingImuTransfer(path: string, slot: ImuFileSlot): void {
  const pending = readPendingImuTransfers(path).filter((candidate) => candidate.slot !== slot);
  writePendingImuTransfers(path, pending);
}

export function persistAndApplyPendingImuTransfer<T extends ImuSegmentResult>(
  path: string,
  slot: ImuFileSlot,
  transfer: T | null,
  apply: (transfer: T | null) => void,
): void {
  if (transfer) savePendingImuTransfer(path, { ...transfer, slot });
  else clearPendingImuTransfer(path, slot);
  apply(transfer);
}
