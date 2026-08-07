import type { InertialMeasurementUnitSample } from "@dofek/imu";
import { captureException } from "./telemetry";

const TWELVE_HOURS_SECONDS = 12 * 3600;
const UPLOAD_BATCH_SIZE = 5000;

/** Abstraction over CoreMotion native module for activity recording */
export interface CoreMotionDeps {
  isAccelerometerRecordingAvailable(): boolean;
  startRecording(durationSeconds: number): Promise<boolean>;
  queryRecordedData(fromDate: string, toDate: string): Promise<InertialMeasurementUnitSample[]>;
}

/** Abstraction over Watch motion module for activity recording */
export interface WatchDeps {
  isAvailable(): boolean;
  requestSync(): Promise<boolean>;
  syncPendingFiles(): Promise<void>;
}

/** Abstraction over WHOOP BLE module for IMU streaming during activity recording */
export interface WhoopBleDeps {
  isAvailable(): boolean;
  findAndConnect(): Promise<boolean>;
  startStreaming(): Promise<boolean>;
  stopStreaming(): Promise<boolean>;
  peekBufferedSamples(): Promise<InertialMeasurementUnitSample[]>;
  confirmSamplesDrain(count: number): void;
}

/** tRPC client interface for IMU sample upload */
export interface InertialMeasurementUnitUploadClient {
  inertialMeasurementUnitSync: {
    pushSamples: {
      mutate(input: {
        deviceId: string;
        deviceType: string;
        samples: InertialMeasurementUnitSample[];
      }): Promise<{ inserted: number }>;
    };
  };
}

export interface InertialMeasurementUnitServiceDeps {
  coreMotion: CoreMotionDeps;
  watch: WatchDeps;
  whoopBle?: WhoopBleDeps;
  trpcClient: InertialMeasurementUnitUploadClient;
  deviceId: string;
}

/** Service for managing IMU recording during activity recording */
export interface InertialMeasurementUnitService {
  /** Ensure phone + watch accelerometer recording is active */
  ensureRecording(): Promise<void>;
  /** Sync IMU data for a specific time range (after activity save) */
  syncForTimeRange(startedAt: string, endedAt: string): Promise<void>;
}

/**
 * Create an IMU service that manages phone + watch accelerometer
 * recording during activity recording.
 *
 * - `ensureRecording()` starts a CoreMotion session and requests Watch sync
 * - `syncForTimeRange()` queries and uploads IMU data for the activity window
 *
 * All operations are best-effort — errors are caught to avoid disrupting
 * the GPS recording or activity save.
 */
export function createInertialMeasurementUnitService(
  deps: InertialMeasurementUnitServiceDeps,
): InertialMeasurementUnitService {
  const { coreMotion, watch, whoopBle, trpcClient, deviceId } = deps;

  async function uploadBatched(
    uploadDeviceId: string,
    deviceType: string,
    samples: InertialMeasurementUnitSample[],
  ): Promise<void> {
    for (let offset = 0; offset < samples.length; offset += UPLOAD_BATCH_SIZE) {
      const batch = samples.slice(offset, offset + UPLOAD_BATCH_SIZE);
      await trpcClient.inertialMeasurementUnitSync.pushSamples.mutate({
        deviceId: uploadDeviceId,
        deviceType,
        samples: batch,
      });
    }
  }

  return {
    async ensureRecording(): Promise<void> {
      // Start phone accelerometer (best-effort)
      if (coreMotion.isAccelerometerRecordingAvailable()) {
        try {
          await coreMotion.startRecording(TWELVE_HOURS_SECONDS);
        } catch (error: unknown) {
          captureException(error, {
            source: "activity-recording-core-motion-start",
          });
          // Best-effort — don't block activity recording
        }
      }

      // Request Watch data transfer (best-effort)
      if (watch.isAvailable()) {
        try {
          await watch.requestSync();
        } catch (error: unknown) {
          captureException(error, { source: "activity-recording-watch-sync" });
          // Best-effort — Watch may not be reachable
        }
      }

      // Connect to WHOOP strap and start IMU streaming (best-effort)
      if (whoopBle?.isAvailable()) {
        let connected = false;
        try {
          connected = await whoopBle.findAndConnect();
        } catch (error: unknown) {
          captureException(error, { source: "activity-recording-whoop-connect" });
          // Best-effort — WHOOP may not be nearby or BLE unavailable
        }
        if (connected) {
          try {
            await whoopBle.startStreaming();
          } catch (error: unknown) {
            captureException(error, {
              source: "activity-recording-whoop-start-streaming",
            });
            // Best-effort — WHOOP streaming may be unavailable
          }
        }
      }
    },

    async syncForTimeRange(startedAt: string, endedAt: string): Promise<void> {
      // Sync phone accelerometer data for the activity window
      if (coreMotion.isAccelerometerRecordingAvailable()) {
        try {
          const phoneSamples = await coreMotion.queryRecordedData(startedAt, endedAt);
          if (phoneSamples.length > 0) {
            await uploadBatched(deviceId, "iphone", phoneSamples);
          }
        } catch (error: unknown) {
          captureException(error, { source: "activity-save-core-motion-sync" });
          // Best-effort — don't fail activity save
        }
      }

      // Sync Watch accelerometer and altitude files through their per-file
      // pipelines so only files whose complete upload succeeded are deleted.
      if (watch.isAvailable()) {
        try {
          await watch.syncPendingFiles();
        } catch (error: unknown) {
          captureException(error, { source: "activity-save-watch-sync" });
          // Best-effort — don't fail activity save
        }
      }

      // Peek and upload WHOOP BLE IMU samples, then drain only after the server
      // acknowledges every batch so failed uploads can be retried.
      if (whoopBle?.isAvailable()) {
        let bufferedSampleCount = 0;
        try {
          const whoopSamples = await whoopBle.peekBufferedSamples();
          bufferedSampleCount = whoopSamples.length;
          if (whoopSamples.length > 0) {
            await uploadBatched("WHOOP Strap", "whoop", whoopSamples);
            whoopBle.confirmSamplesDrain(whoopSamples.length);
          }
          await whoopBle.stopStreaming();
        } catch (error: unknown) {
          captureException(error, {
            source: "activity-save-whoop-imu-upload",
            bufferedSampleCount,
          });
          // Best-effort — don't fail activity save
        }
      }
    },
  };
}
