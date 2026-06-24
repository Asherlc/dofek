import { BaseSideService } from "@zeppos/zml/base-side";
import { messagingPlugin } from "@zeppos/zml/3.0/module/messaging/plugin/side";

import {
  FREQ_MODE_LABELS,
  LOGGING_CMD,
  STORAGE_KEYS,
} from "../utils/storage-keys";

BaseSideService.use(messagingPlugin);

const logger = Logger.getLogger("imu-side");

function readJson(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function buildExportPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `data://export/imu_${stamp}.bin`;
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
        enableGyro:
          settings.settingsStorage.getItem(STORAGE_KEYS.PREF_ENABLE_GYRO) ===
          "true",
        freqModeIndex: Number(
          settings.settingsStorage.getItem(STORAGE_KEYS.PREF_FREQ_MODE) ?? 1
        ),
      };
    },

    setSessionStatus(payload) {
      settings.settingsStorage.setItem(
        STORAGE_KEYS.SESSION_STATUS,
        JSON.stringify(payload)
      );
    },

    handleSettingsChange(key, newValue) {
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
        settings.settingsStorage.setItem(
          STORAGE_KEYS.CMD_LOGGING,
          LOGGING_CMD.IDLE
        );
        return;
      }

      if (key === STORAGE_KEYS.CMD_TRANSFER) {
        this.call({ method: "transfer.start", params: {} });
      }
    },

    onReceivedFile(file) {
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
        })
      );

      file.on("progress", (event) => {
        const { loadedSize, fileSize } = event.data;
        settings.settingsStorage.setItem(
          STORAGE_KEYS.TRANSFER_PROGRESS,
          JSON.stringify({
            state: "receiving",
            loadedSize,
            fileSize,
            pct: fileSize ? Math.floor((loadedSize * 100) / fileSize) : 0,
          })
        );
      });

      file.on("change", (event) => {
        if (event.data.readyState === "transferred") {
          const exportPath = file.filePath || buildExportPath();
          settings.settingsStorage.setItem(STORAGE_KEYS.LAST_EXPORT_PATH, exportPath);
          settings.settingsStorage.setItem(
            STORAGE_KEYS.TRANSFER_PROGRESS,
            JSON.stringify({
              state: "done",
              path: exportPath,
            })
          );

          const status = readJson(
            settings.settingsStorage.getItem(STORAGE_KEYS.SESSION_STATUS),
            {}
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
            JSON.stringify({ state: "error" })
          );
        }
      });
    },

    onCall(payload) {
      logger.log("onCall %j", payload);
    },

    onRequest(req, res) {
      const { method, params = {} } = req;

      if (method === "imu.getPreferences") {
        res(null, this.getPreferences());
        return;
      }

      if (method === "imu.publishStatus") {
        const label = FREQ_MODE_LABELS[params.freqModeIndex] || "configured";
        this.setSessionStatus({
          ...params,
          freqLabel: label,
          updatedAt: Date.now(),
        });
        res(null, { ok: true });
        return;
      }

      if (method === "imu.transferComplete") {
        const status = readJson(
          settings.settingsStorage.getItem(STORAGE_KEYS.SESSION_STATUS),
          {}
        );
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
  })
);
