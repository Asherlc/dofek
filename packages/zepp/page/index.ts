import { pagePlugin } from "@zeppos/zml/3.0/module/messaging/plugin/page";
import { BasePage } from "@zeppos/zml/base-page";
import { queryPermission, requestPermission } from "@zos/app";
import * as appService from "@zos/app-service";
import { getDeviceInfo, SCREEN_SHAPE_ROUND } from "@zos/device";
import {
  pauseDropWristScreenOff,
  resetDropWristScreenOff,
  resetPageBrightTime,
  setPageBrightTime,
} from "@zos/display";
import { showToast } from "@zos/interaction";
import {
  Accelerometer,
  BloodOxygen,
  BodyTemperature,
  checkSensor,
  Distance,
  FatBurning,
  Gyroscope,
  HeartRate,
  Pai,
  Sleep,
  Stand,
  Step,
  Stress,
  Workout,
} from "@zos/sensor";
import {
  align,
  createKeyboard,
  createWidget,
  deleteWidget,
  inputType,
  prop,
  text_style,
  widget,
} from "@zos/ui";
import { log as Logger, px } from "@zos/utils";
import { captureException, ensureWatchInstallId } from "../app-service/telemetry.ts";
import { appendWatchHealthSummary } from "../src/background-health.ts";
import {
  readBackgroundHealthOutbox,
  writeBackgroundHealthOutbox,
} from "../src/background-health-storage.ts";
import { isConnectionChangedCall } from "../src/connection-control.ts";
import { createDisplayLease } from "../src/display-lease.ts";
import { collectHealthData } from "../src/health-collector.ts";
import {
  acquireForegroundHealthOwnership,
  type ForegroundHealthOwnership,
} from "../src/health-service-control.ts";
import { createImuCollector, FREQ_MODES } from "../src/imu-collector.ts";
import {
  createImuSessionController,
  type ImuSessionController,
} from "../src/imu-session-controller.ts";
import {
  type ImuFileSlot,
  type PendingImuTransfer,
  persistAndApplyPendingImuTransfer,
  readPendingImuTransfers,
} from "../src/imu-transfer-storage.ts";
import { createRoundLoginLayout } from "../src/round-layout.ts";
import {
  confirmImuTransferPersistence,
  createSessionCall,
  drainManualExportQueue,
  getImuTransferFailureReason,
  getSessionAction,
  handleSessionCall,
  SESSION_STATE,
  type SessionState,
} from "../src/session-control.ts";
import {
  appendSamples,
  finalizeSessionFile,
  resetSessionFile,
  writeSessionMetaFile,
} from "../src/session-file.ts";
import { createSessionProgressHandler, type SessionProgress } from "../src/session-progress.ts";
import {
  AUTO_TRANSFER_SAMPLE_COUNT,
  FLUSH_SAMPLE_THRESHOLD,
  HEALTH_SERVICE_FILE,
  NORMAL_IMU_CHUNK_DIRECTORY,
  NORMAL_IMU_TRANSFER_FILE,
  SESSION_FILE_A,
  SESSION_FILE_B,
  SESSION_META_FILE,
  STORAGE_KEYS,
} from "../src/storage-keys.ts";
import { deliverWatchHealthOutbox } from "../src/watch-health-sync.ts";
import { createWatchImuChunkSync, type WatchImuChunkSync } from "../src/watch-imu-chunk-sync.ts";

type TransferTask = {
  on: (event: string, cb: (event: { data: Record<string, unknown> }) => void) => void;
};

function nullable<T>(): T | null {
  return null;
}
function initialActiveFile(): ImuFileSlot {
  return "A";
}

BasePage.use(pagePlugin);

const logger = Logger.getLogger("imu-page");
const { width: DEVICE_WIDTH, screenShape } = getDeviceInfo();
const BG_PERMISSION = "device:os.bg_service";
const IS_COMPACT_SQUARE_DISPLAY = DEVICE_WIDTH <= 320;
const CONTENT_INSET = px(IS_COMPACT_SQUARE_DISPLAY ? 20 : 40);
const CONTENT_WIDTH = DEVICE_WIDTH - CONTENT_INSET * 2;
const ROUND_LOGIN_LAYOUT =
  screenShape === SCREEN_SHAPE_ROUND ? createRoundLoginLayout(px, DEVICE_WIDTH) : null;
