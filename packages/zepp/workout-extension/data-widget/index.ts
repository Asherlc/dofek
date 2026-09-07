import { getSportData } from "@zos/app-access";
import { getDeviceInfo } from "@zos/device";
import {
  pauseDropWristScreenOff,
  resetDropWristScreenOff,
  resetPageBrightTime,
  setPageBrightTime,
} from "@zos/display";
import { Accelerometer, checkSensor, Gyroscope, HeartRate } from "@zos/sensor";
import { align, createWidget, deleteWidget, prop, text_style, widget } from "@zos/ui";
import { log as Logger, px } from "@zos/utils";
import { BasePage } from "@zeppos/zml/base-page";
import { isConnectionChangedCall } from "../../src/connection-control.ts";
import { createDisplayLease } from "../../src/display-lease.ts";
import { createImuCollector } from "../../src/imu-collector.ts";
import {
  type ImuTransferMonitor,
  monitorImuTransfer,
} from "../../src/imu-transfer-monitor.ts";
import {
  createImuSessionController,
  type ImuSegmentResult,
  type ImuSessionController,
} from "../../src/imu-session-controller.ts";
import {
  clearPendingImuTransfer,
  type ImuFileSlot,
  persistAndApplyPendingImuTransfer,
  readPendingImuTransfers,
  savePendingImuTransfer,
} from "../../src/imu-transfer-storage.ts";
import { ensureInstallId } from "../../src/install-id.ts";
import { appendSamples, finalizeSessionFile, resetSessionFile } from "../../src/session-file.ts";
import { confirmImuTransferPersistence } from "../../src/session-control.ts";
import { getImuTransferFailureReason } from "../../src/session-control.ts";
import {
  FLUSH_SAMPLE_THRESHOLD,
  WORKOUT_IMU_CHUNK_DIRECTORY,
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
import {
  createWatchImuChunkSync,
  type WatchImuChunkSync,
} from "../../src/watch-imu-chunk-sync.ts";

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
      connectionRequestId: 0,
      connectionMessage: nullable<string>(),
      workoutStatus: "Collecting live workout data",
      pairingQr: nullable<ReturnType<typeof createWidget>>(),
      pairingUrl: "",
      intervalId: nullable<ReturnType<typeof setInterval>>(),
      collecting: false,
      flushing: false,
      pendingBatches: emptyArray<LiveWorkoutBatch>(),
      statusWidget: nullable<ReturnType<typeof createWidget>>(),
      focused: false,
      imuController: nullable<ImuSessionController>(),
      imuChunkSync: nullable<WatchImuChunkSync>(),
      activeImuSlot: "A" as ImuFileSlot,
      pendingImuA: nullable<ImuSegmentResult>(),
      pendingImuB: nullable<ImuSegmentResult>(),
      transferringImuA: false,
      transferringImuB: false,
      imuTransferMonitorA: nullable<ImuTransferMonitor>(),
      imuTransferMonitorB: nullable<ImuTransferMonitor>(),
    },

    build() {
      this.state.imuChunkSync = createWatchImuChunkSync(
        WORKOUT_IMU_CHUNK_DIRECTORY,
        (envelope) => this.request({ method: "imu.uploadChunk", params: { envelope } }),
      );
      void this.state.imuChunkSync
        .retry()
        .catch((error: unknown) => this.reportError(error, "workout-imu-chunk-retry"));
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
        w: getDeviceInfo().width - px(40),
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
        w: getDeviceInfo().width - px(40),
        h: px(80),
        color: 0x9ca3af,
        text_size: px(26),
        align_h: align.CENTER_H,
        text_style: text_style.WRAP,
        text: "Collecting live workout data",
      });
      this.state.focused = true;
      void this.refreshConnection();
      this.startCollection();
      this.retryImuTransfers();
      this.startImuSegment();
    },

    setWorkoutStatus(status: string) {
      this.state.workoutStatus = status;
      if (this.state.connectionMessage === null) {
        this.state.statusWidget?.setProperty(prop.TEXT, status);
      }
    },

    clearPairing() {
      if (this.state.pairingQr) deleteWidget(this.state.pairingQr);
      this.state.pairingQr = null;
      this.state.pairingUrl = "";
    },

    async refreshConnection(startPairingIfNeeded = true) {
      if (!this.state.focused) return;
      const requestId = ++this.state.connectionRequestId;
      this.state.connectionMessage = "Checking Dofek connection";
      this.state.statusWidget?.setProperty(prop.TEXT, this.state.connectionMessage);
      try {
        const preferences = await this.request({ method: "imu.getPreferences", params: {} });
        if (requestId !== this.state.connectionRequestId) return;
        if (preferences?.hasCredentials === true) {
          this.clearPairing();
          this.state.connectionMessage = null;
          this.setWorkoutStatus(this.state.workoutStatus);
          return;
        }
        let pairing = preferences?.pairing;
        if (!pairing && startPairingIfNeeded && preferences?.canStartConnection === true) {
          pairing = await this.request({ method: "dofek.startPairing", params: {} });
          if (requestId !== this.state.connectionRequestId) return;
        }
        const verificationUrl =
          pairing && typeof pairing === "object" && "verificationUrl" in pairing &&
          typeof pairing.verificationUrl === "string" ? pairing.verificationUrl : "";
        const shortCode =
          pairing && typeof pairing === "object" && "shortCode" in pairing &&
          typeof pairing.shortCode === "string" ? pairing.shortCode : "";
        if (verificationUrl && shortCode) {
          if (this.state.pairingUrl !== verificationUrl) {
            this.clearPairing();
            const size = px(120);
            const x = Math.floor((getDeviceInfo().width - size) / 2);
            const y = px(260);
            this.state.pairingQr = createWidget(widget.QRCODE, {
              content: verificationUrl,
              x,
              y,
              w: size,
              h: size,
              bg_x: x - px(8),
              bg_y: y - px(8),
              bg_w: size + px(16),
              bg_h: size + px(16),
            });
            this.state.pairingUrl = verificationUrl;
          }
          this.state.connectionMessage = `Scan QR to pair\nCode ${shortCode}`;
        } else {
          this.clearPairing();
          this.state.connectionMessage = "Not paired\nOpen Dofek Workout settings in Zepp";
        }
        this.state.statusWidget?.setProperty(prop.TEXT, this.state.connectionMessage);
      } catch (error) {
        if (requestId !== this.state.connectionRequestId) return;
        this.reportError(error, "workout-pairing");
        this.clearPairing();
        const reason = error instanceof Error ? error.message : String(error);
        this.state.connectionMessage = `${reason}\nOpen Zepp settings to pair`;
        this.state.statusWidget?.setProperty(prop.TEXT, this.state.connectionMessage);
      }
    },

    onCall(payload: { method: string; params?: Record<string, unknown> } | null) {
      if (isConnectionChangedCall(payload)) void this.refreshConnection(false);
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
        this.setWorkoutStatus(
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
        this.setWorkoutStatus("Live workout data synced");
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
      persistAndApplyPendingImuTransfer(
        WORKOUT_IMU_TRANSFER_FILE,
        slot,
        result,
        (persisted) => {
          if (slot === "A") this.state.pendingImuA = persisted;
          else this.state.pendingImuB = persisted;
        },
        (error) => this.reportError(error, "discard-corrupt-imu-manifest"),
      );
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

    setImuTransferMonitor(slot: ImuFileSlot, monitor: ImuTransferMonitor | null) {
      if (slot === "A") this.state.imuTransferMonitorA = monitor;
      else this.state.imuTransferMonitorB = monitor;
    },

    startImuSegment() {
      if (this.state.imuController?.active) return;
      const slot: ImuFileSlot | null = !this.state.pendingImuA
        ? "A"
        : !this.state.pendingImuB
          ? "B"
          : null;
      if (!slot) {
        this.setWorkoutStatus(
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
          const sync = this.state.imuChunkSync;
          if (!sync) throw new Error("Workout IMU chunk sync is unavailable.");
          void sync
            .enqueue(
            {
              connectionType: "zepp-workout",
              installId,
              segmentId: `${installId}:workout-imu:${sessionStartMs}`,
              sessionStartMs,
              hasGyroscope,
              samples,
            },
            )
            .catch((error: unknown) => this.reportError(error, "workout-imu-chunk"));
        },
        onError: (error) => {
          this.state.imuController = null;
          this.reportError(error, "workout-imu");
        },
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

    handleImuTransferFailure(result: ImuSegmentResult, slot: ImuFileSlot, cause: unknown) {
      this.setImuTransferring(slot, false);
      const reason = cause instanceof Error ? cause.message : String(cause);
      const error = cause instanceof Error ? cause : new Error(reason);
      const installId = ensureInstallId(settings.settingsStorage);
      const segmentId = `${installId}:workout-imu:${result.sessionStartMs}`;
      this.reportError(error, "workout-imu-transfer");
      void this.request({
        method: "imu.transferFailed",
        params: { reason, segmentId, source: "zepp-workout" },
      }).catch((reportError: unknown) =>
        this.reportError(reportError, "workout-imu-transfer-status"),
      );
    },

    sendImuSegment(result: ImuSegmentResult, slot: ImuFileSlot) {
      if (this.isImuTransferring(slot)) return;
      this.setImuTransferring(slot, true);
      const installId = ensureInstallId(settings.settingsStorage);
      const segmentId = `${installId}:workout-imu:${result.sessionStartMs}`;
      let task: ReturnType<typeof this.sendFile>;
      try {
        task = this.sendFile(result.path, {
          type: "imu-session",
          source: "zepp-workout",
          segmentId,
          sampleCount: String(result.sampleCount),
          observedHzX100: String(result.observedHzX100),
        });
      } catch (error) {
        this.handleImuTransferFailure(result, slot, error);
        return;
      }
      this.setImuTransferMonitor(
        slot,
        monitorImuTransfer(task, {
          confirm: () =>
            confirmImuTransferPersistence(
            { sampleCount: result.sampleCount, segmentId, source: "zepp-workout" },
            (payload) => this.request(payload),
            ),
          failureReason: (data) =>
            getImuTransferFailureReason(data, "Workout IMU transfer failed."),
          onConfirmed: () => {
            this.setImuTransferMonitor(slot, null);
            this.setImuTransferring(slot, false);
            this.setPendingImu(slot, null);
            if (this.state.focused && !this.state.imuController) this.startImuSegment();
          },
          onFailed: (error) => {
            this.setImuTransferMonitor(slot, null);
            this.handleImuTransferFailure(result, slot, error);
          },
        }),
      );
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
      void this.refreshConnection();
      void this.state.imuChunkSync
        ?.retry()
        .catch((error: unknown) => this.reportError(error, "workout-imu-chunk-retry"));
      this.retryImuTransfers();
      this.startCollection();
      this.startImuSegment();
    },

    onPause() {
      this.state.focused = false;
      this.state.connectionRequestId++;
      this.stopImuSegment();
      this.stopCollection();
    },

    onDestroy() {
      this.clearPairing();
      this.state.focused = false;
      this.state.connectionRequestId++;
      this.state.imuTransferMonitorA?.cancel();
      this.state.imuTransferMonitorB?.cancel();
      this.state.imuTransferMonitorA = null;
      this.state.imuTransferMonitorB = null;
      this.stopImuSegment();
      this.stopCollection();
    },
  }),
);
