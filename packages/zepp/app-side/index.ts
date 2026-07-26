import { messagingPlugin } from "@zeppos/zml/3.0/module/messaging/plugin/side";
import { BaseSideService } from "@zeppos/zml/base-side";
import { shouldRetryPairingPollFailure } from "../src/pairing-poll.ts";
import { parseSessionCommand, SESSION_COMMAND } from "../src/session-control.ts";
import { DEFAULT_DOFEK_SERVER_URL, FREQ_MODE_LABELS, STORAGE_KEYS } from "../src/storage-keys.ts";
import { summarizeZeppFetchResponse, type ZeppFetchResponse } from "../src/zepp-fetch.ts";

BaseSideService.use(messagingPlugin);

const logger = Logger.getLogger("imu-side");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function getString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function getRawString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  return typeof raw === "string" ? raw : "";
}

function getStoredServerUrl(): string {
  const storedServerUrl = settings.settingsStorage.getItem(STORAGE_KEYS.DOFEK_SERVER_URL)?.trim();
  return storedServerUrl || DEFAULT_DOFEK_SERVER_URL;
}

AppSideService(
  BaseSideService({
    onInit() {
      settings.settingsStorage.addListener("change", ({ key, newValue }) => {
        this.handleSettingsChange(key, newValue);
      });
      const pairingId = settings.settingsStorage.getItem(STORAGE_KEYS.PAIRING_ID)?.trim();
      const apiToken = settings.settingsStorage.getItem(STORAGE_KEYS.DOFEK_API_TOKEN)?.trim();
      if (pairingId && !apiToken) {
        this.schedulePairingPoll(pairingId, getStoredServerUrl());
      }
    },

    onRun() {
      logger.log("side service running");
    },

    onDestroy() {
      logger.log("side service destroyed");
    },

    getPreferences() {
      const serverUrl = getStoredServerUrl();
      const apiToken = settings.settingsStorage.getItem(STORAGE_KEYS.DOFEK_API_TOKEN)?.trim();
      return {
        enableGyro: settings.settingsStorage.getItem(STORAGE_KEYS.PREF_ENABLE_GYRO) === "true",
        freqModeIndex: Number(settings.settingsStorage.getItem(STORAGE_KEYS.PREF_FREQ_MODE) ?? 1),
        hasCredentials: Boolean(serverUrl && apiToken),
        serverUrl,
        pairing: this.getPairingInfo(),
      };
    },

    getPairingInfo() {
      const pairingId = settings.settingsStorage.getItem(STORAGE_KEYS.PAIRING_ID)?.trim();
      const shortCode = settings.settingsStorage.getItem(STORAGE_KEYS.PAIRING_SHORT_CODE)?.trim();
      const verificationUrl = settings.settingsStorage
        .getItem(STORAGE_KEYS.PAIRING_VERIFICATION_URL)
        ?.trim();
      const qrImageUrl = settings.settingsStorage
        .getItem(STORAGE_KEYS.PAIRING_QR_IMAGE_URL)
        ?.trim();
      const expiresAt = settings.settingsStorage.getItem(STORAGE_KEYS.PAIRING_EXPIRES_AT)?.trim();
      if (!pairingId || !shortCode || !verificationUrl || !expiresAt) {
        return null;
      }
      return {
        pairingId,
        shortCode,
        verificationUrl,
        qrImageUrl: qrImageUrl || null,
        expiresAt,
      };
    },

    setSessionStatus(payload: Record<string, unknown>) {
      settings.settingsStorage.setItem(STORAGE_KEYS.SESSION_STATUS, JSON.stringify(payload));
    },

    handleSettingsChange(key: string, newValue: unknown) {
      if (key === STORAGE_KEYS.CMD_LOGGING) {
        const command = parseSessionCommand(newValue);
        if (!command) {
          return;
        }
        this.call({
          method: command === SESSION_COMMAND.START ? "logging.start" : "logging.stop",
          params: command === SESSION_COMMAND.START ? this.getPreferences() : {},
        });
        settings.settingsStorage.removeItem(STORAGE_KEYS.CMD_LOGGING);
        return;
      }

      if (key === STORAGE_KEYS.CMD_TRANSFER) {
        this.call({ method: "transfer.start", params: {} });
      }

      if (key === STORAGE_KEYS.CMD_SYNC_HEALTH) {
        this.call({ method: "health.collect", params: {} });
      }

      if (key === STORAGE_KEYS.CMD_START_PAIRING) {
        this.startPairing().catch((error: unknown) => {
          logger.error("pairing start failed %j", error);
        });
      }

      if (key === STORAGE_KEYS.CMD_LOGIN_PASSWORD && typeof newValue === "string" && newValue) {
        this.loginWithPassword(newValue).catch((error: unknown) => {
          logger.error("password login failed %j", error);
        });
      }
    },

    setConnectionStatus(payload: Record<string, unknown>) {
      settings.settingsStorage.setItem(
        STORAGE_KEYS.DOFEK_CONNECTION_STATUS,
        JSON.stringify(payload),
      );
    },

    clearPairingInfo() {
      settings.settingsStorage.removeItem(STORAGE_KEYS.PAIRING_ID);
      settings.settingsStorage.removeItem(STORAGE_KEYS.PAIRING_SHORT_CODE);
      settings.settingsStorage.removeItem(STORAGE_KEYS.PAIRING_VERIFICATION_URL);
      settings.settingsStorage.removeItem(STORAGE_KEYS.PAIRING_QR_IMAGE_URL);
      settings.settingsStorage.removeItem(STORAGE_KEYS.PAIRING_EXPIRES_AT);
    },

    isCurrentPairing(pairingId: string) {
      return settings.settingsStorage.getItem(STORAGE_KEYS.PAIRING_ID)?.trim() === pairingId;
    },

    savePairingInfo(payload: Record<string, unknown>) {
      const pairingId = getString(payload, "pairingId");
      const shortCode = getString(payload, "shortCode");
      const verificationUrl = getString(payload, "verificationUrl");
      const qrImageUrl = getString(payload, "qrImageUrl");
      const expiresAt = getString(payload, "expiresAt");

      if (!pairingId || !shortCode || !verificationUrl || !expiresAt) {
        throw new Error("Dofek pairing response was missing required fields.");
      }

      settings.settingsStorage.setItem(STORAGE_KEYS.PAIRING_ID, pairingId);
      settings.settingsStorage.setItem(STORAGE_KEYS.PAIRING_SHORT_CODE, shortCode);
      settings.settingsStorage.setItem(STORAGE_KEYS.PAIRING_VERIFICATION_URL, verificationUrl);
      settings.settingsStorage.setItem(STORAGE_KEYS.PAIRING_QR_IMAGE_URL, qrImageUrl);
      settings.settingsStorage.setItem(STORAGE_KEYS.PAIRING_EXPIRES_AT, expiresAt);
      this.setConnectionStatus({ state: "pairing", shortCode, verificationUrl });

      return { pairingId, shortCode, verificationUrl, qrImageUrl, expiresAt };
    },

    async startPairing() {
      const serverUrl = getStoredServerUrl();
      try {
        this.setConnectionStatus({ state: "pairing" });
        const response = await fetch({
          url: `${serverUrl.replace(/\/$/, "")}/api/companion-pairing/start`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const summary = summarizeZeppFetchResponse(response);
        if (!summary.ok) {
          throw new Error(summary.errorMessage ?? "Dofek pairing failed.");
        }
        if (!isRecord(summary.body)) {
          throw new Error("Dofek pairing response was invalid.");
        }
        const pairingInfo = this.savePairingInfo(summary.body);
        this.schedulePairingPoll(pairingInfo.pairingId, serverUrl);
        return pairingInfo;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Dofek pairing failed.";
        this.setConnectionStatus({ state: "error", reason: message });
        throw error;
      }
    },

    schedulePairingPoll(pairingId: string, serverUrl: string) {
      setTimeout(() => {
        this.pollPairing(pairingId, serverUrl).catch((error: unknown) => {
          logger.error("pairing poll failed %j", error);
        });
      }, 3000);
    },

    async pollPairing(pairingId: string, serverUrl: string) {
      if (!this.isCurrentPairing(pairingId)) {
        return;
      }
      const expiresAt = settings.settingsStorage.getItem(STORAGE_KEYS.PAIRING_EXPIRES_AT);
      if (expiresAt && Date.now() >= new Date(expiresAt).getTime()) {
        this.setConnectionStatus({ state: "error", reason: "Pairing code expired." });
        return;
      }

      let response: ZeppFetchResponse;
      try {
        response = await fetch({
          url: `${serverUrl.replace(/\/$/, "")}/api/companion-pairing/status/${encodeURIComponent(
            pairingId,
          )}`,
        });
      } catch (error) {
        logger.error("pairing poll request failed %j", error);
        this.schedulePairingPoll(pairingId, serverUrl);
        return;
      }
      const summary = summarizeZeppFetchResponse(response);
      if (!summary.ok) {
        if (shouldRetryPairingPollFailure(summary)) {
          logger.error("pairing poll transient response failed %j", summary.errorMessage);
          this.schedulePairingPoll(pairingId, serverUrl);
          return;
        }
        this.setConnectionStatus({
          state: "error",
          reason: "Pairing code expired.",
        });
        return;
      }
      if (!isRecord(summary.body)) {
        this.setConnectionStatus({
          state: "error",
          reason: "Dofek pairing status response was invalid.",
        });
        return;
      }
      if (!this.isCurrentPairing(pairingId)) {
        return;
      }

      const state = getString(summary.body, "state");
      if (state === "claimed") {
        const companionToken = getString(summary.body, "companionToken");
        if (!companionToken) {
          throw new Error("Dofek pairing completed without connection credentials.");
        }
        settings.settingsStorage.setItem(STORAGE_KEYS.DOFEK_API_TOKEN, companionToken);
        this.clearPairingInfo();
        this.setConnectionStatus({ state: "connected" });
        return;
      }

      if (state === "pending") {
        this.setConnectionStatus({
          state: "pairing",
          shortCode: settings.settingsStorage.getItem(STORAGE_KEYS.PAIRING_SHORT_CODE),
        });
        this.schedulePairingPoll(pairingId, serverUrl);
        return;
      }

      this.setConnectionStatus({ state: "error", reason: "Pairing code expired." });
    },

    async loginWithPassword(rawPayload: string) {
      const payload = readJson(rawPayload, {});
      const serverUrl = getStoredServerUrl();
      const email = getString(payload, "email");
      const password = getRawString(payload, "password");
      settings.settingsStorage.removeItem(STORAGE_KEYS.CMD_LOGIN_PASSWORD);

      try {
        if (!serverUrl || !email || !password) {
          throw new Error("Server URL, email, and password are required.");
        }

        this.setConnectionStatus({ state: "connecting" });
        const response = await fetch({
          url: `${serverUrl.replace(/\/$/, "")}/api/companion-token/password-login`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const summary = summarizeZeppFetchResponse(response);
        if (!summary.ok) {
          throw new Error(summary.errorMessage ?? "Dofek login failed.");
        }

        if (!isRecord(summary.body) || typeof summary.body.token !== "string") {
          throw new Error("Dofek login did not return connection credentials.");
        }

        settings.settingsStorage.setItem(STORAGE_KEYS.DOFEK_EMAIL, email);
        settings.settingsStorage.setItem(STORAGE_KEYS.DOFEK_API_TOKEN, summary.body.token);
        this.clearPairingInfo();
        this.setConnectionStatus({ state: "connected" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Dofek login failed.";
        this.setConnectionStatus({ state: "error", reason: message });
        throw error;
      }
    },

    async postHealthData(data: Record<string, unknown>) {
      const serverUrl = getStoredServerUrl();
      const apiToken = settings.settingsStorage.getItem(STORAGE_KEYS.DOFEK_API_TOKEN)?.trim();

      if (!apiToken) {
        const message = "Connect Dofek from Zepp settings first.";
        logger.error(message);
        settings.settingsStorage.setItem(
          STORAGE_KEYS.HEALTH_SYNC_STATUS,
          JSON.stringify({ state: "error", reason: message }),
        );
        throw new Error(message);
      }

      const url = `${serverUrl.replace(/\/$/, "")}/api/ingest/zos-health`;

      try {
        const response = await fetch({
          url,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
          },
          body: JSON.stringify(data),
        });
        const summary = summarizeZeppFetchResponse(response);

        if (!summary.ok) {
          const message = summary.errorMessage ?? "health data upload failed";
          logger.error("health data upload failed: %s", message);
          settings.settingsStorage.setItem(
            STORAGE_KEYS.HEALTH_SYNC_STATUS,
            JSON.stringify({ state: "error", reason: message }),
          );
          throw new Error(message);
        }

        settings.settingsStorage.setItem(STORAGE_KEYS.LAST_HEALTH_SYNC, String(Date.now()));
        settings.settingsStorage.setItem(
          STORAGE_KEYS.HEALTH_SYNC_STATUS,
          JSON.stringify({ state: "done" }),
        );
        logger.log("health data uploaded successfully");
      } catch (error) {
        const message = error instanceof Error ? error.message : "health data upload failed";
        logger.error("health data upload fetch failed: %j", error);
        settings.settingsStorage.setItem(
          STORAGE_KEYS.HEALTH_SYNC_STATUS,
          JSON.stringify({ state: "error", reason: message }),
        );
        throw error;
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

      if (method === "dofek.startPairing") {
        this.startPairing()
          .then((pairingInfo: Record<string, unknown>) => res(null, pairingInfo))
          .catch((error: unknown) => res(error, null));
        return;
      }

      if (method === "dofek.loginWithPassword") {
        this.loginWithPassword(
          JSON.stringify({
            email: params.email,
            password: params.password,
          }),
        )
          .then(() => res(null, { ok: true }))
          .catch((error: unknown) => res(error, null));
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

      if (method === "health.upload") {
        const data = isRecord(params.data) ? params.data : undefined;
        if (!data) {
          res(new Error("no health data provided"), null);
          return;
        }
        this.postHealthData(data)
          .then(() => res(null, { ok: true }))
          .catch((err) => res(err, null));
        return;
      }

      res(null, { ok: false, message: "unknown method" });
    },
  }),
);
