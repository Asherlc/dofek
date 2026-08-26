import type { RecordingSensorService } from "./recording-sensor-service.ts";
import { captureException } from "./telemetry";

export type RecordingState = "idle" | "recording" | "paused" | "saving" | "error";

export interface RecordingSnapshot {
  state: RecordingState;
  activityType: string | null;
  elapsedMs: number;
  error: string | null;
}

export interface RecordingTrpcClient {
  activityRecording: {
    save: {
      mutate(input: {
        activityType: string;
        startedAt: string;
        endedAt: string;
        name: string | null;
        notes: string | null;
        sourceName: string;
      }): Promise<{ activityId: string }>;
    };
  };
}

export interface ActivityRecorder {
  getSnapshot(): RecordingSnapshot;
  start(activityType: string): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  stop(): void;
  save(name: string | null, notes: string | null): Promise<string>;
  discard(): void;
  onUpdate(callback: () => void): () => void;
}

export function createActivityRecorder(
  trpcClient: RecordingTrpcClient,
  sourceName: string,
  sensorService?: RecordingSensorService,
): ActivityRecorder {
  let state: RecordingState = "idle";
  let activityType: string | null = null;
  let startTime: number | null = null;
  let stoppedAt: number | null = null;
  let pauseStart: number | null = null;
  let totalPausedMs = 0;
  let error: string | null = null;
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of listeners) listener();
  }

  function getElapsedMs(): number {
    if (startTime === null) return 0;
    const now = stoppedAt ?? Date.now();
    const paused = pauseStart !== null ? now - pauseStart : 0;
    return now - startTime - totalPausedMs - paused;
  }

  function reset() {
    state = "idle";
    activityType = null;
    startTime = null;
    stoppedAt = null;
    pauseStart = null;
    totalPausedMs = 0;
    error = null;
  }

  return {
    getSnapshot(): RecordingSnapshot {
      return { state, activityType, elapsedMs: getElapsedMs(), error };
    },

    async start(type: string) {
      if (state !== "idle") return;

      activityType = type;
      stoppedAt = null;
      totalPausedMs = 0;
      pauseStart = null;
      error = null;
      startTime = Date.now();
      state = "recording";
      notify();

      sensorService?.ensureRecording().catch((sensorError: unknown) => {
        captureException(sensorError, { source: "activity-recording" });
      });
    },

    pause() {
      if (state !== "recording") return;
      state = "paused";
      pauseStart = Date.now();
      notify();
    },

    async resume() {
      if (state !== "paused") return;
      if (pauseStart !== null) {
        totalPausedMs += Date.now() - pauseStart;
        pauseStart = null;
      }
      error = null;
      state = "recording";
      notify();
    },

    stop() {
      if (state !== "recording" && state !== "paused") return;
      stoppedAt = Date.now();
      if (pauseStart !== null) {
        totalPausedMs += stoppedAt - pauseStart;
        pauseStart = null;
      }
      state = "saving";
      notify();
    },

    async save(name: string | null, notes: string | null): Promise<string> {
      if (state !== "saving" || !activityType || startTime === null || stoppedAt === null) {
        throw new Error(`Cannot save in state: ${state}`);
      }

      const startedAt = new Date(startTime).toISOString();
      const endedAt = new Date(stoppedAt).toISOString();

      try {
        const result = await trpcClient.activityRecording.save.mutate({
          activityType,
          startedAt,
          endedAt,
          name,
          notes,
          sourceName,
        });

        try {
          await sensorService?.syncForTimeRange(startedAt, endedAt);
        } catch (sensorError) {
          captureException(sensorError, { source: "activity-recording.syncForTimeRange" });
        }

        reset();
        notify();
        return result.activityId;
      } catch (saveError) {
        state = "error";
        error = saveError instanceof Error ? saveError.message : "Failed to save activity";
        notify();
        throw saveError;
      }
    },

    discard() {
      reset();
      notify();
    },

    onUpdate(callback: () => void): () => void {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}
