import { captureException } from "./telemetry";

/**
 * A sensor source that participates in activity recording: it starts capturing
 * when recording begins and uploads its data for the activity window on save.
 *
 * The activity recorder depends only on this interface, so new sensor sources
 * (phone/watch IMU, WHOOP strap, Bluetooth heart-rate monitor) can be added
 * without changing the recorder — open for extension, closed for modification.
 */
export interface RecordingSensorService {
  /** Ensure capture is active. Best-effort — must not throw. */
  ensureRecording(): Promise<void>;
  /** Upload captured data for the given activity window. Best-effort. */
  syncForTimeRange(startedAt: string, endedAt: string): Promise<void>;
}

/**
 * Fan a single {@link RecordingSensorService} out over several sources.
 *
 * Each source is isolated: a failure in one is reported to telemetry and does
 * not prevent the others from running, so (for example) a heart-rate upload
 * failure never blocks the accelerometer sync.
 */
export function combineRecordingSensorServices(
  services: RecordingSensorService[],
): RecordingSensorService {
  return {
    async ensureRecording(): Promise<void> {
      await Promise.all(
        services.map(async (service) => {
          try {
            await service.ensureRecording();
          } catch (error) {
            captureException(error, { source: "recording-sensor-service.ensureRecording" });
          }
        }),
      );
    },

    async syncForTimeRange(startedAt: string, endedAt: string): Promise<void> {
      await Promise.all(
        services.map(async (service) => {
          try {
            await service.syncForTimeRange(startedAt, endedAt);
          } catch (error) {
            captureException(error, { source: "recording-sensor-service.syncForTimeRange" });
          }
        }),
      );
    },
  };
}
