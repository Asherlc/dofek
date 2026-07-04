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
  Barometer,
  BloodOxygen,
  BodyTemperature,
  Calorie,
  Compass,
  checkSensor,
  Distance,
  FatBurning,
  Geolocation,
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
import { createPhysicalSensorCollector } from "../src/physical-sensor-collector.ts";
import {
  appendPhysicalSamples,
  appendSamples,
  finalizeSessionFile,
  resetSessionFile,
} from "../src/session-file.ts";
import {
  AUTO_TRANSFER_SAMPLE_COUNT,
  FLUSH_SAMPLE_THRESHOLD,
  SERVICE_FILE,
  SESSION_FILE_A,
  SESSION_FILE_B,
  SESSION_META_FILE,
} from "../src/storage-keys.ts";
import type { ImuSample, LocationSample, PhysicalScalarSample } from "../src/types.ts";

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

Page(
  BasePage({
    state: {
      logging: false,
      enableGyro: false,
      freqModeIndex: 1,
      pendingBuffer: emptyArray<ImuSample>(),
      pendingScalarSamples: emptyArray<PhysicalScalarSample>(),
      pendingLocationSamples: emptyArray<LocationSample>(),
      collector: nullable<ReturnType<typeof createImuCollector>>(),
      physicalCollector: nullable<ReturnType<typeof createPhysicalSensorCollector>>(),
      hasGyro: false,
      transferTask: nullable<TransferTask>(),
      failedTransfer: nullable<FailedTransfer>(),
      sampleCount: 0,
      observedHzX100: 0,
      // biome-ignore lint/plugin/no-as-type-assertion: widens literal "A" to "A" | "B" for state field inference
      activeFile: "A" as ActiveFileSlot,
      hasCredentials: false,
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
        this.state.pendingScalarSamples = [];
        this.state.pendingLocationSamples = [];
        this.state.sampleCount = 0;
        this.state.observedHzX100 = 0;
        this.state.activeFile = "A";
        const sessionStartMs = Date.now();
        const physicalCollector = createPhysicalSensorCollector(
          {
            onScalarSample: (sample) => {
              this.state.pendingScalarSamples.push(sample);
            },
            onLocationSample: (sample) => {
              this.state.pendingLocationSamples.push(sample);
            },
            onStatus: (status) => {
              logger.log("physical sensors %j", status);
            },
          },
          { now: Date.now, HeartRate, BloodOxygen, Barometer, Compass, Geolocation },
        );
        this.state.physicalCollector = physicalCollector;

        resetSessionFile(
          {
            hasGyro: collector.hasGyroscope,
            sessionStartMs,
            sampleCount: 0,
            accelFreqMode: collector.accelMode,
            gyroFreqMode: collector.gyroMode ?? 0,
            observedHzX100: 0,
          },
          this.activeFilePath(),
        );

        physicalCollector.start(sessionStartMs);
        collector.start();
        this.state.logging = true;

        const modeLabel =
          FREQ_MODES.find((item) => item.value === collector.accelMode)?.label ?? "?";
        renderSensorInfo(
          collector.hasGyroscope ? `Accel · Gyro · ${modeLabel}` : `Accel · ${modeLabel}`,
        );
        renderHint(this.state.hasCredentials ? "" : "Not connected\nOpen Zepp app → Settings");
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
        `${stats.sampleCount} samples\n` + `${(stats.observedHzX100 / 100).toFixed(2)} Hz`,
      );
      this.writeMetaFile();
    },

    flushBuffer(finalize: boolean) {
      const path = this.activeFilePath();
      if (this.state.pendingBuffer.length) {
        appendSamples(this.state.pendingBuffer, this.state.hasGyro, path);
        this.state.pendingBuffer = [];
      }

      if (this.state.pendingScalarSamples.length || this.state.pendingLocationSamples.length) {
        appendPhysicalSamples(
          this.state.pendingScalarSamples,
          this.state.pendingLocationSamples,
          path,
        );
        this.state.pendingScalarSamples = [];
        this.state.pendingLocationSamples = [];
      }

      if (finalize) {
        finalizeSessionFile(this.state.sampleCount, this.state.observedHzX100, path);
      }
    },

    stopLogging() {
      if (!this.state.logging) {
        return;
      }

      this.state.logging = false;
      this.state.physicalCollector?.stop();
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
      this.state.physicalCollector?.stop();
      this.flushBuffer(false);
      finalizeSessionFile(this.state.sampleCount, this.state.observedHzX100, outgoingPath);

      const sampleCountSnapshot = this.state.sampleCount;
      const observedHzX100Snapshot = this.state.observedHzX100;

      // Swap to the other file — sensor keeps running without a gap
      this.state.activeFile = nextSlot;
      this.state.sampleCount = 0;
      this.state.observedHzX100 = 0;
      this.state.pendingBuffer = [];
      this.state.pendingScalarSamples = [];
      this.state.pendingLocationSamples = [];

      const collector = this.state.collector;
      if (collector?.available) {
        const sessionStartMs = Date.now();
        resetSessionFile(
          {
            hasGyro: this.state.hasGyro,
            sessionStartMs,
            sampleCount: 0,
            accelFreqMode: collector.accelMode,
            gyroFreqMode: collector.gyroMode ?? 0,
            observedHzX100: 0,
          },
          this.activeFilePath(),
        );
        this.state.physicalCollector?.start(sessionStartMs);
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
