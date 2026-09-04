import { messagingPlugin } from "@zeppos/zml/3.0/module/messaging/plugin/side";
import { BaseSideService } from "@zeppos/zml/base-side";
import { deriveConnectionActions, parseConnectionState } from "../src/connection-state.ts";
import {
  type HealthEnvelopeV1,
  type HealthUploadResponse,
  parseHealthEnvelope,
  parseHealthUploadResponse,
} from "../src/health-contract.ts";
import type { HealthUploadPayload } from "../src/health-upload.ts";
import { LatestOperation } from "../src/latest-operation.ts";
import { shouldRetryPairingPollFailure } from "../src/pairing-poll.ts";
import { persistHealthEnvelope } from "../src/phone-health-outbox.ts";
import { drainPhoneHealthOutbox } from "../src/phone-health-sync.ts";
import {
  clearBufferedTelemetryEvents,
  flushTelemetryEvents,
  captureException as reportPostHogException,
  restoreBufferedTelemetryEvents,
} from "../src/posthog-client.ts";
import { createSessionCall, parseSessionCommand } from "../src/session-control.ts";
import { DEFAULT_DOFEK_SERVER_URL, FREQ_MODE_LABELS, STORAGE_KEYS } from "../src/storage-keys.ts";
import { SyncCoordinator } from "../src/sync-coordinator.ts";
import { summarizeZeppFetchResponse, type ZeppFetchResponse } from "../src/zepp-fetch.ts";

BaseSideService.use(messagingPlugin);

const logger = Logger.getLogger("imu-side");
const connectionOperations = new LatestOperation();

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

function ensureTelemetryInstallId(): string {
  const existing = settings.settingsStorage.getItem(STORAGE_KEYS.TELEMETRY_INSTALL_ID)?.trim();
  if (existing) {
    return existing;
  }
  const installId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  settings.settingsStorage.setItem(STORAGE_KEYS.TELEMETRY_INSTALL_ID, installId);
  return installId;
}

function getTelemetryDistinctId(): string {
  const pairingId = settings.settingsStorage.getItem(STORAGE_KEYS.PAIRING_ID)?.trim();
  if (pairingId) {
    return `zepp-pairing:${pairingId}`;
  }
  const installId = settings.settingsStorage.getItem(STORAGE_KEYS.TELEMETRY_INSTALL_ID)?.trim();
  if (installId) {
    return `zepp-install:${installId}`;
  }
  return "zepp-side-unidentified";
}

function flushBufferedTelemetryFromWatch(): void {
  restoreBufferedTelemetryEvents(settings.settingsStorage.getItem(STORAGE_KEYS.TELEMETRY_BUFFER));
  flushTelemetryEvents()
    .then(() => {
      settings.settingsStorage.removeItem(STORAGE_KEYS.TELEMETRY_BUFFER);
      clearBufferedTelemetryEvents();
    })
    .catch((error: unknown) => {
      logger.error("telemetry flush failed %j", error);
      reportSideException(error, { category: "telemetry-flush" });
    });
}

function reportSideException(error: unknown, context: Record<string, unknown> = {}): void {
  logger.error("captured exception %j", error);
  void reportPostHogException(error, {
    ...context,
    distinctId: getTelemetryDistinctId(),
    source: "zepp-side",
    connectionType: DOFEK_COMPANION_CONNECTION_TYPE,
  });
}

function getStoredServerUrl(): string {
  const storedServerUrl = settings.settingsStorage.getItem(STORAGE_KEYS.DOFEK_SERVER_URL)?.trim();
  return storedServerUrl || DEFAULT_DOFEK_SERVER_URL;
}

function setHealthSyncStatus(payload: Record<string, unknown>): void {
  settings.settingsStorage.setItem(STORAGE_KEYS.HEALTH_SYNC_STATUS, JSON.stringify(payload));
}

async function postHealthEnvelope(
  envelope: HealthEnvelopeV1<HealthUploadPayload>,
): Promise<HealthUploadResponse> {
  const serverUrl = getStoredServerUrl();
  const apiToken = settings.settingsStorage.getItem(STORAGE_KEYS.DOFEK_API_TOKEN)?.trim();
  if (!apiToken) {
    throw new Error("Connect Dofek from Zepp settings first.");
  }

  const response = await fetch({
    url: `${serverUrl.replace(/\/$/, "")}/api/ingest/zos-health`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify(envelope),
  });
  const summary = summarizeZeppFetchResponse(response);
  if (!summary.ok) {
    if (summary.status === 401) {
      settings.settingsStorage.removeItem(STORAGE_KEYS.DOFEK_API_TOKEN);
      settings.settingsStorage.setItem(
        STORAGE_KEYS.DOFEK_CONNECTION_STATUS,
        JSON.stringify({ state: "error", reason: "Dofek connection expired. Connect again." }),
      );
    }
    throw new Error(summary.errorMessage ?? "Health data upload failed.");
  }
  return parseHealthUploadResponse(summary.body);
}

