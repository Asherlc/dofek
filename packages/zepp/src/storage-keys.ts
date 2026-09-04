export const STORAGE_KEYS = {
  PREF_FREQ_MODE: "pref_freq_mode",
  CMD_LOGGING: "cmd_logging",
  CMD_TRANSFER: "cmd_transfer",
  SESSION_STATUS: "session_status",
  LAST_EXPORT_PATH: "last_export_path",
  TRANSFER_PROGRESS: "transfer_progress",
  CMD_SYNC_HEALTH: "cmd_sync_health",
  CMD_START_PAIRING: "cmd_start_pairing",
  CMD_CHECK_CONNECTION: "cmd_check_connection",
  CMD_DISCONNECT: "cmd_disconnect",
  DOFEK_SERVER_URL: "dofek_server_url",
  DOFEK_EMAIL: "dofek_email",
  DOFEK_API_TOKEN: "dofek_api_token",
  CMD_LOGIN_PASSWORD: "cmd_login_password",
  DOFEK_CONNECTION_STATUS: "dofek_connection_status",
  PAIRING_ID: "pairing_id",
  PAIRING_SHORT_CODE: "pairing_short_code",
  PAIRING_VERIFICATION_URL: "pairing_verification_url",
  PAIRING_QR_IMAGE_URL: "pairing_qr_image_url",
  PAIRING_EXPIRES_AT: "pairing_expires_at",
  HEALTH_SYNC_STATUS: "health_sync_status",
  HEALTH_SERVICE_STATUS: "health_service_status",
  IMU_SYNC_STATUS: "imu_sync_status",
  LAST_HEALTH_SYNC: "last_health_sync",
  PHONE_HEALTH_OUTBOX: "phone_health_outbox",
  PHONE_IMU_OUTBOX: "phone_imu_outbox",
  PHONE_IMU_FILES: "phone_imu_files",
  TELEMETRY_BUFFER: "telemetry_buffer",
  TELEMETRY_INSTALL_ID: "telemetry_install_id",
} as const;

export const DEFAULT_DOFEK_SERVER_URL = "https://dofek.fit";

export const FREQ_MODE_LABELS: Record<number, string> = {
  0: "LOW",
  1: "NORMAL",
  2: "HIGH",
};

export const SESSION_FILE_A = "data://imu/normal_a.bin";
export const SESSION_FILE_B = "data://imu/normal_b.bin";
export const WORKOUT_SESSION_FILE_A = "data://imu/workout_a.bin";
export const WORKOUT_SESSION_FILE_B = "data://imu/workout_b.bin";
export const NORMAL_IMU_TRANSFER_FILE = "data://imu/normal_transfers.json";
export const WORKOUT_IMU_TRANSFER_FILE = "data://imu/workout_transfers.json";
export const NORMAL_IMU_CHUNK_DIRECTORY = "data://imu/normal_chunks";
export const WORKOUT_IMU_CHUNK_DIRECTORY = "data://imu/workout_chunks";
export const SESSION_META_FILE = "data://imu/session_meta.json";
export const BACKGROUND_HEALTH_FILE = "data://health/background.json";
export const HEALTH_SERVICE_FILE = "app-service/health_service";

export const FLUSH_SAMPLE_THRESHOLD = 64;
export const AUTO_TRANSFER_SAMPLE_COUNT = 5000;