const TITLE_Y = px(IS_COMPACT_SQUARE_DISPLAY ? 24 : 36);
const TITLE_HEIGHT = px(IS_COMPACT_SQUARE_DISPLAY ? 44 : 52);
const TITLE_TEXT_SIZE = px(IS_COMPACT_SQUARE_DISPLAY ? 32 : 40);
const STATUS_Y = px(IS_COMPACT_SQUARE_DISPLAY ? 86 : 106);
const STATUS_HEIGHT = px(IS_COMPACT_SQUARE_DISPLAY ? 64 : 48);
const STATUS_TEXT_SIZE = px(IS_COMPACT_SQUARE_DISPLAY ? 22 : 32);
const SENSOR_INFO_Y = px(IS_COMPACT_SQUARE_DISPLAY ? 156 : 162);
const SENSOR_INFO_HEIGHT = px(IS_COMPACT_SQUARE_DISPLAY ? 40 : 36);
const SENSOR_INFO_TEXT_SIZE = px(IS_COMPACT_SQUARE_DISPLAY ? 18 : 20);
const SAMPLE_Y = px(IS_COMPACT_SQUARE_DISPLAY ? 208 : 214);
const SAMPLE_HEIGHT = px(IS_COMPACT_SQUARE_DISPLAY ? 72 : 80);
const SAMPLE_TEXT_SIZE = px(IS_COMPACT_SQUARE_DISPLAY ? 22 : 24);
const HINT_X = ROUND_LOGIN_LAYOUT?.hint.x ?? CONTENT_INSET;
const HINT_Y = ROUND_LOGIN_LAYOUT?.hint.y ?? px(IS_COMPACT_SQUARE_DISPLAY ? 294 : 310);
const HINT_WIDTH = ROUND_LOGIN_LAYOUT?.hint.w ?? CONTENT_WIDTH;
const HINT_HEIGHT = ROUND_LOGIN_LAYOUT?.hint.h ?? px(IS_COMPACT_SQUARE_DISPLAY ? 56 : 72);
const HINT_TEXT_SIZE = px(IS_COMPACT_SQUARE_DISPLAY ? 18 : 20);
const LOGIN_BUTTON_LAYOUT = ROUND_LOGIN_LAYOUT?.button ?? {
  x: px(40),
  y: DEVICE_WIDTH <= 360 ? px(338) : px(438),
  w: DEVICE_WIDTH - px(80),
  h: px(44),
  radius: px(10),
};

let sessionControlButton: ReturnType<typeof createWidget> | null = null;
let connectionButton: ReturnType<typeof createWidget> | null = null;
let sensorInfoText: ReturnType<typeof createWidget> | null = null;
let sampleText: ReturnType<typeof createWidget> | null = null;
let hintText: ReturnType<typeof createWidget> | null = null;
let pairingQrContent: string | null = null;
let pairingQrWidget: ReturnType<typeof createWidget> | null = null;

function renderSessionControl(state: SessionState) {
  if (sessionControlButton) {
    sessionControlButton.setProperty(prop.TEXT, getSessionAction(state).label);
  }
}

function renderSensorInfo(text: string) {
  if (sensorInfoText) {
    sensorInfoText.setProperty(prop.TEXT, text);
  }
}

function renderSamples(text: string) {
  if (sampleText) {
    sampleText.setProperty(prop.TEXT, text);
  }
}

function renderHint(text: string) {
  if (hintText) {
    hintText.setProperty(prop.TEXT, text);
  }
}

function resetPairingQrReference() {
  pairingQrContent = null;
  pairingQrWidget = null;
}

function clearPairingQrWidget() {
  if (pairingQrWidget) {
    deleteWidget(pairingQrWidget);
  }
  resetPairingQrReference();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  return typeof raw === "string" ? raw.trim() : "";
}

