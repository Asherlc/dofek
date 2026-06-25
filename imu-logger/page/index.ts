import { pagePlugin } from "@zeppos/zml/3.0/module/messaging/plugin/page";
import { BasePage } from "@zeppos/zml/base-page";
import { queryPermission, requestPermission } from "@zos/app";
import * as appService from "@zos/app-service";
import { getDeviceInfo } from "@zos/device";
import { setWakeUpRelaunch } from "@zos/display";
import { writeFileSync } from "@zos/fs";
import { showToast } from "@zos/interaction";
import { Accelerometer, checkSensor, Gyroscope } from "@zos/sensor";
import { align, createWidget, prop, text_style, widget } from "@zos/ui";
import { log as Logger, px } from "@zos/utils";

import { createImuCollector, FREQ_MODES } from "../src/imu-collector.ts";
import { appendSamples, finalizeSessionFile, resetSessionFile } from "../src/session-file.ts";
import {
  FLUSH_SAMPLE_THRESHOLD,
  SERVICE_FILE,
  SESSION_FILE,
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
let sampleText: ReturnType<typeof createWidget> | null = null;

function renderStatus(text: string) {
  if (statusText) {
    statusText.setProperty(prop.TEXT, text);
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
    },

    onInit() {
      setWakeUpRelaunch(true);
      this.refreshPreferences();
    },

    build() {
      createWidget(widget.TEXT, {
        x: px(24),
        y: px(30),
        w: DEVICE_WIDTH - px(48),
        h: px(48),
        color: 0xffffff,
        text_size: px(34),
        align_h: align.CENTER_H,
        text_style: text_style.NONE,
        text: "IMU Logger",
      });

      statusText = createWidget(widget.TEXT, {
        x: px(24),
        y: px(90),
        w: DEVICE_WIDTH - px(48),
        h: px(120),
        color: 0xcccccc,
        text_size: px(24),
        align_h: align.LEFT,
        text_style: text_style.WRAP,
        text: "Idle",
      });

      sampleText = createWidget(widget.TEXT, {
        x: px(24),
        y: px(220),
        w: DEVICE_WIDTH - px(48),
        h: px(120),
        color: 0x9ad1ff,
        text_size: px(22),
        align_h: align.LEFT,
        text_style: text_style.WRAP,
        text: "samples: 0\nrate: n/a",
      });

      createWidget(widget.BUTTON, {
        x: px(40),
        y: px(360),
        w: DEVICE_WIDTH - px(80),
        h: px(72),
        radius: px(16),
        normal_color: 0x2ecc71,
        press_color: 0x27ae60,
        text_size: px(28),
        text: "Start",
        click_func: () => this.startLogging(),
      });

      createWidget(widget.BUTTON, {
        x: px(40),
        y: px(450),
        w: DEVICE_WIDTH - px(80),
        h: px(72),
        radius: px(16),
        normal_color: 0xe74c3c,
        press_color: 0xc0392b,
        text_size: px(28),
        text: "Stop",
        click_func: () => this.stopLogging(),
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
        })
        .catch((error) => {
          logger.error("preference fetch failed %j", error);
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

        resetSessionFile({
          hasGyro: collector.hasGyroscope,
          sessionStartMs: Date.now(),
          sampleCount: 0,
          accelFreqMode: collector.accelMode,
          gyroFreqMode: collector.gyroMode ?? 0,
          observedHzX100: 0,
        });

        collector.start();
        this.state.logging = true;

        const modeLabel =
          FREQ_MODES.find((item) => item.value === collector.accelMode)?.label ?? "UNKNOWN";

        renderStatus(
          `Logging\naccel mode: ${modeLabel}\n` +
            `${collector.hasGyroscope ? "gyro enabled" : "gyro off"}`,
        );

        this.publishSessionStatus("logging");
      });
    },

    handleSample(sample: ImuSample) {
      this.state.pendingBuffer.push(sample);
      this.state.sampleCount += 1;

      if (this.state.pendingBuffer.length >= FLUSH_SAMPLE_THRESHOLD) {
        this.flushBuffer(false);
      }
    },

    handleRate(stats: { sampleCount: number; observedHzX100: number }) {
      this.state.observedHzX100 = stats.observedHzX100;
      renderSamples(
        `samples: ${stats.sampleCount}\n` +
          `delivered: ${(stats.observedHzX100 / 100).toFixed(2)} Hz`,
      );
      this.writeMetaFile();
    },

    flushBuffer(finalize: boolean) {
      if (!this.state.pendingBuffer.length) {
        if (finalize) {
          finalizeSessionFile(this.state.sampleCount, this.state.observedHzX100);
        }
        return;
      }

      appendSamples(this.state.pendingBuffer, this.state.hasGyro);
      this.state.pendingBuffer = [];

      if (finalize) {
        finalizeSessionFile(this.state.sampleCount, this.state.observedHzX100);
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

      renderStatus("Stopped\nready for transfer");
      renderSamples(
        `samples: ${this.state.sampleCount}\n` +
          `delivered: ${(this.state.observedHzX100 / 100).toFixed(2)} Hz`,
      );

      this.publishSessionStatus("stopped");
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
          sessionFile: SESSION_FILE,
        },
      }).catch((error) => {
        logger.error("status publish failed %j", error);
      });
    },

    transferSession() {
      if (this.state.transferTask) {
        showToast({ content: "Transfer already running" });
        return;
      }

      this.flushBuffer(true);

      const task = this.sendFile(SESSION_FILE, {
        type: "imu-session",
        sampleCount: String(this.state.sampleCount),
        observedHzX100: String(this.state.observedHzX100),
      });

      this.state.transferTask = task;

      task.on("progress", (event: { data: Record<string, unknown> }) => {
        const loadedSize = Number(event.data.loadedSize);
        const fileSize = Number(event.data.fileSize);
        const pct = fileSize > 0 ? Math.floor((loadedSize * 100) / fileSize) : 0;
        renderStatus(`Transferring ${pct}%`);
      });

      task.on("change", (event: { data: Record<string, unknown> }) => {
        if (String(event.data.readyState) === "transferred") {
          this.state.transferTask = null;
          renderStatus("Transfer complete");
          showToast({ content: "File sent to phone" });
          this.request({
            method: "imu.transferComplete",
            params: {
              sampleCount: this.state.sampleCount,
            },
          }).catch((error) => {
            logger.error("imu.transferComplete failed %j", error);
          });
          return;
        }

        if (event.data.readyState === "error") {
          this.state.transferTask = null;
          renderStatus("Transfer failed");
          showToast({ content: "Transfer failed" });
        }
      });
    },

    onCall(payload: { method: string; params?: Record<string, unknown> } | null) {
      const { method, params = {} } = payload ?? { method: "", params: {} };

      if (method === "logging.start") {
        this.state.enableGyro = params.enableGyro === true;
        this.state.freqModeIndex = Number(params.freqModeIndex ?? 1);
        this.startLogging();
        return;
      }

      if (method === "logging.stop") {
        this.stopLogging();
        return;
      }

      if (method === "transfer.start") {
        this.transferSession();
      }
    },

    onDestroy() {
      if (this.state.logging) {
        this.stopLogging();
      }
    },
  }),
);
