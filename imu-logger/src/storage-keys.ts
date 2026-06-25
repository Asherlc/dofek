export const STORAGE_KEYS = {
  PREF_ENABLE_GYRO: "pref_enable_gyro",
  PREF_FREQ_MODE: "pref_freq_mode",
  CMD_LOGGING: "cmd_logging",
  CMD_TRANSFER: "cmd_transfer",
  SESSION_STATUS: "session_status",
  LAST_EXPORT_PATH: "last_export_path",
  TRANSFER_PROGRESS: "transfer_progress",
} as const;

export const LOGGING_CMD = {
  IDLE: "idle",
  START: "start",
  STOP: "stop",
} as const;

export const FREQ_MODE_LABELS: Record<number, string> = {
  0: "LOW",
  1: "NORMAL",
  2: "HIGH",
};

export const SESSION_FILE = "data://imu/session.bin";
export const SESSION_META_FILE = "data://imu/session_meta.json";
export const SERVICE_FILE = "app-service/imu_service";

export const FLUSH_SAMPLE_THRESHOLD = 64;
