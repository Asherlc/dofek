import { messagingPlugin } from "@zeppos/zml/3.0/module/messaging/plugin/side";
import { BaseSideService } from "@zeppos/zml/base-side";

import { FREQ_MODE_LABELS, LOGGING_CMD, STORAGE_KEYS } from "../src/storage-keys.ts";

BaseSideService.use(messagingPlugin);

const logger = Logger.getLogger("imu-side");

function readJson(raw: string | null, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : fallback;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed));
    }
    return fallback;
  } catch {
    return fallback;
  }
}

AppSideService(
  BaseSideService({
    onInit() {
      settings.settingsStorage.addListener("change", ({ key, newValue }) => {
        this.handleSettingsChange(key, newValue);
      });
    },

    onRun() {
      logger.log("side service running");
    },

    onDestroy() {
      logger.log("side service destroyed");
    },

    getPreferences() {
      return {
        enableGyro: settings.settingsStorage.getItem(STORAGE_KEYS.PREF_ENABLE_GYRO) === "true",
        freqModeIndex: Number(settings.settingsStorage.getItem(STORAGE_KEYS.PREF_FREQ_MODE) ?? 1),
      };
    },

    setSessionStatus(payload: Record<string, unknown>) {
      settings.settingsStorage.setItem(STORAGE_KEYS.SESSION_STATUS, JSON.stringify(payload));
    },

    handleSettingsChange(key: string, newValue: string) {
      if (key === STORAGE_KEYS.CMD_LOGGING) {
        if (newValue === LOGGING_CMD.START) {
          const prefs = this.getPreferences();
          this.call({
            method: "logging.start",
            params: prefs,
          });
        } else if (newValue === LOGGING_CMD.STOP) {
          this.call({ method: "logging.stop", params: {} });
        }
        settings.settingsStorage.setItem(STORAGE_KEYS.CMD_LOGGING, LOGGING_CMD.IDLE);
        return;
      }

      if (key === STORAGE_KEYS.CMD_TRANSFER) {
        this.call({ method: "transfer.start", params: {} });
      }
    },

    onReceivedFile(file: {
      fileName?: string;
      filePath?: string;
      params?: Record<string, unknown>;
      on: (event: string, callback: (event: { data: Record<string, unknown> }) => void) => void;
    }) {
      logger.log("received file from watch %j", {
        fileName: file.fileName,
        filePath: file.filePath,
        params: file.params,
      });

      settings.settingsStorage.setItem(
        STORAGE_KEYS.TRANSFER_PROGRESS,
        JSON.stringify({
          state: "receiving",
          fileName: file.fileName,
        }),
      );

      file.on("progress", (event: { data: Record<string, unknown> }) => {
        const loadedSize = Number(event.data.loadedSize);
        const fileSize = Number(event.data.fileSize);
        settings.settingsStorage.setItem(
          STORAGE_KEYS.TRANSFER_PROGRESS,
          JSON.stringify({
            state: "receiving",
            loadedSize,
            fileSize,
            pct: fileSize ? Math.floor(((loadedSize ?? 0) * 100) / fileSize) : 0,
          }),
        );
      });

      file.on("change", (event: { data: Record<string, unknown> }) => {
        if (event.data.readyState === "transferred") {
          const exportPath = file.filePath;
          if (!exportPath) {
            logger.error("file transfer complete but no filePath provided by SDK");
            settings.settingsStorage.setItem(
              STORAGE_KEYS.TRANSFER_PROGRESS,
              JSON.stringify({ state: "error", reason: "no file path" }),
            );
            return;
          }
          settings.settingsStorage.setItem(STORAGE_KEYS.LAST_EXPORT_PATH, exportPath);
          settings.settingsStorage.setItem(
            STORAGE_KEYS.TRANSFER_PROGRESS,
            JSON.stringify({
              state: "done",
              path: exportPath,
            }),
          );

          const status = readJson(
            settings.settingsStorage.getItem(STORAGE_KEYS.SESSION_STATUS),
            {},
          );

          this.setSessionStatus({
            ...status,
            lastExportPath: exportPath,
            transferState: "done",
          });
          return;
        }

        if (event.data.readyState === "error") {
          settings.settingsStorage.setItem(
            STORAGE_KEYS.TRANSFER_PROGRESS,
            JSON.stringify({ state: "error" }),
          );
        }
      });
    },

    onCall(payload: Record<string, unknown> | null) {
      logger.log("onCall %j", payload);
    },

    onRequest(
      req: { method: string; params?: Record<string, unknown> },
      res: (error: unknown, result: unknown) => void,
    ) {
      const { method, params = {} } = req;

      if (method === "imu.getPreferences") {
        res(null, this.getPreferences());
        return;
      }

      if (method === "imu.publishStatus") {
        const label = FREQ_MODE_LABELS[Number(params.freqModeIndex)] ?? "configured";
        this.setSessionStatus({
          ...params,
          freqLabel: label,
          updatedAt: Date.now(),
        });
        res(null, { ok: true });
        return;
      }

      if (method === "imu.transferComplete") {
        const status = readJson(settings.settingsStorage.getItem(STORAGE_KEYS.SESSION_STATUS), {});
        this.setSessionStatus({
          ...status,
          transferState: "sent",
          sampleCount: params.sampleCount ?? status.sampleCount,
          updatedAt: Date.now(),
        });
        res(null, { ok: true });
        return;
      }

      res(null, { ok: false, message: "unknown method" });
    },
  }),
);