const healthSyncCoordinator = new SyncCoordinator(async (reasons) => {
  setHealthSyncStatus({ state: "syncing", reasons });
  try {
    const result = await drainPhoneHealthOutbox(settings.settingsStorage, postHealthEnvelope);
    settings.settingsStorage.setItem(STORAGE_KEYS.LAST_HEALTH_SYNC, String(Date.now()));
    setHealthSyncStatus({ state: "done", ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Health data upload failed.";
    reportSideException(error, { category: "health-upload", reasons });
    setHealthSyncStatus({ state: "error", reason: message });
  }
});

AppSideService(
  BaseSideService({
    onInit() {
      ensureTelemetryInstallId();
      flushBufferedTelemetryFromWatch();
      settings.settingsStorage.addListener("change", ({ key, newValue }) => {
        this.handleSettingsChange(key, newValue);
      });
      const pairingId = settings.settingsStorage.getItem(STORAGE_KEYS.PAIRING_ID)?.trim();
      const apiToken = settings.settingsStorage.getItem(STORAGE_KEYS.DOFEK_API_TOKEN)?.trim();
      if (pairingId && !apiToken) {
        this.schedulePairingPoll(pairingId, getStoredServerUrl(), connectionOperations.begin());
      }
      if (apiToken) {
        this.verifyConnection().catch((error: unknown) => {
          reportSideException(error, { category: "connection-verification" });
        });
      } else if (!pairingId) {
        this.setConnectionStatus({ state: "disconnected" });
      }
    },

    onRun() {
      logger.log("side service running");
      if (settings.settingsStorage.getItem(STORAGE_KEYS.DOFEK_API_TOKEN)?.trim()) {
        this.requestHealthCatchup("side-service-run");
      }
    },

    onDestroy() {
      logger.log("side service destroyed");
    },

    getPreferences() {
      const serverUrl = getStoredServerUrl();
      const apiToken = settings.settingsStorage.getItem(STORAGE_KEYS.DOFEK_API_TOKEN)?.trim();
      const connectionStatus = readJson(
        settings.settingsStorage.getItem(STORAGE_KEYS.DOFEK_CONNECTION_STATUS),
        {},
      );
      const connectionState = parseConnectionState(connectionStatus.state);
      const connectionActions = deriveConnectionActions(connectionState, Boolean(apiToken));
      return {
        freqModeIndex: Number(settings.settingsStorage.getItem(STORAGE_KEYS.PREF_FREQ_MODE) ?? 1),
        hasCredentials: Boolean(serverUrl && apiToken && connectionState === "connected"),
        canStartConnection: connectionActions.showPairing,
        connectionState,
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

    requestHealthCatchup(reason: string) {
      try {
        this.call({ method: "health.collect", params: {} });
      } catch (error) {
        reportSideException(error, { category: "request-watch-health", reason });
      }
      void healthSyncCoordinator.requestDrain(reason);
    },

    handleSettingsChange(key: string, newValue: unknown) {
      if (key === STORAGE_KEYS.CMD_LOGGING) {
        const command = parseSessionCommand(newValue);
        if (!command) {
          return;
        }
        this.call(createSessionCall(command, this.getPreferences()));
        settings.settingsStorage.removeItem(STORAGE_KEYS.CMD_LOGGING);
        return;
      }

      if (key === STORAGE_KEYS.CMD_TRANSFER) {
        this.call({ method: "transfer.start", params: {} });
      }

      if (key === STORAGE_KEYS.CMD_SYNC_HEALTH) {
        this.requestHealthCatchup("manual");
      }

      if (key === STORAGE_KEYS.CMD_START_PAIRING) {
        this.startPairing().catch((error: unknown) => {
          reportSideException(error, { category: "pairing-start" });
        });
      }

      if (key === STORAGE_KEYS.CMD_CHECK_CONNECTION) {
        this.verifyConnection().catch((error: unknown) => {
          reportSideException(error, { category: "connection-verification" });
        });
      }

      if (key === STORAGE_KEYS.CMD_DISCONNECT) {
        this.disconnect().catch((error: unknown) => {
          reportSideException(error, { category: "disconnect" });
        });
      }

      if (key === STORAGE_KEYS.CMD_LOGIN_PASSWORD && typeof newValue === "string" && newValue) {
        this.loginWithPassword(newValue).catch((error: unknown) => {
          reportSideException(error, { category: "password-login" });
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
      if (settings.settingsStorage.getItem(STORAGE_KEYS.DOFEK_API_TOKEN)?.trim()) {
        throw new Error("Disconnect the existing Dofek connection before pairing again.");
      }
      const operation = connectionOperations.begin();
      const serverUrl = getStoredServerUrl();
      try {
        this.setConnectionStatus({ state: "pairing" });
        const response = await fetch({
          url: `${serverUrl.replace(/\/$/, "")}/api/companion-pairing/start`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionType: DOFEK_COMPANION_CONNECTION_TYPE }),
        });
        const summary = summarizeZeppFetchResponse(response);
        if (!summary.ok) {
          throw new Error(summary.errorMessage ?? "Dofek pairing failed.");
        }
        if (!isRecord(summary.body)) {
          throw new Error("Dofek pairing response was invalid.");
        }
        if (!connectionOperations.isCurrent(operation)) {
          return null;
        }
        const pairingInfo = this.savePairingInfo(summary.body);
        this.schedulePairingPoll(pairingInfo.pairingId, serverUrl, operation);
        return pairingInfo;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Dofek pairing failed.";
        if (connectionOperations.isCurrent(operation)) {
          this.setConnectionStatus({ state: "error", reason: message });
        }
        throw error;
      }
    },

    schedulePairingPoll(pairingId: string, serverUrl: string, operation: number) {
      setTimeout(() => {
        this.pollPairing(pairingId, serverUrl, operation).catch((error: unknown) => {
          reportSideException(error, { category: "pairing-poll" });
        });
      }, 3000);
    },

    async pollPairing(pairingId: string, serverUrl: string, operation: number) {
      if (!connectionOperations.isCurrent(operation) || !this.isCurrentPairing(pairingId)) {
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
        reportSideException(error, { category: "pairing-poll-request" });
        if (connectionOperations.isCurrent(operation)) {
          this.schedulePairingPoll(pairingId, serverUrl, operation);
        }
        return;
      }
      const summary = summarizeZeppFetchResponse(response);
      if (!summary.ok) {
        if (shouldRetryPairingPollFailure(summary)) {
          reportSideException(new Error(summary.errorMessage ?? "pairing poll transient failure"), {
            category: "pairing-poll-transient",
          });
          this.schedulePairingPoll(pairingId, serverUrl, operation);
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
      if (!connectionOperations.isCurrent(operation) || !this.isCurrentPairing(pairingId)) {
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
        this.setConnectionStatus({
          state: "connected",
          connectionType: DOFEK_COMPANION_CONNECTION_TYPE,
        });
        this.requestHealthCatchup("pairing-claimed");
        return;
      }

      if (state === "pending") {
        this.setConnectionStatus({
          state: "pairing",
          shortCode: settings.settingsStorage.getItem(STORAGE_KEYS.PAIRING_SHORT_CODE),
        });
        this.schedulePairingPoll(pairingId, serverUrl, operation);
        return;
      }

      this.setConnectionStatus({ state: "error", reason: "Pairing code expired." });
    },

    async loginWithPassword(rawPayload: string) {
      if (settings.settingsStorage.getItem(STORAGE_KEYS.DOFEK_API_TOKEN)?.trim()) {
        throw new Error("Disconnect the existing Dofek connection before logging in again.");
      }
      const operation = connectionOperations.begin();
      const payload = readJson(rawPayload, {});
      const serverUrl = getStoredServerUrl();
      const email = getString(payload, "email");
      const password = getRawString(payload, "password");
      settings.settingsStorage.removeItem(STORAGE_KEYS.CMD_LOGIN_PASSWORD);

      try {
        if (!serverUrl || !email || !password) {
          throw new Error("Server URL, email, and password are required.");
        }

        this.setConnectionStatus({ state: "checking" });
        const response = await fetch({
          url: `${serverUrl.replace(/\/$/, "")}/api/companion-token/password-login`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            password,
            connectionType: DOFEK_COMPANION_CONNECTION_TYPE,
          }),
        });
        const summary = summarizeZeppFetchResponse(response);
        if (!summary.ok) {
          throw new Error(summary.errorMessage ?? "Dofek login failed.");
        }

        if (!isRecord(summary.body) || typeof summary.body.token !== "string") {
          throw new Error("Dofek login did not return connection credentials.");
        }
        if (!connectionOperations.isCurrent(operation)) {
          return;
        }

        settings.settingsStorage.setItem(STORAGE_KEYS.DOFEK_EMAIL, email);
        settings.settingsStorage.setItem(STORAGE_KEYS.DOFEK_API_TOKEN, summary.body.token);
        this.clearPairingInfo();
        this.setConnectionStatus({
          state: "connected",
          connectionType: DOFEK_COMPANION_CONNECTION_TYPE,
        });
        this.requestHealthCatchup("password-login");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Dofek login failed.";
        if (connectionOperations.isCurrent(operation)) {
          this.setConnectionStatus({ state: "error", reason: message });
        }
        throw error;
      }
    },

    async verifyConnection() {
      const operation = connectionOperations.begin();
      const serverUrl = getStoredServerUrl();
      const apiToken = settings.settingsStorage.getItem(STORAGE_KEYS.DOFEK_API_TOKEN)?.trim();
      if (!apiToken) {
        this.setConnectionStatus({ state: "disconnected" });
        return;
      }

      this.setConnectionStatus({ state: "checking" });
      try {
        const response = await fetch({
          url: `${serverUrl.replace(/\/$/, "")}/api/companion-token/current`,
          method: "GET",
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        const summary = summarizeZeppFetchResponse(response);
        if (!connectionOperations.isCurrent(operation)) {
          return;
        }
        if (!summary.ok) {
          if (summary.status === 401) {
            settings.settingsStorage.removeItem(STORAGE_KEYS.DOFEK_API_TOKEN);
          }
          throw new Error(summary.errorMessage ?? "Dofek connection check failed.");
        }
        if (!isRecord(summary.body) || getString(summary.body, "state") !== "connected") {
          throw new Error("Dofek returned an invalid connection status.");
        }
        if (getString(summary.body, "connectionType") !== DOFEK_COMPANION_CONNECTION_TYPE) {
          settings.settingsStorage.removeItem(STORAGE_KEYS.DOFEK_API_TOKEN);
          throw new Error("Saved credentials belong to a different Zepp app. Connect again.");
        }
        this.setConnectionStatus({
          state: "connected",
          connectionType: DOFEK_COMPANION_CONNECTION_TYPE,
        });
        this.requestHealthCatchup("connection-verified");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Dofek connection check failed.";
        if (connectionOperations.isCurrent(operation)) {
          this.setConnectionStatus({ state: "error", reason: message });
        }
        throw error;
      }
    },

    async disconnect() {
      const operation = connectionOperations.begin();
      const serverUrl = getStoredServerUrl();
      const apiToken = settings.settingsStorage.getItem(STORAGE_KEYS.DOFEK_API_TOKEN)?.trim();
      if (!apiToken) {
        this.clearPairingInfo();
        this.setConnectionStatus({ state: "disconnected" });
        return;
      }

      this.setConnectionStatus({ state: "disconnecting" });
      try {
        const response = await fetch({
          url: `${serverUrl.replace(/\/$/, "")}/api/companion-token/current`,
          method: "DELETE",
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        const summary = summarizeZeppFetchResponse(response);
        if (!connectionOperations.isCurrent(operation)) {
          return;
        }
        if (!summary.ok && summary.status !== 401) {
          throw new Error(summary.errorMessage ?? "Failed to disconnect Dofek.");
        }
        settings.settingsStorage.removeItem(STORAGE_KEYS.DOFEK_API_TOKEN);
        this.clearPairingInfo();
        this.setConnectionStatus({ state: "disconnected" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to disconnect Dofek.";
        if (connectionOperations.isCurrent(operation)) {
          this.setConnectionStatus({ state: "error", reason: message });
        }
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
          .then((pairingInfo) => res(null, pairingInfo))
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

      if (method === "dofek.disconnect") {
        this.disconnect()
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

      if (method === "telemetry.report") {
        const errorMessage = typeof params.message === "string" ? params.message : "unknown error";
        const errorName = typeof params.name === "string" ? params.name : "Error";
        const stack = typeof params.stack === "string" ? params.stack : undefined;
        const error = new Error(errorMessage);
        error.name = errorName;
        if (stack) {
          error.stack = stack;
        }
        reportSideException(error, {
          category: typeof params.category === "string" ? params.category : "zepp-watch",
        });
        res(null, { ok: true });
        return;
      }

      if (method === "health.upload") {
        try {
          const envelope = parseHealthEnvelope(params.envelope);
          const persisted = persistHealthEnvelope(settings.settingsStorage, envelope);
          res(null, { status: "ok", ...persisted, rejected: [] });
          void healthSyncCoordinator.requestDrain("watch-receipt");
        } catch (error) {
          reportSideException(error, { category: "health-receipt" });
          res(error, null);
        }
        return;
      }

      res(null, { ok: false, message: "unknown method" });
    },
  }),
);
