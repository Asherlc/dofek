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
      // The device card owns connecting the monitor; buffering begins as soon
      // as it is connected, so there is nothing to start here.
    },

    async syncForTimeRange(_startedAt: string, _endedAt: string): Promise<void> {
      if (!ble.isAvailable()) return;

      const deviceId = ble.getDeviceId();
      if (!deviceId) return;

      const samples = await ble.peekBufferedSamples();
      if (samples.length === 0) return;

      for (let offset = 0; offset < samples.length; offset += UPLOAD_BATCH_SIZE) {
        const batch = samples.slice(offset, offset + UPLOAD_BATCH_SIZE);
        await trpcClient.bleHeartRateSync.pushSamples.mutate({ deviceId, samples: batch });
      }

      ble.confirmSamplesDrain(samples.length);
    },
  };
}
