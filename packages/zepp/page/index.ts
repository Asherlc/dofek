import { pagePlugin } from "@zeppos/zml/3.0/module/messaging/plugin/page";
import { BasePage } from "@zeppos/zml/base-page";
import { queryPermission, requestPermission } from "@zos/app";
import * as appService from "@zos/app-service";
import { getDeviceInfo } from "@zos/device";
import { setWakeUpRelaunch } from "@zos/display";
import { writeFileSync } from "@zos/fs";
import { showToast } from "@zos/interaction";
import {
  Accelerometer,
  BloodOxygen,
  BodyTemperature,
  Calorie,
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
} from "@zos/sensor";
import { align, createKeyboard, createWidget, inputType, prop, text_style, widget } from "@zos/ui";
import { log as Logger, px } from "@zos/utils";

import { collectHealthData } from "../src/health-collector.ts";
import { createImuCollector, FREQ_MODES } from "../src/imu-collector.ts";
import { appendSamples, finalizeSessionFile, resetSessionFile } from "../src/session-file.ts";
import {
  AUTO_TRANSFER_SAMPLE_COUNT,
  FLUSH_SAMPLE_THRESHOLD,
  SERVICE_FILE,
  SESSION_FILE_A,
  SESSION_FILE_B,
  SESSION_META_FILE,
} from "../src/storage-keys.ts";
import type { ImuSample } from "../src/types.ts";

type ActiveFileSlot = "A" | "B";
type TransferTask = {
  on: (event: string, cb: (event: { data: Record<string, unknown> }) => void) => void;
};
type FailedTransfer = {
  slot: ActiveFileSlot;
  sampleCount: number;
  observedHzX100: number;
};

function nullable<T>(): T | null {
  return null;
}
function emptyArray<T>(): T[] {
  return [];
}

BasePage.use(pagePlugin);

const logger = Logger.getLogger("imu-page");
const { width: DEVICE_WIDTH } = getDeviceInfo();
const BG_PERMISSION = "device:os.bg_service";

let statusText: ReturnType<typeof createWidget> | null = null;
let sensorInfoText: ReturnType<typeof createWidget> | null = null;
let sampleText: ReturnType<typeof createWidget> | null = null;
let hintText: ReturnType<typeof createWidget> | null = null;
let pairingQrContent: string | null = null;

