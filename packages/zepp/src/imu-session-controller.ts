import type { DisplayLease } from "./display-lease.ts";
import type { CollectorOptions, ImuCollector, ImuSample, SessionFileMeta } from "./types.ts";

export interface ImuSegmentResult {
  path: string;
  sampleCount: number;
  observedHzX100: number;
  hasGyroscope: boolean;
  accelFreqMode: number;
  gyroFreqMode: number;
  sessionStartMs: number;
}

interface ImuSessionControllerOptions {
  path: string;
  requestedFreqModeIndex: number;
  flushThreshold: number;
  now(): number;
  displayLease: DisplayLease;
  createCollector(options: CollectorOptions): ImuCollector;
  file: {
    reset(meta: SessionFileMeta, path: string): void;
    append(samples: ImuSample[], hasGyro: boolean, path: string): void;
    finalize(sampleCount: number, observedHzX100: number, path: string): void;
  };
  onChunk?(chunk: { sessionStartMs: number; hasGyroscope: boolean; samples: ImuSample[] }): void;
  onProgress?(stats: { sampleCount: number; observedHzX100: number }): void;
  onError(error: unknown): void;
}

export interface ImuSessionController {
  readonly active: boolean;
  readonly available: boolean;
  readonly reason: string | null;
  readonly hasGyroscope: boolean;
  readonly accelFreqMode: number;
  readonly gyroFreqMode: number;
  readonly sampleCount: number;
  readonly observedHzX100: number;
  start(): boolean;
  rotate(nextPath: string): ImuSegmentResult | null;
  stop(): ImuSegmentResult | null;
}

export function createImuSessionController(
  options: ImuSessionControllerOptions,
): ImuSessionController {
  let active = false;
  let path = options.path;
  let sessionStartMs = 0;
  let sampleCount = 0;
  let observedHzX100 = 0;
  let pending: ImuSample[] = [];

  const collector = options.createCollector({
    requestedFreqModeIndex: options.requestedFreqModeIndex,
    onSample(sample) {
      if (!active) return;
      pending.push(sample);
      sampleCount += 1;
      if (pending.length >= options.flushThreshold) {
        try {
          flush(false);
        } catch (error) {
          fail(error);
        }
      }
    },
    onStatus(stats) {
      if (!active) return;
      observedHzX100 = stats.observedHzX100;
      options.onProgress?.({ sampleCount, observedHzX100 });
    },
  });

  const ready = collector.available ? collector : null;
  const unavailableReason = collector.available ? null : collector.reason;

  function meta(): SessionFileMeta {
    if (!ready) {
      throw new Error(unavailableReason ?? "IMU sensors are unavailable.");
    }
    return {
      hasGyro: ready.hasGyroscope,
      sessionStartMs,
      sampleCount,
      accelFreqMode: ready.accelMode,
      gyroFreqMode: ready.gyroMode ?? 0,
      observedHzX100,
    };
  }

  function result(): ImuSegmentResult {
    const current = meta();
    return {
      path,
      sampleCount,
      observedHzX100,
      hasGyroscope: current.hasGyro,
      accelFreqMode: current.accelFreqMode,
      gyroFreqMode: current.gyroFreqMode,
      sessionStartMs,
    };
  }

  function flush(finalize: boolean): void {
    if (pending.length > 0 && ready) {
      const samples = pending;
      options.file.append(samples, ready.hasGyroscope, path);
      pending = [];
      options.onChunk?.({ sessionStartMs, hasGyroscope: ready.hasGyroscope, samples });
    }
    if (finalize) {
      options.file.finalize(sampleCount, observedHzX100, path);
    }
  }

  function releaseDisplay(): void {
    try {
      options.displayLease.release();
    } catch (error) {
      options.onError(error);
    }
  }

  function fail(error: unknown): void {
    active = false;
    try {
      ready?.stop();
    } catch (stopError) {
      options.onError(stopError);
    } finally {
      pending = [];
      releaseDisplay();
    }
    options.onError(error);
  }

  return {
    get active() {
      return active;
    },
    available: ready !== null,
    reason: unavailableReason,
    hasGyroscope: ready?.hasGyroscope ?? false,
    accelFreqMode: ready?.accelMode ?? 0,
    gyroFreqMode: ready?.gyroMode ?? 0,
    get sampleCount() {
      return sampleCount;
    },
    get observedHzX100() {
      return observedHzX100;
    },
    start() {
      if (active) return true;
      if (!ready) return false;
      try {
        options.displayLease.acquire();
        sessionStartMs = options.now();
        sampleCount = 0;
        observedHzX100 = 0;
        pending = [];
        options.file.reset(meta(), path);
        active = true;
        ready.start();
        return true;
      } catch (error) {
        active = false;
        try {
          ready.stop();
        } catch (stopError) {
          options.onError(stopError);
        } finally {
          releaseDisplay();
        }
        options.onError(error);
        return false;
      }
    },
    rotate(nextPath) {
      if (!active || !ready) return null;
      try {
        flush(true);
        const completed = result();
        path = nextPath;
        sessionStartMs = options.now();
        sampleCount = 0;
        observedHzX100 = 0;
        pending = [];
        options.file.reset(meta(), path);
        return completed;
      } catch (error) {
        fail(error);
        return null;
      }
    },
    stop() {
      if (!active || !ready) return null;
      active = false;
      let stopFailed = false;
      let completed: ImuSegmentResult | null = null;
      try {
        try {
          ready.stop();
        } catch (error) {
          stopFailed = true;
          options.onError(error);
        }
        try {
          flush(true);
          completed = result();
        } catch (error) {
          options.onError(error);
          return null;
        }
      } finally {
        releaseDisplay();
      }
      return stopFailed ? null : completed;
    },
  };
}
