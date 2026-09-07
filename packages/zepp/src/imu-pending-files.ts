import { closeSync, O_CREAT, O_RDWR, openSync, readFileSync, writeFileSync } from "@zos/fs";

export interface PendingImuFile {
  slot: "A" | "B";
  sampleCount: number;
  observedHzX100: number;
  connection?: { serverUrl: string; accountId: string };
}
const JOURNAL_PATH = "data://imu/pending.json";

export function readPendingImuFiles(): PendingImuFile[] {
  // O_CREAT initializes first use without truncating existing pending state.
  const fd = openSync({ path: JOURNAL_PATH, flag: O_RDWR | O_CREAT });
  closeSync({ fd });
  const raw = readFileSync({ path: JOURNAL_PATH, options: { encoding: "utf8" } });
  if (raw === "") return [];
  if (typeof raw !== "string") throw new Error("Cannot read pending IMU file journal");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Invalid pending IMU file journal");
  const files: PendingImuFile[] = [];
  for (const entry of parsed) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      (entry.slot !== "A" && entry.slot !== "B") ||
      !Number.isInteger(entry.sampleCount) ||
      entry.sampleCount < 0 ||
      !Number.isInteger(entry.observedHzX100) ||
      entry.observedHzX100 < 0 ||
      (entry.connection !== undefined &&
        (typeof entry.connection !== "object" ||
          entry.connection === null ||
          typeof entry.connection.serverUrl !== "string" ||
          !entry.connection.serverUrl.trim() ||
          typeof entry.connection.accountId !== "string" ||
          !entry.connection.accountId.trim())) ||
      files.some((file) => file.slot === entry.slot)
    )
      throw new Error("Invalid pending IMU file journal");
    files.push({
      slot: entry.slot,
      sampleCount: entry.sampleCount,
      observedHzX100: entry.observedHzX100,
      ...(entry.connection !== undefined
        ? {
            connection: {
              serverUrl: entry.connection.serverUrl,
              accountId: entry.connection.accountId,
            },
          }
        : {}),
    });
  }
  return files;
}
export function writePendingImuFiles(files: PendingImuFile[]): void {
  writeFileSync({ path: JOURNAL_PATH, data: JSON.stringify(files) });
}
