import { describe, expect, it } from "vitest";
import {
  AUTO_TRANSFER_SAMPLE_COUNT,
  FLUSH_SAMPLE_THRESHOLD,
  FREQ_MODE_LABELS,
  SERVICE_FILE,
  SESSION_FILE_A,
  SESSION_FILE_B,
  SESSION_META_FILE,
  STORAGE_KEYS,
} from "./storage-keys.ts";

describe("Zepp storage keys", () => {
  it("keeps the storage key contract stable", () => {
    expect(STORAGE_KEYS).toEqual({
      PREF_ENABLE_GYRO: "pref_enable_gyro",
      PREF_FREQ_MODE: "pref_freq_mode",
      CMD_TRANSFER: "cmd_transfer",
      SESSION_STATUS: "session_status",
      LAST_EXPORT_PATH: "last_export_path",
      TRANSFER_PROGRESS: "transfer_progress",
      CMD_SYNC_HEALTH: "cmd_sync_health",
      DOFEK_SERVER_URL: "dofek_server_url",
      DOFEK_API_TOKEN: "dofek_api_token",
      HEALTH_SYNC_STATUS: "health_sync_status",
      LAST_HEALTH_SYNC: "last_health_sync",
    });
  });

  it("keeps session file paths and thresholds stable", () => {
    expect(FREQ_MODE_LABELS).toEqual({
      0: "LOW",
      1: "NORMAL",
      2: "HIGH",
    });
    expect(SESSION_FILE_A).toBe("data://imu/session_a.bin");
    expect(SESSION_FILE_B).toBe("data://imu/session_b.bin");
    expect(SESSION_META_FILE).toBe("data://imu/session_meta.json");
    expect(SERVICE_FILE).toBe("app-service/imu_service");
    expect(FLUSH_SAMPLE_THRESHOLD).toBe(64);
    expect(AUTO_TRANSFER_SAMPLE_COUNT).toBe(5000);
  });
});
