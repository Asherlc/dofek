import { describe, expect, it } from "vitest";
import {
  AUTO_TRANSFER_SAMPLE_COUNT,
  DEFAULT_DOFEK_SERVER_URL,
  FLUSH_SAMPLE_THRESHOLD,
  FREQ_MODE_LABELS,
  SERVICE_FILE,
  SESSION_FILE_A,
  SESSION_FILE_B,
  SESSION_META_FILE,
} from "./storage-keys.ts";

describe("Zepp storage keys", () => {
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
    expect(DEFAULT_DOFEK_SERVER_URL).toBe("https://dofek.asherlc.com");
  });
});
