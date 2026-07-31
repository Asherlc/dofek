import { getSportData } from "@zos/app-access";
import { HeartRate } from "@zos/sensor";
import { align, createWidget, prop, text_style, widget } from "@zos/ui";
import { log as Logger, px } from "@zos/utils";
import { BasePage } from "@zeppos/zml/base-page";
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
    },

    build() {
      const persistedBuffer = readLiveWorkoutBuffer();
      this.state.pendingBatches = persistedBuffer.batches;
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
      this.startCollection();
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
        logger.error("live workout collection failed %j", error);
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
          const durationSeconds = latestSnapshot.metrics.duration ?? 0;
          const startedAt = new Date(Number(batch.externalId) * 1000).toISOString();
          const endedAt = new Date(
            Number(batch.externalId) * 1000 + durationSeconds * 1000,
          ).toISOString();
          await this.request({
            method: "health.upload",
            params: {
              data: {
                activities: [
                  {
                    externalId: batch.externalId,
                    activityType: "other",
                    startedAt,
                    endedAt,
                    raw: {
                      liveSnapshotsByRecordedAt: Object.fromEntries(
                        snapshotsToUpload.map((snapshot) => [snapshot.recordedAt, snapshot]),
                      ),
                    },
                  },
                ],
                liveWorkoutSamples: snapshotsToUpload.map((snapshot) => ({
                  externalId: batch.externalId,
                  ...snapshot,
                })),
              },
            },
          });
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
        logger.error("live workout upload failed %j", error);
        void this.request({
          method: "telemetry.report",
          params: {
            message: error instanceof Error ? error.message : String(error),
            name: error instanceof Error ? error.name : "Error",
            stack: error instanceof Error ? error.stack : undefined,
            category: "workout-upload",
          },
        });
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

    onResume() {
      this.startCollection();
    },

    onPause() {
      this.stopCollection();
    },

    onDestroy() {
      this.stopCollection();
    },
  }),
);
