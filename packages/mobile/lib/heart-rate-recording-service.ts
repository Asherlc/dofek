import type { BleHeartRateSample } from "../modules/ble-heart-rate";
import type { RecordingSensorService } from "./recording-sensor-service.ts";

const UPLOAD_BATCH_SIZE = 5000;

/** Abstraction over the BLE heart-rate module for activity recording. */
export interface HeartRateBleDeps {
  /** Whether Bluetooth is available on the device. */
  isAvailable(): boolean;
  /** The connected monitor's peripheral ID, or null when not connected. */
  getDeviceId(): string | null;
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
        samples: BleHeartRateSample[];
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
 * Connection and live display are driven by the UI (the device card), which
 * connects the strap and starts the native buffer filling. This service is the
 * upload half: on activity save it drains the buffered samples and pushes them
 * to the server, committing the drain only after a successful upload so a
 * failure leaves the samples in place for retry.
 */
export function createHeartRateRecordingService(
  deps: HeartRateRecordingServiceDeps,
): RecordingSensorService {
  const { ble, trpcClient } = deps;

  return {
    async ensureRecording(): Promise<void> {
      // The device card owns connecting the monitor. Discard anything buffered
      // before this activity started so the upload reflects only the current
      // recording window. Draining reads the local buffer and needs no active
      // connection, so run it regardless of the current Bluetooth state.
      for (;;) {
        const stale = await ble.peekBufferedSamples();
        if (stale.length === 0) break;
        ble.confirmSamplesDrain(stale.length);
      }
    },

    async syncForTimeRange(_startedAt: string, endedAt: string): Promise<void> {
      if (!ble.isAvailable()) return;

      const deviceId = ble.getDeviceId();
      if (!deviceId) return;

      // Samples are buffered in arrival (chronological) order. Drain page by
      // page — uploading only samples within the activity window — and stop at
      // the first sample past endedAt so a still-connected strap's live stream
      // is not chased into this activity. Pre-window samples were cleared on
      // start. The native peek returns a bounded page, so the loop also lets a
      // long session upload every in-window sample rather than just the first
      // page. Each page is committed only after its upload succeeds.
      for (;;) {
        const page = await ble.peekBufferedSamples();
        if (page.length === 0) break;

        const inWindow = page.filter((sample) => sample.timestamp <= endedAt);
        for (let offset = 0; offset < inWindow.length; offset += UPLOAD_BATCH_SIZE) {
          const batch = inWindow.slice(offset, offset + UPLOAD_BATCH_SIZE);
          await trpcClient.bleHeartRateSync.pushSamples.mutate({ deviceId, samples: batch });
        }

        ble.confirmSamplesDrain(inWindow.length);

        // A shorter in-window slice means this page crossed endedAt — stop and
        // leave the post-window samples buffered.
        if (inWindow.length < page.length) break;
      }
    },
  };
}
