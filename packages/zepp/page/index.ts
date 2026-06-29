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
import { align, createWidget, prop, text_style, widget } from "@zos/ui";
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

Page(
  BasePage({
    state: {
      logging: false,
      enableGyro: false,
      freqModeIndex: 1,
      pendingBuffer: emptyArray<ImuSample>(),
      collector: nullable<ReturnType<typeof createImuCollector>>(),
      hasGyro: false,
      transferTask: nullable<{
        on: (event: string, cb: (event: { data: Record<string, unknown> }) => void) => void;
      }>(),
      sampleCount: 0,
      observedHzX100: 0,
      activeFile: "A" as "A" | "B",
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
        h: px(100),
        color: 0x7fb3d3,
        text_size: px(24),
        align_h: align.CENTER_H,
        text_style: text_style.WRAP,
        text: "0 samples\n— Hz",
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

    activeFilePath() {
      return this.state.activeFile === "A" ? SESSION_FILE_A : SESSION_FILE_B;
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

        resetSessionFile({
          hasGyro: collector.hasGyroscope,
          sessionStartMs: Date.now(),
          sampleCount: 0,
          accelFreqMode: collector.accelMode,
          gyroFreqMode: collector.gyroMode ?? 0,
          observedHzX100: 0,
        }, this.activeFilePath());

        collector.start();
        this.state.logging = true;

        const modeLabel =
          FREQ_MODES.find((item) => item.value === collector.accelMode)?.label ?? "?";
        renderSensorInfo(
          collector.hasGyroscope
            ? `Accel · Gyro · ${modeLabel}`
            : `Accel · ${modeLabel}`,
        );
        renderStatus("● Recording");

        this.publishSessionStatus("logging");
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
        `${stats.sampleCount} samples\n` +
          `${(stats.observedHzX100 / 100).toFixed(2)} Hz`,
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

      // Flush pending samples and finalize the current file before handing it off
      this.flushBuffer(false);
      const outgoingPath = this.activeFilePath();
      finalizeSessionFile(this.state.sampleCount, this.state.observedHzX100, outgoingPath);
      this.writeMetaFile();

      const sampleCountSnapshot = this.state.sampleCount;
      const observedHzX100Snapshot = this.state.observedHzX100;

      // Swap to the other file — sensor keeps running without a gap
      this.state.activeFile = this.state.activeFile === "A" ? "B" : "A";
      this.state.sampleCount = 0;
      this.state.observedHzX100 = 0;
      this.state.pendingBuffer = [];

      const collector = this.state.collector;
      if (collector && collector.available) {
        resetSessionFile({
          hasGyro: this.state.hasGyro,
          sessionStartMs: Date.now(),
          sampleCount: 0,
          accelFreqMode: collector.accelMode,
          gyroFreqMode: collector.gyroMode ?? 0,
          observedHzX100: 0,
        }, this.activeFilePath());
      }

      this.publishSessionStatus("logging");

      // Transfer the outgoing file in the background
      const task = this.sendFile(outgoingPath, {
        type: "imu-session",
        sampleCount: String(sampleCountSnapshot),
        observedHzX100: String(observedHzX100Snapshot),
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
          this.request({
            method: "imu.transferComplete",
            params: { sampleCount: sampleCountSnapshot },
          }).catch((error: unknown) => {
            logger.error("imu.transferComplete failed %j", error);
          });
          return;
        }

        if (event.data.readyState === "error") {
          this.state.transferTask = null;
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
        this.swapAndTransfer();
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
