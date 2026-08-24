import type { BleHeartRateSample } from "../modules/ble-heart-rate";
import { isAfterDeviceErasureCutoff, loadDeviceErasureCutoff } from "./device-erasure-cutoff";
import { DeviceSampleGroups } from "./device-sample-groups.ts";
import type { RecordingSensorService } from "./recording-sensor-service.ts";

const UPLOAD_BATCH_SIZE = 5000;

type BleHeartRateUploadSample = Omit<BleHeartRateSample, "deviceId">;

function toBleHeartRateUploadSample(sample: BleHeartRateSample): BleHeartRateUploadSample {
  return {
    timestamp: sample.timestamp,
    heartRateBpm: sample.heartRateBpm,
    rrIntervalsMs: sample.rrIntervalsMs,
  };
}

/** Abstraction over the BLE heart-rate module for activity recording. */
export interface HeartRateBleDeps {
  /** Peek all buffered heart-rate samples without removing them. */
  peekBufferedSamples(): Promise<BleHeartRateSample[]>;
  /** Remove the first `count` samples after a successful upload. */
  confirmSamplesDrain(count: number): void;
}

/** tRPC client interface for heart-rate sample upload. */
export interface HeartRateUploadClient {
  bleHeartRateSync: {
    pushSamples: {
      mutate(input: {
        deviceId: string;
        samples: BleHeartRateUploadSample[];
      }): Promise<{ inserted: number }>;
    };
  };
}

export interface HeartRateRecordingServiceDeps {
  ble: HeartRateBleDeps;
  trpcClient: HeartRateUploadClient;
}

/**
 * Recording sensor service for a Bluetooth heart-rate monitor.
 *
 * The shared Bluetooth device manager owns connections and native buffering.
 * This service only drains buffered samples on activity save, uploading each
 * sample under the device ID captured with it and committing a drain only after
 * successful upload so failures remain retryable.
 */
export function createHeartRateRecordingService(
  deps: HeartRateRecordingServiceDeps,
): RecordingSensorService {
  const { ble, trpcClient } = deps;

  return {
    async ensureRecording(): Promise<void> {
      // No destructive drain here: syncForTimeRange filters by the activity
      // window at save, so pre-recording samples are dropped there without
      // racing against early in-window samples.
    },

    async syncForTimeRange(startedAt: string, endedAt: string): Promise<void> {
      const deviceErasureCutoff = await loadDeviceErasureCutoff();

      // Samples are buffered in arrival (chronological) order. Drain page by
      // page: drop everything at or before endedAt from the buffer, but upload
      // only the samples within [startedAt, endedAt]. Stopping at the first
      // sample past endedAt keeps a still-connected strap's live stream from
      // being chased into this activity. The native peek returns a bounded
      // page, so the loop also lets a long session upload every in-window
      // sample rather than just the first page. Each page is committed only
      // after its upload succeeds.
      for (;;) {
        const page = await ble.peekBufferedSamples();
        if (page.length === 0) break;

        const drainable = page.filter((sample) => sample.timestamp <= endedAt);
        const inWindow = drainable.filter(
          (sample) =>
            sample.timestamp >= startedAt &&
            (deviceErasureCutoff === null ||
              isAfterDeviceErasureCutoff(sample.timestamp, deviceErasureCutoff)),
        );
        const groups = new DeviceSampleGroups(null, toBleHeartRateUploadSample);
        for (const sample of inWindow) {
          groups.add(sample);
        }

        for (const [deviceId, samples] of groups.entries()) {
          for (let offset = 0; offset < samples.length; offset += UPLOAD_BATCH_SIZE) {
            const batch = samples.slice(offset, offset + UPLOAD_BATCH_SIZE);
            await trpcClient.bleHeartRateSync.pushSamples.mutate({ deviceId, samples: batch });
          }
        }

        ble.confirmSamplesDrain(drainable.length);

        // A shorter drainable slice means this page crossed endedAt — stop and
        // leave the post-window samples buffered.
        if (drainable.length < page.length) break;
      }
    },
  };
}
