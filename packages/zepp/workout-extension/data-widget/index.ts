import { getSportData } from "@zos/app-access";
import {
  pauseDropWristScreenOff,
  resetDropWristScreenOff,
  resetPageBrightTime,
  setPageBrightTime,
} from "@zos/display";
import { Accelerometer, checkSensor, Gyroscope, HeartRate } from "@zos/sensor";
import { align, createWidget, prop, text_style, widget } from "@zos/ui";
import { log as Logger, px } from "@zos/utils";
import { BasePage } from "@zeppos/zml/base-page";
import { createDisplayLease } from "../../src/display-lease.ts";
import { createImuCollector } from "../../src/imu-collector.ts";
import {
  createImuSessionController,
  type ImuSegmentResult,
  type ImuSessionController,
} from "../../src/imu-session-controller.ts";
import {
  clearPendingImuTransfer,
  type ImuFileSlot,
  readPendingImuTransfers,
  savePendingImuTransfer,
} from "../../src/imu-transfer-storage.ts";
import { ensureInstallId } from "../../src/install-id.ts";
import { appendSamples, finalizeSessionFile, resetSessionFile } from "../../src/session-file.ts";
import {
  FLUSH_SAMPLE_THRESHOLD,
  WORKOUT_IMU_TRANSFER_FILE,
  WORKOUT_SESSION_FILE_A,
  WORKOUT_SESSION_FILE_B,
} from "../../src/storage-keys.ts";
import {
  createWorkoutHealthEnvelope,
  isWorkoutHealthEventAcknowledged,
} from "../../src/workout-health-envelope.ts";
import {
  collectLiveWorkoutSnapshot,
  findLiveWorkoutExternalId,
  type LiveWorkoutSnapshot,
} from "../../src/workout-live.ts";
import {
  type LiveWorkoutBatch,
  readLiveWorkoutBuffer,
  removeUploadedLiveWorkoutSnapshots,
  writeLiveWorkoutBuffer,
} from "../../src/workout-live-storage.ts";
import { deliverImuChunk } from "../../src/watch-imu-chunk-sync.ts";

const logger = Logger.getLogger("dofek-workout");
const SAMPLE_INTERVAL_MS = 10_000;
const UPLOAD_BATCH_SIZE = 6;
function nullable<T>(): T | null {
  return null;
}

function emptyArray<T>(): T[] {
  return [];
}

