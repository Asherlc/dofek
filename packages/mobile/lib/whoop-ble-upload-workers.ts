import { loadDeviceErasureCutoff } from "./device-erasure-cutoff";
import { captureException } from "./telemetry";
import { drainWhoopImuBuffer, drainWhoopRealtimeBuffer } from "./whoop-ble-buffer-drain";
import type { WhoopBleDiagnostics, WhoopSyncTrigger } from "./whoop-ble-diagnostics";
import type {
  InertialMeasurementUnitUploadClient,
  WhoopBleRealtimeUploadClient,
  WhoopBleSyncDeps,
} from "./whoop-ble-sync-types";

type Stream = "imu" | "realtime";
interface NativePeekOwnership {
  owner: WhoopBleUploadWorkers;
  pending: Promise<unknown>;
  settled: boolean;
  release(): void;
}

// Native cursors outlive JS upload sessions. Only the native peek must settle
// before ownership can pass; an old HTTP request must not block a new session.
const nativeOwners = new Map<Stream, NativePeekOwnership>();

function releaseOwnership(stream: Stream, ownership: NativePeekOwnership): void {
  if (!ownership.settled || nativeOwners.get(stream) !== ownership) return;
  nativeOwners.delete(stream);
  try {
    ownership.release();
  } catch (error: unknown) {
    captureException(error, {
      source: "whoop-ble-release-native-peek",
      stream,
      retiredLifetime: !ownership.owner.active,
    });
  }
}

/** Owns upload workers, background permission, and native cursors for one lifetime. */
export class WhoopBleUploadWorkers {
  #active = true;
  #backgroundRefreshes = 0;
  readonly #drains = new Map<Stream, Promise<void>>();
  readonly #deps: WhoopBleSyncDeps;
  readonly #client: InertialMeasurementUnitUploadClient;
  readonly #diagnostics: WhoopBleDiagnostics;

  constructor(
    client: InertialMeasurementUnitUploadClient,
    deps: WhoopBleSyncDeps,
    diagnostics: WhoopBleDiagnostics,
  ) {
    this.#client = client;
    this.#diagnostics = diagnostics;
    this.#deps = {
      ...deps,
      peekBufferedSamples: (count) =>
        this.#peek(
          "imu",
          () => deps.peekBufferedSamples(count),
          () => deps.confirmSamplesDrain(0),
        ),
      peekBufferedRealtimeData: (count) =>
        this.#peek(
          "realtime",
          () => deps.peekBufferedRealtimeData(count),
          () => deps.confirmRealtimeDataDrain(0),
        ),
      confirmSamplesDrain: (count) => this.#confirm("imu", () => deps.confirmSamplesDrain(count)),
      confirmRealtimeDataDrain: (count) =>
        this.#confirm("realtime", () => deps.confirmRealtimeDataDrain(count)),
    };
  }

  get active(): boolean {
    return this.#active;
  }

  authorizeBackgroundRefresh(): () => void {
    this.#backgroundRefreshes += 1;
    return () => {
      this.#backgroundRefreshes -= 1;
    };
  }

  retire(): void {
    this.#active = false;
    for (const [stream, ownership] of nativeOwners) {
      if (ownership.owner === this) releaseOwnership(stream, ownership);
    }
  }

  async #peek<T>(stream: Stream, peek: () => Promise<T[]>, release: () => void): Promise<T[]> {
    const previous = nativeOwners.get(stream);
    if (previous && previous.owner !== this) {
      await Promise.allSettled([previous.pending]);
      if (!this.#active) return [];
      releaseOwnership(stream, previous);
    }
    if (!this.#active) return [];

    const pending = Promise.resolve().then(() => (this.#active ? peek() : []));
    const ownership: NativePeekOwnership = { owner: this, pending, settled: false, release };
    nativeOwners.set(stream, ownership);
    const settled = () => {
      ownership.settled = true;
      if (!this.#active) releaseOwnership(stream, ownership);
    };
    void pending.then(settled, settled);
    return pending;
  }

  #confirm(stream: Stream, confirm: () => void): void {
    const ownership = nativeOwners.get(stream);
    if (!this.#active || ownership?.owner !== this) return;
    confirm();
    if (nativeOwners.get(stream) === ownership) nativeOwners.delete(stream);
  }

  async drain(
    realtimeClient: WhoopBleRealtimeUploadClient | undefined,
    shouldContinueUploading: () => boolean,
    trigger: WhoopSyncTrigger,
  ): Promise<void> {
    const cutoff = await loadDeviceErasureCutoff();
    if (!this.#active) return;
    const canUpload = () =>
      this.#active && (this.#backgroundRefreshes > 0 || shouldContinueUploading());
    const drains = [
      this.#run("imu", trigger, () =>
        drainWhoopImuBuffer(
          this.#client,
          this.#deps,
          cutoff,
          canUpload,
          trigger,
          this.#diagnostics,
          () => this.#active,
        ),
      ),
    ];
    if (realtimeClient) {
      drains.push(
        this.#run("realtime", trigger, () =>
          drainWhoopRealtimeBuffer(
            realtimeClient,
            this.#deps,
            cutoff,
            canUpload,
            trigger,
            this.#diagnostics,
            () => this.#active,
          ),
        ),
      );
    }
    const results = await Promise.allSettled(drains);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "WHOOP BLE buffer drains failed");
    }
  }

  #run(stream: Stream, trigger: WhoopSyncTrigger, drain: () => Promise<void>): Promise<void> {
    const active = this.#drains.get(stream);
    if (active) {
      this.#diagnostics.workerJoined(stream, trigger);
      return active;
    }
    this.#diagnostics.workerStarted(stream, trigger);
    const pending = drain().finally(() => {
      const ownership = nativeOwners.get(stream);
      if (ownership?.owner === this) releaseOwnership(stream, ownership);
      if (this.#active) this.#diagnostics.workerFinished(stream);
      this.#drains.delete(stream);
    });
    this.#drains.set(stream, pending);
    return pending;
  }
}
