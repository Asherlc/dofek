export const STORAGE_KEYS = {
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
} as const;

export const FREQ_MODE_LABELS: Record<number, string> = {
  0: "LOW",
  1: "NORMAL",
  2: "HIGH",
};

export const SESSION_FILE_A = "data://imu/session_a.bin";
export const SESSION_FILE_B = "data://imu/session_b.bin";
export const SESSION_META_FILE = "data://imu/session_meta.json";
export const SERVICE_FILE = "app-service/imu_service";

export const FLUSH_SAMPLE_THRESHOLD = 64;
export const AUTO_TRANSFER_SAMPLE_COUNT = 5000;