DataWidget(
  BasePage({
    state: {
      intervalId: nullable<ReturnType<typeof setInterval>>(),
      collecting: false,
      flushing: false,
      pendingBatches: emptyArray<LiveWorkoutBatch>(),
      statusWidget: nullable<ReturnType<typeof createWidget>>(),
      focused: false,
      imuController: nullable<ImuSessionController>(),
      activeImuSlot: "A" as ImuFileSlot,
      pendingImuA: nullable<ImuSegmentResult>(),
      pendingImuB: nullable<ImuSegmentResult>(),
      transferringImuA: false,
      transferringImuB: false,
    },

    build() {
      const persistedBuffer = readLiveWorkoutBuffer();
      this.state.pendingBatches = persistedBuffer.batches;
      try {
        for (const transfer of readPendingImuTransfers(WORKOUT_IMU_TRANSFER_FILE)) {
          if (transfer.slot === "A") this.state.pendingImuA = transfer;
          else this.state.pendingImuB = transfer;
        }
      } catch (error) {
        this.reportError(error, "workout-imu-restore");
      }
      createWidget(widget.TEXT, {
        x: px(20),
        y: px(80),
        w: px(440),
        h: px(60),
        color: 0xffffff,
        text_size: px(34),
        align_h: align.CENTER_H,
        text_style: text_style.NONE,
        text: "Dofek Workout",
      });
      this.state.statusWidget = createWidget(widget.TEXT, {
        x: px(20),
        y: px(160),
        w: px(440),
        h: px(120),
        color: 0x9ca3af,
        text_size: px(26),
        align_h: align.CENTER_H,
        text_style: text_style.WRAP,
        text: "Collecting live workout data",
      });
      this.state.focused = true;
      this.startCollection();
      this.retryImuTransfers();
      this.startImuSegment();
    },

    reportError(error: unknown, category: string) {
      logger.error("%s failed %j", category, error);
      void this.request({
        method: "telemetry.report",
        params: {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : "Error",
          stack: error instanceof Error ? error.stack : undefined,
          category,
        },
      }).catch((reportError: unknown) => {
        logger.error("telemetry report failed %j", reportError);
      });
    },

    async collectSnapshot() {
      if (this.state.collecting) return;
      this.state.collecting = true;
      try {
        const heartRate = new HeartRate();
        const snapshot = await collectLiveWorkoutSnapshot(getSportData, () => heartRate.getLast());
        const externalId = findLiveWorkoutExternalId(
          snapshot,
          this.state.pendingBatches.map((batch) => batch.externalId),
        );
        if (!externalId) return;
        let batch = this.state.pendingBatches.find(
          (pendingBatch) => pendingBatch.externalId === externalId,
        );
        if (!batch) {
          batch = { externalId, snapshots: [] };
          this.state.pendingBatches.push(batch);
        }
        batch.snapshots.push(snapshot);
        writeLiveWorkoutBuffer({ batches: this.state.pendingBatches });
        const pendingSampleCount = this.state.pendingBatches.reduce(
          (count, pendingBatch) => count + pendingBatch.snapshots.length,
          0,
        );
        this.state.statusWidget?.setProperty(
          prop.TEXT,
          `Captured ${pendingSampleCount} live sample${pendingSampleCount === 1 ? "" : "s"}`,
        );
        if (pendingSampleCount >= UPLOAD_BATCH_SIZE) {
          await this.flushSnapshots();
        }
      } catch (error: unknown) {
        this.reportError(error, "workout-collection");
      } finally {
        this.state.collecting = false;
      }
    },

    async flushSnapshots() {
      if (this.state.flushing || this.state.pendingBatches.length === 0) return;
      this.state.flushing = true;
      try {
        for (const batch of [...this.state.pendingBatches]) {
          const snapshotsToUpload = [...batch.snapshots];
          const latestSnapshot = snapshotsToUpload.at(-1);
          if (!latestSnapshot) continue;
          const envelope = createWorkoutHealthEnvelope(
            ensureInstallId(settings.settingsStorage),
            batch.externalId,
            snapshotsToUpload,
          );
          const response = await this.request({
              method: "health.upload",
              params: { envelope },
            });
          const eventId = envelope.events[0]?.eventId;
          if (!eventId || !isWorkoutHealthEventAcknowledged(response, eventId)) {
            throw new Error("Phone did not acknowledge the workout health batch.");
          }
          this.state.pendingBatches = removeUploadedLiveWorkoutSnapshots(
            { batches: this.state.pendingBatches },
            batch.externalId,
            snapshotsToUpload,
          ).batches;
          writeLiveWorkoutBuffer({ batches: this.state.pendingBatches });
        }
        this.state.statusWidget?.setProperty(prop.TEXT, "Live workout data synced");
      } catch (error: unknown) {
        writeLiveWorkoutBuffer({ batches: this.state.pendingBatches });
        this.reportError(error, "workout-upload");
      } finally {
        this.state.flushing = false;
      }
    },

    startCollection() {
      if (this.state.intervalId !== null) return;
      void this.collectSnapshot();
      this.state.intervalId = setInterval(() => void this.collectSnapshot(), SAMPLE_INTERVAL_MS);
    },

    stopCollection() {
      if (this.state.intervalId !== null) {
        clearInterval(this.state.intervalId);
        this.state.intervalId = null;
      }
      void this.flushSnapshots();
    },

    imuPath(slot: ImuFileSlot) {
      return slot === "A" ? WORKOUT_SESSION_FILE_A : WORKOUT_SESSION_FILE_B;
    },

    pendingImu(slot: ImuFileSlot) {
      return slot === "A" ? this.state.pendingImuA : this.state.pendingImuB;
    },

    setPendingImu(slot: ImuFileSlot, result: ImuSegmentResult | null) {
      if (slot === "A") {
        this.state.pendingImuA = result;
      } else {
        this.state.pendingImuB = result;
      }
      if (result) savePendingImuTransfer(WORKOUT_IMU_TRANSFER_FILE, { ...result, slot });
      else clearPendingImuTransfer(WORKOUT_IMU_TRANSFER_FILE, slot);
    },

    isImuTransferring(slot: ImuFileSlot) {
      return slot === "A" ? this.state.transferringImuA : this.state.transferringImuB;
    },

    setImuTransferring(slot: ImuFileSlot, transferring: boolean) {
      if (slot === "A") {
        this.state.transferringImuA = transferring;
      } else {
        this.state.transferringImuB = transferring;
      }
    },

    startImuSegment() {
      if (this.state.imuController?.active) return;
      const slot: ImuFileSlot | null = !this.state.pendingImuA
        ? "A"
        : !this.state.pendingImuB
          ? "B"
          : null;
      if (!slot) {
        this.state.statusWidget?.setProperty(
          prop.TEXT,
          "Workout metrics active\nMotion files waiting to send",
        );
        return;
      }

      const controller = createImuSessionController({
        path: this.imuPath(slot),
        requestedFreqModeIndex: 1,
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
          const installId = ensureInstallId(settings.settingsStorage);
          void deliverImuChunk(
            {
              connectionType: "zepp-workout",
              installId,
              segmentId: `${installId}:workout-imu:${sessionStartMs}`,
              sessionStartMs,
              hasGyroscope,
              samples,
            },
            (envelope) => this.request({ method: "imu.uploadChunk", params: { envelope } }),
          ).catch((error: unknown) => this.reportError(error, "workout-imu-chunk"));
        },
        onError: (error) => this.reportError(error, "workout-imu"),
      });
      if (!controller.available) {
        this.reportError(new Error(controller.reason ?? "IMU sensors are unavailable."), "workout-imu");
        return;
      }
      if (!controller.start()) return;
      this.state.activeImuSlot = slot;
      this.state.imuController = controller;
    },

    stopImuSegment() {
      const controller = this.state.imuController;
      if (!controller) return;
      this.state.imuController = null;
      const result = controller.stop();
      if (!result) return;
      const slot = this.state.activeImuSlot;
      this.setPendingImu(slot, result);
      this.sendImuSegment(result, slot);
    },

    sendImuSegment(result: ImuSegmentResult, slot: ImuFileSlot) {
      if (this.isImuTransferring(slot)) return;
      this.setImuTransferring(slot, true);
      let task: ReturnType<typeof this.sendFile>;
      try {
        const installId = ensureInstallId(settings.settingsStorage);
        task = this.sendFile(result.path, {
          type: "imu-session",
          source: "zepp-workout",
          segmentId: `${installId}:workout-imu:${result.sessionStartMs}`,
          sampleCount: String(result.sampleCount),
          observedHzX100: String(result.observedHzX100),
        });
      } catch (error) {
        this.setImuTransferring(slot, false);
        this.reportError(error, "workout-imu-transfer");
        return;
      }
      task.on("change", (event: { data: Record<string, unknown> }) => {
        const readyState = String(event.data.readyState);
        if (readyState === "transferred") {
          this.setImuTransferring(slot, false);
          this.setPendingImu(slot, null);
          if (this.state.focused && !this.state.imuController) {
            this.startImuSegment();
          }
        } else if (readyState === "error") {
          this.setImuTransferring(slot, false);
          this.reportError(new Error("Workout IMU transfer failed."), "workout-imu-transfer");
        }
      });
    },

    retryImuTransfers() {
      const pendingA = this.state.pendingImuA;
      if (pendingA && !this.state.transferringImuA) {
        this.sendImuSegment(pendingA, "A");
      }
      const pendingB = this.state.pendingImuB;
      if (pendingB && !this.state.transferringImuB) {
        this.sendImuSegment(pendingB, "B");
      }
    },

    onResume() {
      this.state.focused = true;
      this.retryImuTransfers();
      this.startCollection();
      this.startImuSegment();
    },

    onPause() {
      this.state.focused = false;
      this.stopImuSegment();
      this.stopCollection();
    },

    onDestroy() {
      this.state.focused = false;
      this.stopImuSegment();
      this.stopCollection();
    },
  }),
);
