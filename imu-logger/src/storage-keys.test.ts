import { describe, expect, it } from "vitest";
import {
  FLUSH_SAMPLE_THRESHOLD,
  FREQ_MODE_LABELS,
  LOGGING_CMD,
  SERVICE_FILE,
  SESSION_FILE,
  SESSION_META_FILE,
  STORAGE_KEYS,
} from "./storage-keys.ts";

describe("STORAGE_KEYS", () => {
  it("defines all expected keys", () => {
    expect(STORAGE_KEYS.PREF_ENABLE_GYRO).toBe("pref_enable_gyro");
    expect(STORAGE_KEYS.PREF_FREQ_MODE).toBe("pref_freq_mode");
    expect(STORAGE_KEYS.CMD_LOGGING).toBe("cmd_logging");
    expect(STORAGE_KEYS.CMD_TRANSFER).toBe("cmd_transfer");
    expect(STORAGE_KEYS.SESSION_STATUS).toBe("session_status");
    expect(STORAGE_KEYS.LAST_EXPORT_PATH).toBe("last_export_path");
    expect(STORAGE_KEYS.TRANSFER_PROGRESS).toBe("transfer_progress");
  });

  it("has exactly 7 keys", () => {
    expect(Object.keys(STORAGE_KEYS)).toHaveLength(7);
  });
});

describe("LOGGING_CMD", () => {
  it("defines start, stop, idle", () => {
    expect(LOGGING_CMD.IDLE).toBe("idle");
    expect(LOGGING_CMD.START).toBe("start");
    expect(LOGGING_CMD.STOP).toBe("stop");
  });
});

describe("FREQ_MODE_LABELS", () => {
  it("maps indices to labels", () => {
    expect(FREQ_MODE_LABELS[0]).toBe("LOW");
    expect(FREQ_MODE_LABELS[1]).toBe("NORMAL");
    expect(FREQ_MODE_LABELS[2]).toBe("HIGH");
  });
});

describe("constants", () => {
  it("defines file paths", () => {
    expect(SESSION_FILE).toBe("data://imu/session.bin");
    expect(SESSION_META_FILE).toBe("data://imu/session_meta.json");
    expect(SERVICE_FILE).toBe("app-service/imu_service");
  });

  it("defines flush threshold", () => {
    expect(FLUSH_SAMPLE_THRESHOLD).toBe(64);
  });
});