function renderStatus(text: string) {
  if (statusText) {
    statusText.setProperty(prop.TEXT, text);
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
      enableGyro: false,
      freqModeIndex: 1,
      pendingBuffer: emptyArray<ImuSample>(),
      collector: nullable<ReturnType<typeof createImuCollector>>(),
      hasGyro: false,
      transferTask: nullable<TransferTask>(),
      failedTransfer: nullable<FailedTransfer>(),
      sampleCount: 0,
      observedHzX100: 0,
      // biome-ignore lint/plugin/no-as-type-assertion: widens literal "A" to "A" | "B" for state field inference
      activeFile: "A" as ActiveFileSlot,
      hasCredentials: false,
      dofekEmail: "",
      dofekPassword: "",
      pairingVerificationUrl: "",
      pairingShortCode: "",
    },

    onInit() {
      setWakeUpRelaunch(true);
      this.refreshPreferences();
    },

    build() {
      createWidget(widget.TEXT, {
        x: px(0),
        y: px(36),
        w: DEVICE_WIDTH,
        h: px(52),
        color: 0xffffff,
        text_size: px(40),
        align_h: align.CENTER_H,
        text_style: text_style.NONE,
        text: "Dofek",
      });

      statusText = createWidget(widget.TEXT, {
        x: px(40),
        y: px(106),
        w: DEVICE_WIDTH - px(80),
        h: px(48),
        color: 0x2ecc71,
        text_size: px(32),
        align_h: align.CENTER_H,
        text_style: text_style.NONE,
        text: "Starting...",
      });

      sensorInfoText = createWidget(widget.TEXT, {
        x: px(40),
        y: px(162),
        w: DEVICE_WIDTH - px(80),
        h: px(36),
        color: 0x888888,
        text_size: px(20),
        align_h: align.CENTER_H,
        text_style: text_style.NONE,
        text: "",
      });

      sampleText = createWidget(widget.TEXT, {
        x: px(40),
        y: px(214),
        w: DEVICE_WIDTH - px(80),
        h: px(80),
        color: 0x7fb3d3,
        text_size: px(24),
        align_h: align.CENTER_H,
        text_style: text_style.WRAP,
        text: "0 samples\n— Hz",
      });

      hintText = createWidget(widget.TEXT, {
        x: px(40),
        y: px(310),
        w: DEVICE_WIDTH - px(80),
        h: px(72),
        color: 0xe67e22,
        text_size: px(20),
        align_h: align.CENTER_H,
        text_style: text_style.WRAP,
        text: "",
      });

      createWidget(widget.BUTTON, {
        x: px(40),
        y: DEVICE_WIDTH <= 360 ? px(338) : px(438),
        w: DEVICE_WIDTH - px(80),
        h: px(44),
        text: "Login on watch",
        color: 0xffffff,
        text_size: px(22),
        normal_color: 0x1976d2,
        press_color: 0x64a8f0,
        radius: px(10),
        click_func: () => {
          this.loginFromWatch();
        },
      });
    },

    refreshPreferences() {
      this.request({
        method: "imu.getPreferences",
        params: {},
      })
        .then((result) => {
          this.state.enableGyro = result?.enableGyro === true;
          this.state.freqModeIndex = Number(result?.freqModeIndex ?? 1);
          this.state.hasCredentials = result?.hasCredentials === true;
          const pairing = isRecord(result?.pairing) ? result.pairing : null;
          this.renderPairing(pairing);
          if (!this.state.hasCredentials && !pairing) {
            this.startPairingFromWatch();
          }
          this.startLogging();
        })
        .catch((error) => {
          logger.error("preference fetch failed %j", error);
          this.startLogging();
        });
    },

    ensureBackgroundPermission(callback: (granted: boolean) => void) {
      const [status] = queryPermission({ permissions: [BG_PERMISSION] });

      if (status === 2) {
        callback(true);
        return;
      }

      requestPermission({
        permissions: [BG_PERMISSION],
        callback: ([result]) => {
          callback(result === 2);
        },
      });
    },

    startBackgroundService() {
      appService.start({
        url: SERVICE_FILE,
        param: "action=start",
        reload: true,
        complete_func: (info) => {
          logger.log("app-service start %j", info);
        },
      });
    },

    filePathForSlot(slot: ActiveFileSlot) {
      return slot === "A" ? SESSION_FILE_A : SESSION_FILE_B;
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

      this.ensureBackgroundPermission((granted) => {
        if (!granted) {
          showToast({ content: "Background permission required" });
          return;
        }

        this.startBackgroundService();

        const collector = createImuCollector(
          {
            enableGyro: this.state.enableGyro,
            requestedFreqModeIndex: this.state.freqModeIndex,
            onSample: (sample) => this.handleSample(sample),
            onStatus: (stats) => this.handleRate(stats),
          },
          { Accelerometer, Gyroscope, checkSensor },
        );

        if (!collector.available) {
          showToast({ content: collector.reason });
          renderStatus(collector.reason);
          return;
        }

        this.state.collector = collector;
        this.state.hasGyro = collector.hasGyroscope;
        this.state.pendingBuffer = [];
        this.state.sampleCount = 0;
        this.state.observedHzX100 = 0;
        this.state.activeFile = "A";

        resetSessionFile(
          {
            hasGyro: collector.hasGyroscope,
            sessionStartMs: Date.now(),
            sampleCount: 0,
            accelFreqMode: collector.accelMode,
            gyroFreqMode: collector.gyroMode ?? 0,
            observedHzX100: 0,
          },
          this.activeFilePath(),
        );

        collector.start();
        this.state.logging = true;

        const modeLabel =
          FREQ_MODES.find((item) => item.value === collector.accelMode)?.label ?? "?";
        renderSensorInfo(
          collector.hasGyroscope ? `Accel · Gyro · ${modeLabel}` : `Accel · ${modeLabel}`,
        );
        if (this.state.hasCredentials) {
          renderHint("");
        } else if (!this.state.pairingShortCode) {
          renderHint("Not connected\nCreating pairing code...");
        }
        renderStatus("● Recording");

        this.publishSessionStatus("logging");
      });
    },

    renderPairing(pairing: Record<string, unknown> | null) {
      if (!pairing || this.state.hasCredentials) {
        return;
      }

      const verificationUrl = getString(pairing, "verificationUrl");
      const shortCode = getString(pairing, "shortCode");
      if (!verificationUrl || !shortCode) {
        return;
      }

      this.state.pairingVerificationUrl = verificationUrl;
      this.state.pairingShortCode = shortCode;
      renderHint(`Pair Dofek\nCode ${shortCode}`);

      if (pairingQrContent === verificationUrl) {
        return;
      }

      pairingQrContent = verificationUrl;
      const qrSize = DEVICE_WIDTH <= 360 ? px(92) : px(128);
      const qrY = DEVICE_WIDTH <= 360 ? px(242) : px(298);
      createWidget(widget.QRCODE, {
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
              this.state.dofekPassword = password;
              this.request({
                method: "dofek.loginWithPassword",
                params: { email: this.state.dofekEmail, password },
              })
                .then(() => {
                  this.state.hasCredentials = true;
                  renderHint("Connected");
                })
                .catch((error: unknown) => {
                  logger.error("watch login failed %j", error);
                  renderHint("Login failed\nCheck password");
                });
            },
          });
        },
      });
    },

    handleSample(sample: ImuSample) {
      this.state.pendingBuffer.push(sample);
      this.state.sampleCount += 1;

      if (this.state.pendingBuffer.length >= FLUSH_SAMPLE_THRESHOLD) {
        this.flushBuffer(false);
      }

      if (this.state.sampleCount >= AUTO_TRANSFER_SAMPLE_COUNT && !this.state.transferTask) {
        this.swapAndTransfer();
      }
    },

    handleRate(stats: { sampleCount: number; observedHzX100: number }) {
      this.state.observedHzX100 = stats.observedHzX100;
      renderSamples(
        `${stats.sampleCount} samples\n` + `${(stats.observedHzX100 / 100).toFixed(2)} Hz`,
      );
      this.writeMetaFile();
    },

    flushBuffer(finalize: boolean) {
      const path = this.activeFilePath();
      if (!this.state.pendingBuffer.length) {
        if (finalize) {
          finalizeSessionFile(this.state.sampleCount, this.state.observedHzX100, path);
        }
        return;
      }

      appendSamples(this.state.pendingBuffer, this.state.hasGyro, path);
      this.state.pendingBuffer = [];

      if (finalize) {
        finalizeSessionFile(this.state.sampleCount, this.state.observedHzX100, path);
      }
    },

    stopLogging() {
      if (!this.state.logging) {
        return;
      }

      this.state.logging = false;
      this.state.collector?.stop();
      this.flushBuffer(true);
      this.writeMetaFile();
      this.publishSessionStatus("stopped");
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

      if (this.state.failedTransfer?.slot === nextSlot) {
        showToast({ content: "Send failed; recording stopped" });
        this.stopLogging();
        return;
      }

      // Flush pending samples and finalize the current file before handing it off
      this.flushBuffer(false);
      finalizeSessionFile(this.state.sampleCount, this.state.observedHzX100, outgoingPath);

      const sampleCountSnapshot = this.state.sampleCount;
      const observedHzX100Snapshot = this.state.observedHzX100;

      // Swap to the other file — sensor keeps running without a gap
      this.state.activeFile = nextSlot;
      this.state.sampleCount = 0;
      this.state.observedHzX100 = 0;
      this.state.pendingBuffer = [];

      const collector = this.state.collector;
      if (collector?.available) {
        resetSessionFile(
          {
            hasGyro: this.state.hasGyro,
            sessionStartMs: Date.now(),
            sampleCount: 0,
            accelFreqMode: collector.accelMode,
            gyroFreqMode: collector.gyroMode ?? 0,
            observedHzX100: 0,
          },
          this.activeFilePath(),
        );
      }

      this.publishSessionStatus("logging");
      this.writeMetaFile();

      this.startTransfer({
        path: outgoingPath,
        sampleCount: sampleCountSnapshot,
        observedHzX100: observedHzX100Snapshot,
        failedSlot: outgoingSlot,
      });
    },

    transferStoppedSession() {
      if (this.state.transferTask) {
        return;
      }

      const failedTransfer = this.state.failedTransfer;
      if (failedTransfer) {
        this.startTransfer({
          path: this.filePathForSlot(failedTransfer.slot),
          sampleCount: failedTransfer.sampleCount,
          observedHzX100: failedTransfer.observedHzX100,
          failedSlot: failedTransfer.slot,
        });
        return;
      }

      this.flushBuffer(true);
      this.writeMetaFile();

      this.startTransfer({
        path: this.activeFilePath(),
        sampleCount: this.state.sampleCount,
        observedHzX100: this.state.observedHzX100,
        failedSlot: null,
      });
    },

    startTransfer({
      path,
      sampleCount,
      observedHzX100,
      failedSlot,
    }: {
      path: string;
      sampleCount: number;
      observedHzX100: number;
      failedSlot: ActiveFileSlot | null;
    }) {
      // Transfer the outgoing file in the background
      const task = this.sendFile(path, {
        type: "imu-session",
        sampleCount: String(sampleCount),
        observedHzX100: String(observedHzX100),
      });

      this.state.transferTask = task;

      task.on("progress", (event: { data: Record<string, unknown> }) => {
        const loadedSize = Number(event.data.loadedSize);
        const fileSize = Number(event.data.fileSize);
        const pct = fileSize > 0 ? Math.floor((loadedSize * 100) / fileSize) : 0;
        logger.log("transfer %d%%", pct);
      });

      task.on("change", (event: { data: Record<string, unknown> }) => {
        if (String(event.data.readyState) === "transferred") {
          this.state.transferTask = null;
          if (failedSlot && this.state.failedTransfer?.slot === failedSlot) {
            this.state.failedTransfer = null;
          }
          this.request({
            method: "imu.transferComplete",
            params: { sampleCount },
          }).catch((error: unknown) => {
            logger.error("imu.transferComplete failed %j", error);
          });
          return;
        }

        if (event.data.readyState === "error") {
          this.state.transferTask = null;
          if (failedSlot) {
            this.state.failedTransfer = { slot: failedSlot, sampleCount, observedHzX100 };
          }
          showToast({ content: "Send failed" });
        }
      });
    },

    writeMetaFile() {
      writeFileSync({
        path: SESSION_META_FILE,
        data: new TextEncoder().encode(
          JSON.stringify({
            sampleCount: this.state.sampleCount,
            observedHzX100: this.state.observedHzX100,
            hasGyro: this.state.hasGyro,
            updatedAt: Date.now(),
          }),
        ).buffer,
      });
    },

    publishSessionStatus(state: string) {
      this.request({
        method: "imu.publishStatus",
        params: {
          state,
          freqModeIndex: this.state.freqModeIndex,
          sampleCount: this.state.sampleCount,
          observedHzX100: this.state.observedHzX100,
          hasGyro: this.state.hasGyro,
          sessionFile: this.activeFilePath(),
        },
      }).catch((error) => {
        logger.error("status publish failed %j", error);
      });
    },

    onCall(payload: { method: string; params?: Record<string, unknown> } | null) {
      const { method } = payload ?? { method: "" };

      if (method === "transfer.start") {
        if (this.state.logging) {
          this.swapAndTransfer();
        } else {
          this.transferStoppedSession();
        }
      }

      if (method === "health.collect") {
        const data = collectHealthData({
          HeartRate,
          Step,
          Calorie,
          Distance,
          Sleep,
          BloodOxygen,
          BodyTemperature,
          Stress,
          Stand,
          Pai,
          FatBurning,
        });
        this.request({
          method: "health.upload",
          params: { data },
        }).catch((err: unknown) => {
          logger.error("health data upload request failed %j", err);
        });
      }
    },

    onDestroy() {
      if (this.state.logging) {
        this.stopLogging();
      }
    },
  }),
);