Page(
  BasePage({
    state: {
      logging: false,
      freqModeIndex: 1,
      imuController: nullable<ImuSessionController>(),
      hasGyro: false,
      transferTask: nullable<TransferTask>(),
      pendingImuA: nullable<PendingImuTransfer>(),
      pendingImuB: nullable<PendingImuTransfer>(),
      pendingManualExport: false,
      sampleCount: 0,
      observedHzX100: 0,
      activeFile: initialActiveFile(),
      hasCredentials: false,
      canStartConnection: true,
      healthSyncTask: nullable<Promise<void>>(),
      healthOwnership: nullable<Promise<ForegroundHealthOwnership>>(),
      imuChunkSync: nullable<WatchImuChunkSync>(),
      dofekEmail: "",
      pairingVerificationUrl: "",
      pairingShortCode: "",
      preferencesRequestId: 0,
    },

    onInit() {
      resetPairingQrReference();
      this.state.imuChunkSync = createWatchImuChunkSync(NORMAL_IMU_CHUNK_DIRECTORY, (envelope) =>
        this.request({ method: "imu.uploadChunk", params: { envelope } }),
      );
      void this.state.imuChunkSync.retry().catch((error: unknown) => {
        captureException(error, { operation: "retry-imu-chunks" });
        logger.error("IMU chunk retry failed %j", error);
        renderHint("Motion sync pending\nWill retry automatically");
      });
      this.restorePendingImuTransfers();
      this.acquireHealthOwnership();
      this.refreshPreferences({ startPairingIfNeeded: true });
      this.retryPendingImuTransfer();
    },

    build() {
      resetPairingQrReference();
      createWidget(widget.TEXT, {
        x: px(0),
        y: TITLE_Y,
        w: DEVICE_WIDTH,
        h: TITLE_HEIGHT,
        color: 0xffffff,
        text_size: TITLE_TEXT_SIZE,
        align_h: align.CENTER_H,
        text_style: text_style.NONE,
        text: "Dofek",
      });

      sessionControlButton = createWidget(widget.BUTTON, {
        x: CONTENT_INSET,
        y: STATUS_Y,
        w: CONTENT_WIDTH,
        h: STATUS_HEIGHT,
        color: 0xffffff,
        text_size: STATUS_TEXT_SIZE,
        normal_color: 0x1976d2,
        press_color: 0x64a8f0,
        radius: px(10),
        text: getSessionAction(SESSION_STATE.IDLE).label,
        click_func: () => {
          const action = getSessionAction(
            this.state.logging ? SESSION_STATE.RECORDING : SESSION_STATE.IDLE,
          );
          this.onCall(
            createSessionCall(action.command, {
              freqModeIndex: this.state.freqModeIndex,
            }),
          );
        },
      });

      sensorInfoText = createWidget(widget.TEXT, {
        x: CONTENT_INSET,
        y: SENSOR_INFO_Y,
        w: CONTENT_WIDTH,
        h: SENSOR_INFO_HEIGHT,
        color: 0x888888,
        text_size: SENSOR_INFO_TEXT_SIZE,
        align_h: align.CENTER_H,
        text_style: IS_COMPACT_SQUARE_DISPLAY ? text_style.WRAP : text_style.NONE,
        text: "",
      });

      sampleText = createWidget(widget.TEXT, {
        x: CONTENT_INSET,
        y: SAMPLE_Y,
        w: CONTENT_WIDTH,
        h: SAMPLE_HEIGHT,
        color: 0x7fb3d3,
        text_size: SAMPLE_TEXT_SIZE,
        align_h: align.CENTER_H,
        text_style: text_style.WRAP,
        text: "0 samples\n— Hz",
      });

      hintText = createWidget(widget.TEXT, {
        x: HINT_X,
        y: HINT_Y,
        w: HINT_WIDTH,
        h: HINT_HEIGHT,
        color: 0xe67e22,
        text_size: HINT_TEXT_SIZE,
        align_h: align.CENTER_H,
        text_style: text_style.WRAP,
        text: "",
      });

      connectionButton = createWidget(widget.BUTTON, {
        ...LOGIN_BUTTON_LAYOUT,
        text: "Login on watch",
        color: 0xffffff,
        text_size: px(22),
        normal_color: 0x1976d2,
        press_color: 0x64a8f0,
        click_func: () => {
          if (this.state.hasCredentials) {
            this.disconnectFromWatch();
          } else {
            this.loginFromWatch();
          }
        },
      });
    },

    refreshPreferences({ startPairingIfNeeded = true }: { startPairingIfNeeded?: boolean } = {}) {
      const requestId = this.state.preferencesRequestId + 1;
      this.state.preferencesRequestId = requestId;
      this.request({
        method: "imu.getPreferences",
        params: {},
      })
        .then((result) => {
          if (requestId !== this.state.preferencesRequestId) return;
          if (!this.state.logging) {
            this.state.freqModeIndex = Number(result?.freqModeIndex ?? 1);
          }
          this.state.hasCredentials = result?.hasCredentials === true;
          this.state.canStartConnection = result?.canStartConnection === true;
          connectionButton?.setProperty(
            prop.TEXT,
            this.state.hasCredentials ? "Disconnect Dofek" : "Login on watch",
          );
          const pairing = isRecord(result?.pairing) ? result.pairing : null;
          this.renderPairing(pairing);
          if (
            startPairingIfNeeded &&
            !this.state.hasCredentials &&
            !pairing &&
            this.state.canStartConnection
          ) {
            this.startPairingFromWatch();
          }
          this.publishSessionStatus(
            this.state.logging ? SESSION_STATE.RECORDING : SESSION_STATE.IDLE,
          );
        })
        .catch((error) => {
          if (requestId !== this.state.preferencesRequestId) return;
          captureException(error, { operation: "fetch-preferences" });
          logger.error("preference fetch failed %j", error);
          renderHint("Preferences unavailable\nOpen Zepp settings");
        });
    },

    acquireHealthOwnership() {
      const ownership = acquireForegroundHealthOwnership({
        queryPermission: () => queryPermission({ permissions: [BG_PERMISSION] })[0],
        requestPermission: () =>
          new Promise((resolve) => {
            requestPermission({
              permissions: [BG_PERMISSION],
              callback: ([result]) => resolve(result),
            });
          }),
        stopService: () =>
          new Promise((resolve, reject) => {
            const result = appService.stop({
              file: HEALTH_SERVICE_FILE,
              complete_func: (info) => {
                logger.log("health service stop %j", info);
                if (info.result) resolve();
                else reject(new Error("Health service did not stop."));
              },
            });
            if (result === 2) resolve();
            else if (result !== 0) reject(new Error(`Health service stop failed (${result}).`));
          }),
        startService: () =>
          new Promise<void>((resolve, reject) => {
            const reportStartFailure = (error: Error) => {
              captureException(error, { operation: "restart-health-service" });
              settings.settingsStorage.setItem(
                STORAGE_KEYS.HEALTH_SERVICE_STATUS,
                JSON.stringify({ state: "error", reason: error.message }),
              );
              reject(error);
            };
            settings.settingsStorage.setItem(
              STORAGE_KEYS.HEALTH_SERVICE_STATUS,
              JSON.stringify({ state: "starting" }),
            );
            let result: number | undefined;
            try {
              result = appService.start({
                file: HEALTH_SERVICE_FILE,
                param: "action=start",
                reload: true,
                complete_func: (info) => {
                  logger.log("health service start %j", info);
                  if (!info.result) {
                    reportStartFailure(new Error("Health service did not start."));
                    return;
                  }
                  settings.settingsStorage.setItem(
                    STORAGE_KEYS.HEALTH_SERVICE_STATUS,
                    JSON.stringify({ state: "running" }),
                  );
                  resolve();
                },
              });
            } catch (error) {
              reportStartFailure(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            if (result === 2) {
              settings.settingsStorage.setItem(
                STORAGE_KEYS.HEALTH_SERVICE_STATUS,
                JSON.stringify({ state: "running" }),
              );
              resolve();
            } else if (result !== 0) {
              reportStartFailure(new Error(`Health service start failed (${result}).`));
            }
          }),
      });
      this.state.healthOwnership = ownership;
      ownership
        .then((result) => {
          if (result.state === "permission-denied") {
            showToast({ content: result.reason ?? "Background Service permission denied." });
            renderHint("Enable Background Service\nfor health collection");
          }
          void this.collectAndDeliverHealth();
        })
        .catch((error: unknown) => {
          captureException(error, { operation: "acquire-health-outbox" });
          logger.error("health ownership failed %j", error);
          showToast({ content: "Health sync could not start safely" });
        });
    },

    filePathForSlot(slot: ImuFileSlot) {
      return slot === "A" ? SESSION_FILE_A : SESSION_FILE_B;
    },

    pendingImu(slot: ImuFileSlot) {
      return slot === "A" ? this.state.pendingImuA : this.state.pendingImuB;
    },

    setPendingImu(slot: ImuFileSlot, transfer: PendingImuTransfer | null) {
      persistAndApplyPendingImuTransfer(NORMAL_IMU_TRANSFER_FILE, slot, transfer, (persisted) => {
        if (slot === "A") this.state.pendingImuA = persisted;
        else this.state.pendingImuB = persisted;
      });
    },

    restorePendingImuTransfers() {
      try {
        for (const transfer of readPendingImuTransfers(NORMAL_IMU_TRANSFER_FILE)) {
          if (transfer.slot === "A") this.state.pendingImuA = transfer;
          else this.state.pendingImuB = transfer;
        }
      } catch (error) {
        captureException(error, { operation: "restore-imu-transfers" });
        logger.error("IMU transfer restore failed %j", error);
      }
    },

    retryPendingImuTransfer() {
      if (this.state.transferTask) return;
      const pending = this.state.pendingImuA ?? this.state.pendingImuB;
      if (pending) this.startTransfer(pending);
    },

    inactiveFileSlot() {
      return this.state.activeFile === "A" ? "B" : "A";
    },

    activeFilePath() {
      return this.filePathForSlot(this.state.activeFile);
    },

    startLogging() {
      if (this.state.logging) {
        return;
      }

      const availableSlot: ImuFileSlot | null = !this.state.pendingImuA
        ? "A"
        : !this.state.pendingImuB
          ? "B"
          : null;
      if (!availableSlot) {
        showToast({ content: "Motion files are waiting to send" });
        renderHint("Send pending motion files\nbefore recording");
        return;
      }
      this.state.activeFile = availableSlot;
      const controller = createImuSessionController({
        path: this.activeFilePath(),
        requestedFreqModeIndex: this.state.freqModeIndex,
        flushThreshold: FLUSH_SAMPLE_THRESHOLD,
        now: Date.now,
        displayLease: createDisplayLease({
          pauseDropWristScreenOff,
          resetDropWristScreenOff,
          setPageBrightTime,
          resetPageBrightTime,
        }),
        createCollector: (options) =>
          createImuCollector(options, { Accelerometer, Gyroscope, checkSensor }),
        file: {
          reset: resetSessionFile,
          append: appendSamples,
          finalize: finalizeSessionFile,
        },
        onChunk: ({ sessionStartMs, hasGyroscope, samples }) => {
          const installId = ensureWatchInstallId();
          const segmentId = `${installId}:normal-imu:${sessionStartMs}`;
          const sync = this.state.imuChunkSync;
          if (!sync) throw new Error("IMU chunk sync is unavailable.");
          void sync
            .enqueue({
              connectionType: "zepp",
              installId,
              segmentId,
              sessionStartMs,
              hasGyroscope,
              samples,
            })
            .catch((error: unknown) => {
              captureException(error, { operation: "upload-imu-chunk", segmentId });
              logger.error("IMU chunk delivery failed %j", error);
              renderHint("Motion sync pending\nWill retry automatically");
            });
        },
        onProgress: createSessionProgressHandler({
          updateWatch: (stats) => this.handleRate(stats),
          publishHostStatus: (stats) => this.publishSessionStatus(SESSION_STATE.RECORDING, stats),
        }),
        onError: (error) => {
          captureException(error, { operation: "foreground-imu-session" });
          logger.error("foreground IMU session failed %j", error);
          this.state.logging = false;
          this.state.imuController = null;
          renderSessionControl(SESSION_STATE.IDLE);
          renderHint("Recorder stopped\nOpen Zepp settings for details");
        },
      });

      if (!controller.available) {
        const reason = controller.reason ?? "IMU sensors are unavailable.";
        showToast({ content: reason });
        renderHint(reason);
        return;
      }

      this.state.imuController = controller;
      this.state.hasGyro = controller.hasGyroscope;
      this.state.sampleCount = 0;
      this.state.observedHzX100 = 0;
      if (!controller.start()) {
        this.state.imuController = null;
        return;
      }
      this.state.logging = true;

      const modeLabel =
        FREQ_MODES.find((item) => item.value === controller.accelFreqMode)?.label ?? "?";
      renderSensorInfo(
        controller.hasGyroscope ? `Accel · Gyro · ${modeLabel}` : `Accel · ${modeLabel}`,
      );
      renderHint("Foreground recorder\nKeep this screen open");
      renderSessionControl(SESSION_STATE.RECORDING);

      this.publishSessionStatus(SESSION_STATE.RECORDING);
    },

    renderPairing(pairing: Record<string, unknown> | null) {
      if (!pairing || this.state.hasCredentials) {
        clearPairingQrWidget();
        return;
      }

      const verificationUrl = getString(pairing, "verificationUrl");
      const shortCode = getString(pairing, "shortCode");
      if (!verificationUrl || !shortCode) {
        return;
      }

      this.state.pairingVerificationUrl = verificationUrl;
      this.state.pairingShortCode = shortCode;
      renderSamples("");
      renderHint(`Code ${shortCode}\nScan QR`);

      if (pairingQrContent === verificationUrl && pairingQrWidget) {
        return;
      }

      clearPairingQrWidget();
      pairingQrContent = verificationUrl;
      const qrSize = DEVICE_WIDTH <= 360 ? px(84) : px(96);
      const qrY = DEVICE_WIDTH <= 360 ? px(218) : px(206);
      pairingQrWidget = createWidget(widget.QRCODE, {
        content: verificationUrl,
        x: Math.floor((DEVICE_WIDTH - qrSize) / 2),
        y: qrY,
        w: qrSize,
        h: qrSize,
        bg_x: Math.floor((DEVICE_WIDTH - qrSize - px(10)) / 2),
        bg_y: qrY - px(5),
        bg_w: qrSize + px(10),
        bg_h: qrSize + px(10),
      });
    },

    startPairingFromWatch() {
      this.request({
        method: "dofek.startPairing",
        params: {},
      })
        .then((result) => {
          this.renderPairing(isRecord(result) ? result : null);
        })
        .catch((error: unknown) => {
          captureException(error, { operation: "start-watch-pairing" });
          logger.error("watch pairing start failed %j", error);
          renderHint("Pairing failed\nOpen Zepp settings");
        });
    },

    openKeyboard(options: { initialText: string; onComplete: (value: string) => void }) {
      try {
        createKeyboard({
          inputType: inputType.CHAR,
          text: options.initialText,
          onComplete: (_keyboardWidget: unknown, result: string) => {
            options.onComplete(result);
          },
          onCancel: () => undefined,
        });
      } catch (error) {
        captureException(error, { operation: "open-watch-keyboard" });
        logger.error("keyboard open failed %j", error);
        showToast({ content: "Keyboard requires Zepp OS 4" });
      }
    },

    loginFromWatch() {
      this.openKeyboard({
        initialText: this.state.dofekEmail,
        onComplete: (email: string) => {
          this.state.dofekEmail = email;
          this.openKeyboard({
            initialText: "",
            onComplete: (password: string) => {
              this.request({
                method: "dofek.loginWithPassword",
                params: { email: this.state.dofekEmail, password },
              })
                .then(() => {
                  this.state.hasCredentials = true;
                  connectionButton?.setProperty(prop.TEXT, "Disconnect Dofek");
                  clearPairingQrWidget();
                  renderHint("Connected");
                })
                .catch((error: unknown) => {
                  captureException(error, { operation: "watch-password-login" });
                  logger.error("watch login failed %j", error);
                  renderHint("Login failed\nCheck password");
                });
            },
          });
        },
      });
    },

    disconnectFromWatch() {
      this.request({
        method: "dofek.disconnect",
        params: {},
      })
        .then(() => {
          this.state.hasCredentials = false;
          connectionButton?.setProperty(prop.TEXT, "Login on watch");
          clearPairingQrWidget();
          renderHint("Not connected\nCreate code in Zepp settings");
        })
        .catch((error: unknown) => {
          captureException(error, { operation: "watch-disconnect" });
          logger.error("watch disconnect failed %j", error);
          renderHint("Disconnect failed\nOpen Zepp settings");
        });
    },

    handleRate(stats: { sampleCount: number; observedHzX100: number }) {
      this.state.sampleCount = stats.sampleCount;
      this.state.observedHzX100 = stats.observedHzX100;
      renderSamples(
        `${stats.sampleCount} samples\n` + `${(stats.observedHzX100 / 100).toFixed(2)} Hz`,
      );
      this.writeMetaFile();
      if (stats.sampleCount >= AUTO_TRANSFER_SAMPLE_COUNT && !this.state.transferTask) {
        this.swapAndTransfer();
      }
    },

    stopLogging() {
      if (!this.state.logging) {
        return;
      }

      this.state.logging = false;
      const completed = this.state.imuController?.stop();
      if (completed) {
        this.state.sampleCount = completed.sampleCount;
        this.state.observedHzX100 = completed.observedHzX100;
        this.setPendingImu(this.state.activeFile, {
          ...completed,
          slot: this.state.activeFile,
        });
      }
      this.state.imuController = null;
      this.writeMetaFile();
      renderSessionControl(SESSION_STATE.IDLE);
      renderSensorInfo("Session finalized");
      renderSamples(
        `${this.state.sampleCount} samples\n` +
          `${(this.state.observedHzX100 / 100).toFixed(2)} Hz`,
      );
      this.publishSessionStatus(SESSION_STATE.IDLE);
    },

    swapAndTransfer() {
      if (this.state.transferTask) {
        return;
      }

      if (!this.state.logging) {
        this.transferStoppedSession();
        return;
      }

      const outgoingSlot = this.state.activeFile;
      const outgoingPath = this.filePathForSlot(outgoingSlot);
      const nextSlot = this.inactiveFileSlot();

      if (this.pendingImu(nextSlot)) {
        showToast({ content: "Send failed; recording stopped" });
        this.stopLogging();
        return;
      }

      const completed = this.state.imuController?.rotate(this.filePathForSlot(nextSlot));
      if (!completed) {
        this.state.logging = false;
        renderSessionControl(SESSION_STATE.IDLE);
        return;
      }

      this.state.activeFile = nextSlot;
      this.state.sampleCount = 0;
      this.state.observedHzX100 = 0;

      this.publishSessionStatus(SESSION_STATE.RECORDING);
      this.writeMetaFile();

      const transfer = { ...completed, path: outgoingPath, slot: outgoingSlot };
      this.setPendingImu(outgoingSlot, transfer);
      this.startTransfer(transfer);
    },

    transferStoppedSession() {
      if (this.state.transferTask) {
        return;
      }

      this.retryPendingImuTransfer();
    },

    handleImuTransferFailure(transfer: PendingImuTransfer, cause: unknown) {
      this.state.transferTask = null;
      const reason = cause instanceof Error ? cause.message : String(cause);
      const segmentId = `${ensureWatchInstallId()}:normal-imu:${transfer.sessionStartMs}`;
      const error = cause instanceof Error ? cause : new Error(reason);
      captureException(error, { operation: "transfer-imu-file", segmentId, source: "zepp" });
      logger.error("IMU file transfer failed %j", error);
      showToast({ content: reason });
      renderHint("Motion file pending\nRetry from Zepp settings");
      this.request({
        method: "imu.transferFailed",
        params: { reason, segmentId, source: "zepp" },
      }).catch((requestError: unknown) => {
        captureException(requestError, { operation: "report-transfer-failure", segmentId });
        logger.error("imu.transferFailed failed %j", requestError);
      });
    },

    startTransfer(transfer: PendingImuTransfer) {
      const { path, sampleCount, observedHzX100, slot } = transfer;
      const segmentId = `${ensureWatchInstallId()}:normal-imu:${transfer.sessionStartMs}`;
      let task: TransferTask;
      try {
        task = this.sendFile(path, {
          type: "imu-session",
          source: "zepp",
          segmentId,
          sampleCount: String(sampleCount),
          observedHzX100: String(observedHzX100),
        });
      } catch (error) {
        this.handleImuTransferFailure(transfer, error);
        return;
      }

      this.state.transferTask = task;

      task.on("progress", (event: { data: Record<string, unknown> }) => {
        const loadedSize = Number(event.data.loadedSize);
        const fileSize = Number(event.data.fileSize);
        const pct = fileSize > 0 ? Math.floor((loadedSize * 100) / fileSize) : 0;
        logger.log("transfer %d%%", pct);
      });

      task.on("change", (event: { data: Record<string, unknown> }) => {
        if (String(event.data.readyState) === "transferred") {
          void confirmImuTransferPersistence(
            { sampleCount, segmentId, source: "zepp" },
            (payload) => this.request(payload),
          )
            .then(() => {
              this.setPendingImu(slot, null);
              this.state.transferTask = null;
              this.retryPendingImuTransfer();
              drainManualExportQueue(
                {
                  pendingManualExport: this.state.pendingManualExport,
                  logging: this.state.logging,
                  failedTransferPending: Boolean(this.state.pendingImuA || this.state.pendingImuB),
                },
                {
                  clearManualExportQueue: () => {
                    this.state.pendingManualExport = false;
                  },
                  transferStoppedSession: () => this.transferStoppedSession(),
                },
              );
            })
            .catch((error: unknown) => {
              this.state.transferTask = null;
              captureException(error, { operation: "confirm-transfer-persistence", segmentId });
              logger.error("imu.transferComplete failed %j", error);
              showToast({ content: "Motion file is still pending" });
              renderHint("Motion file pending\nRetry from Zepp settings");
            });
          return;
        }

        const failureReason = getImuTransferFailureReason(event.data, "IMU file transfer failed.");
        if (failureReason) this.handleImuTransferFailure(transfer, new Error(failureReason));
      });
    },

    writeMetaFile() {
      writeSessionMetaFile(
        {
          sampleCount: this.state.sampleCount,
          observedHzX100: this.state.observedHzX100,
          hasGyro: this.state.hasGyro,
          updatedAt: Date.now(),
        },
        SESSION_META_FILE,
      );
    },

    publishSessionStatus(state: SessionState, progress?: SessionProgress) {
      this.request({
        method: "imu.publishStatus",
        params: {
          state,
          freqModeIndex: this.state.freqModeIndex,
          sampleCount: progress?.sampleCount ?? this.state.sampleCount,
          observedHzX100: progress?.observedHzX100 ?? this.state.observedHzX100,
          hasGyro: this.state.hasGyro,
          sessionFile: this.activeFilePath(),
        },
      }).catch((error) => {
        captureException(error, { operation: "publish-session-status" });
        logger.error("status publish failed %j", error);
      });
    },

    collectAndDeliverHealth() {
      if (this.state.healthSyncTask) return this.state.healthSyncTask;
      const task = (async () => {
        try {
          await this.state.healthOwnership;
          const watchSummary = collectHealthData(
            {
              HeartRate,
              Step,
              Distance,
              Sleep,
              BloodOxygen,
              BodyTemperature,
              Stress,
              Stand,
              Pai,
              FatBurning,
              Workout,
            },
            captureException,
          );
          const installId = ensureWatchInstallId();
          const currentOutbox = readBackgroundHealthOutbox(installId);
          const updatedOutbox = appendWatchHealthSummary(currentOutbox, watchSummary, installId);
          writeBackgroundHealthOutbox(updatedOutbox);
          await deliverWatchHealthOutbox({
            installId,
            initialOutbox: updatedOutbox,
            request: (envelope) => this.request({ method: "health.upload", params: { envelope } }),
            readLatest: () => readBackgroundHealthOutbox(installId),
            write: writeBackgroundHealthOutbox,
          });
        } catch (error) {
          captureException(error, { operation: "collect-and-deliver-health" });
          logger.error("health collection or delivery failed %j", error);
          renderHint("Health sync pending\nWill retry automatically");
        }
      })();
      this.state.healthSyncTask = task;
      const clearTask = () => {
        if (this.state.healthSyncTask === task) this.state.healthSyncTask = null;
      };
      void task.then(clearTask, clearTask);
      return task;
    },

    onCall(payload: { method: string; params?: Record<string, unknown> } | null) {
      if (isConnectionChangedCall(payload)) {
        this.refreshPreferences({ startPairingIfNeeded: false });
        return;
      }

      if (
        handleSessionCall(payload, {
          logging: this.state.logging,
          transferInProgress: Boolean(this.state.transferTask),
          failedTransferPending: Boolean(this.state.pendingImuA || this.state.pendingImuB),
          pendingManualExport: this.state.pendingManualExport,
          applyStartPreferences: (params) => {
            this.state.freqModeIndex = Number(params?.freqModeIndex ?? this.state.freqModeIndex);
          },
          handleBlockedStart: () => {
            showToast({ content: "Transfer session before starting" });
            renderHint("Finish session transfer\nbefore starting");
          },
          startLogging: () => this.startLogging(),
          stopLogging: () => this.stopLogging(),
          queueManualExport: () => {
            this.state.pendingManualExport = true;
          },
          transferStoppedSession: () => this.transferStoppedSession(),
        })
      ) {
        return;
      }

      const method = payload?.method;
      if (method === "health.collect") {
        void this.collectAndDeliverHealth();
      }
    },

    onDestroy() {
      if (this.state.logging) {
        this.stopLogging();
      }
      this.state.healthOwnership
        ?.then((ownership) => ownership.release(this.state.healthSyncTask ?? Promise.resolve()))
        .catch((error: unknown) => {
          captureException(error, { operation: "release-health-outbox" });
          logger.error("health ownership release failed %j", error);
        });
    },
  }),
);
