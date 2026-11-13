import * as Crypto from "expo-crypto";
import * as Network from "expo-network";
import { AppState } from "react-native";
import {
  addHealthKitSyncExpirationListener,
  completeHealthKitSync,
  startHealthKitSync,
  updateHealthKitSyncProgress,
} from "../modules/background-refresh";
import { AppleHealthSyncService } from "./apple-health-provider";
import {
  isBackgroundHealthKitTransientNetworkError,
  isHealthKitDatabaseInaccessible,
} from "./health-kit-errors";
import {
  clearManualHealthKitCheckpoint,
  InvalidManualHealthKitCheckpointError,
  loadManualHealthKitCheckpoint,
  type ManualHealthKitCheckpoint,
  purgeManualHealthKitCheckpoint,
  saveManualHealthKitCheckpoint,
} from "./health-kit-manual-checkpoint";
import { MANUAL_HEALTH_KIT_SYNC_STAGES } from "./health-kit-sync";
import {
  type HealthKitManualSyncOwner,
  type HealthKitManualSyncState,
  ManualHealthKitSyncInterruptedError,
  type SyncResult,
  type SyncTrpcClient,
} from "./health-kit-sync-types";
import { captureException } from "./telemetry";

const INITIAL_STATE: HealthKitManualSyncState = {
  status: "idle",
  message: null,
  completedStageCount: 0,
  totalStageCount: 0,
  error: null,
};

export interface HealthKitManualSyncDependencies {
  loadCheckpoint(userId: string): Promise<ManualHealthKitCheckpoint | null>;
  saveCheckpoint(checkpoint: ManualHealthKitCheckpoint): Promise<void>;
  clearCheckpoint(userId: string, requestId: string): Promise<void>;
  purgeCheckpoint(userId: string): Promise<void>;
  startNative(taskId: string): Promise<{ supported: boolean }>;
  completeNative(taskId: string, success: boolean): void;
  listenForExpiration(listener: (taskId: string) => void): { remove(): void };
  listenForAppState(listener: (state: string) => void): { remove(): void };
  isForeground(): boolean;
  waitUntilForegroundConnected(signal: AbortSignal, requireNewActivation?: boolean): Promise<void>;
  runSync(
    input: Parameters<AppleHealthSyncService["syncManualCheckpointed"]>[0] & {
      manualExecution: NonNullable<
        Parameters<AppleHealthSyncService["syncManualCheckpointed"]>[0]["manualExecution"]
      >;
    },
  ): Promise<SyncResult>;
  recordOutcome(
    result: SyncResult | null,
    error: unknown | null,
    durationMs: number,
  ): Promise<void>;
  updateProgress(taskId: string, completed: number, total: number, message: string): void;
  createId(): string;
}

type Options = {
  userId: string;
  trpcClient: SyncTrpcClient;
  deps?: HealthKitManualSyncDependencies;
};

type ManualAttempt = {
  taskId: string;
  abort: AbortController;
  interrupted: boolean;
  expired: boolean;
  recovering: boolean;
  nativeCompletionSent: boolean;
  supported: boolean;
  activeUpload: boolean;
  activeUploadCrossedBackground: boolean;
  promise: Promise<SyncResult>;
};

function isExpectedManualSyncInterruption(error: unknown): boolean {
  return (
    error instanceof ManualHealthKitSyncInterruptedError || isHealthKitDatabaseInaccessible(error)
  );
}

function isExpectedOrRetryableManualAttemptError(error: unknown, transient: boolean): boolean {
  return isExpectedManualSyncInterruption(error) || transient;
}

function describeManualStage(stage: string): string {
  const labels: Record<string, string> = {
    "additive-and-category": "Synced health metrics and categories",
    workouts: "Synced workouts",
    sleep: "Synced sleep",
    "running-steps": "Synced running steps",
  };
  if (labels[stage]) return labels[stage];
  const name = stage
    .replace(/^(?:raw|clinical):/, "")
    .replace(/^HK(?:Clinical|Quantity|Category)TypeIdentifier/, "");
  const readable = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s*Record$/, " records");
  return `Synced ${readable.toLowerCase()}`;
}

const defaultWaitUntilForegroundConnected: HealthKitManualSyncDependencies["waitUntilForegroundConnected"] =
  (signal, requireNewActivation = false) =>
    new Promise((resolve, reject) => {
      let sawActivation = false;
      let settled = false;
      const finish = (error?: unknown, rejectWait = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (rejectWait) reject(error);
        else resolve();
      };
      const check = async () => {
        if (settled) return;
        if (signal.aborted) {
          finish(new ManualHealthKitSyncInterruptedError(), true);
          return;
        }
        if (AppState.currentState !== "active" || (requireNewActivation && !sawActivation)) return;
        const network = await Network.getNetworkStateAsync();
        if (settled) return;
        if (signal.aborted) {
          finish(new ManualHealthKitSyncInterruptedError(), true);
          return;
        }
        if (AppState.currentState !== "active" || (requireNewActivation && !sawActivation)) return;
        if (network.isConnected === true && network.isInternetReachable !== false) finish();
      };
      const requestCheck = () => {
        void check().catch((error: unknown) => {
          captureException(error, { source: "health-kit-manual-connectivity" });
          finish(signal.aborted ? new ManualHealthKitSyncInterruptedError() : error, true);
        });
      };
      const appState = AppState.addEventListener("change", (state) => {
        if (state === "active") sawActivation = true;
        requestCheck();
      });
      const network = Network.addNetworkStateListener(requestCheck);
      const abort = () => finish(new ManualHealthKitSyncInterruptedError(), true);
      const cleanup = () => {
        appState.remove();
        network.remove();
        signal.removeEventListener("abort", abort);
      };
      signal.addEventListener("abort", abort, { once: true });
      requestCheck();
    });

function createDefaultDependencies(trpcClient: SyncTrpcClient): HealthKitManualSyncDependencies {
  const service = new AppleHealthSyncService({ trpcClient });
  return {
    loadCheckpoint: loadManualHealthKitCheckpoint,
    saveCheckpoint: saveManualHealthKitCheckpoint,
    clearCheckpoint: clearManualHealthKitCheckpoint,
    purgeCheckpoint: purgeManualHealthKitCheckpoint,
    startNative: startHealthKitSync,
    completeNative: completeHealthKitSync,
    updateProgress: updateHealthKitSyncProgress,
    listenForExpiration: (listener) =>
      addHealthKitSyncExpirationListener(({ taskId }) => listener(taskId)),
    listenForAppState: (listener) => AppState.addEventListener("change", listener),
    isForeground: () => AppState.currentState === "active",
    waitUntilForegroundConnected: defaultWaitUntilForegroundConnected,
    runSync: (input) => service.syncManualCheckpointed(input),
    recordOutcome: (result, error, durationMs) =>
      service.recordManualOutcome(result, error, durationMs),
    createId: () => Crypto.randomUUID(),
  };
}

export class HealthKitManualSyncController implements HealthKitManualSyncOwner {
  readonly userId: string;
  readonly trpcClient: SyncTrpcClient;
  readonly ready: Promise<void>;
  readonly #deps: HealthKitManualSyncDependencies;
  readonly #listeners = new Set<() => void>();
  readonly #expirationSubscription: { remove(): void };
  readonly #appStateSubscription: { remove(): void };
  #snapshot = INITIAL_STATE;
  #checkpoint: ManualHealthKitCheckpoint | null = null;
  #attempt: ManualAttempt | null = null;
  #retired = false;
  #disposed = false;
  #gate: Promise<void> = Promise.resolve();
  #starting = false;
  #hasRestoreError = false;
  #restoreError: unknown;

  constructor({ userId, trpcClient, deps = createDefaultDependencies(trpcClient) }: Options) {
    this.userId = userId;
    this.trpcClient = trpcClient;
    this.#deps = deps;
    this.#expirationSubscription = deps.listenForExpiration((taskId) => {
      const attempt = this.#attempt;
      if (taskId !== attempt?.taskId || this.#retired) return;
      attempt.expired = true;
      attempt.interrupted = true;
      this.#publish({ status: "paused", message: "Apple Health sync paused", error: null });
      this.#completeNative(attempt, false);
    });
    this.#appStateSubscription = deps.listenForAppState((state) => {
      const attempt = this.#attempt;
      if (state === "background" && attempt?.activeUpload)
        attempt.activeUploadCrossedBackground = true;
      if (
        attempt &&
        !attempt.supported &&
        state !== "active" &&
        this.#snapshot.status === "running"
      ) {
        attempt.interrupted = true;
      }
    });
    this.ready = this.#restore();
  }

  getSnapshot = (): HealthKitManualSyncState => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async start(syncRangeDays: number | null): Promise<SyncResult> {
    if (this.#starting) throw new Error("Apple Health sync is already running.");
    this.#starting = true;
    try {
      await this.ready;
      this.#assertAvailable();
      await this.#recoverRestoreFailure(true);
      await this.#replaceInterruptedAttempt();
      this.#assertAvailable();
      if (this.#attempt) throw new Error("Apple Health sync is already running.");
      const existing = this.#checkpoint;
      if (existing) {
        await this.#deps.clearCheckpoint(this.userId, existing.requestId);
        this.#assertAvailable();
      }
      const endDate = new Date().toISOString();
      const startDate =
        syncRangeDays === null
          ? new Date(0).toISOString()
          : (() => {
              const date = new Date();
              date.setDate(date.getDate() - syncRangeDays);
              date.setHours(0, 0, 0, 0);
              return date.toISOString();
            })();
      const checkpoint: ManualHealthKitCheckpoint = {
        requestId: this.#deps.createId(),
        userId: this.userId,
        startDate,
        endDate,
        nextStage: "additive-and-category",
        requiresResume: false,
      };
      this.#assertAvailable();
      await this.#deps.saveCheckpoint(checkpoint);
      this.#assertAvailable();
      this.#checkpoint = checkpoint;
      this.#assertAvailable();
      const attempt = this.#beginAttempt(checkpoint);
      return attempt;
    } finally {
      this.#starting = false;
    }
  }

  async resume(): Promise<SyncResult> {
    if (this.#starting) throw new Error("Apple Health sync is already running.");
    this.#starting = true;
    try {
      await this.ready;
      this.#assertAvailable();
      await this.#recoverRestoreFailure(false);
      await this.#replaceInterruptedAttempt();
      this.#assertAvailable();
      if (this.#attempt) throw new Error("Apple Health sync is already running.");
      if (!this.#checkpoint) throw new Error("There is no paused Apple Health sync to resume.");
      this.#assertAvailable();
      const attempt = this.#beginAttempt(this.#checkpoint);
      return attempt;
    } finally {
      this.#starting = false;
    }
  }

  async runObserverAttempt<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#withGate(async () => {
      this.#assertAvailable();
      return operation();
    });
  }

  assertAccountCurrent(): void {
    this.#assertAvailable();
  }

  /** Resource cleanup preserves the account's checkpoint so React effect replay is safe. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#attempt) {
      this.#attempt.interrupted = true;
      this.#completeNative(this.#attempt, false);
      this.#attempt.abort.abort();
    }
    this.#expirationSubscription.remove();
    this.#appStateSubscription.remove();
  }

  /** Account departure and erasure stop work and strictly purge only this account. */
  async retire(): Promise<void> {
    this.#retired = true;
    if (this.#attempt) {
      this.#attempt.interrupted = true;
      this.#completeNative(this.#attempt, false);
      this.#attempt.abort.abort();
    }
    this.#expirationSubscription.remove();
    this.#appStateSubscription.remove();
    const checkpoint = this.#checkpoint;
    if (checkpoint) await this.#deps.clearCheckpoint(this.userId, checkpoint.requestId);
    await this.#deps.purgeCheckpoint(this.userId);
    this.#checkpoint = null;
    this.#publish(INITIAL_STATE);
  }

  async #restore(): Promise<void> {
    try {
      const checkpoint = await this.#deps.loadCheckpoint(this.userId);
      if (this.#retired || this.#disposed || !checkpoint) return;
      this.#checkpoint = checkpoint;
      this.#publish({
        status: "paused",
        message: "Apple Health sync paused",
        error: null,
        completedStageCount: MANUAL_HEALTH_KIT_SYNC_STAGES.indexOf(checkpoint.nextStage),
        totalStageCount: MANUAL_HEALTH_KIT_SYNC_STAGES.length,
      });
    } catch (error) {
      if (this.#retired || this.#disposed) return;
      this.#hasRestoreError = true;
      this.#restoreError = error;
      captureException(error, { source: "health-kit-manual-sync-restore", userId: this.userId });
      this.#publishRestoreError(error);
    }
  }

  async #recoverRestoreFailure(replaceInvalid: boolean): Promise<void> {
    if (!this.#hasRestoreError) return;
    const restoreError = this.#restoreError;
    if (restoreError instanceof InvalidManualHealthKitCheckpointError) {
      if (!replaceInvalid) throw restoreError;
      await this.#deps.purgeCheckpoint(this.userId);
      this.#assertAvailable();
      this.#hasRestoreError = false;
      this.#restoreError = null;
      this.#checkpoint = null;
      return;
    }
    try {
      const checkpoint = await this.#deps.loadCheckpoint(this.userId);
      this.#assertAvailable();
      this.#checkpoint = checkpoint;
      this.#hasRestoreError = false;
      this.#restoreError = null;
      if (checkpoint) {
        this.#publish({
          status: "paused",
          message: "Apple Health sync paused",
          error: null,
          completedStageCount: MANUAL_HEALTH_KIT_SYNC_STAGES.indexOf(checkpoint.nextStage),
          totalStageCount: MANUAL_HEALTH_KIT_SYNC_STAGES.length,
        });
      } else {
        this.#publish(INITIAL_STATE);
      }
    } catch (error) {
      this.#assertAvailable();
      this.#hasRestoreError = true;
      this.#restoreError = error;
      captureException(error, { source: "health-kit-manual-sync-restore", userId: this.userId });
      this.#publishRestoreError(error);
      throw error;
    }
  }

  #publishRestoreError(error: unknown): void {
    const invalid = error instanceof InvalidManualHealthKitCheckpointError;
    this.#publish({
      status: "error",
      message: "Apple Health sync could not be restored",
      error: invalid
        ? "The saved Apple Health sync checkpoint is invalid. Tap Sync to replace it."
        : "Could not load the saved Apple Health sync request. Try again.",
    });
  }

  async #beginAttempt(checkpoint: ManualHealthKitCheckpoint): Promise<SyncResult> {
    this.#assertAvailable();
    const taskId = this.#deps.createId();
    const attempt: ManualAttempt = {
      taskId,
      abort: new AbortController(),
      interrupted: false,
      expired: false,
      recovering: false,
      nativeCompletionSent: false,
      supported: false,
      activeUpload: false,
      activeUploadCrossedBackground: false,
      promise: Promise.resolve({ inserted: 0, deleted: 0, errors: [] }),
    };
    this.#attempt = attempt;
    attempt.promise = this.#runAttempt(attempt, checkpoint);
    return attempt.promise;
  }

  async #runAttempt(
    attempt: ManualAttempt,
    checkpoint: ManualHealthKitCheckpoint,
  ): Promise<SyncResult> {
    const taskId = attempt.taskId;
    this.#publish({
      status: "running",
      message: "Starting Apple Health sync",
      error: null,
      completedStageCount: MANUAL_HEALTH_KIT_SYNC_STAGES.indexOf(checkpoint.nextStage),
      totalStageCount: MANUAL_HEALTH_KIT_SYNC_STAGES.length,
    });
    let outcomeAttempted = false;
    let dataFinalized = false;
    const startedAt = Date.now();
    try {
      const grant = await this.#deps.startNative(taskId);
      this.#assertAvailable();
      this.#assertAttempt(attempt);
      attempt.supported = grant.supported;
      let result: SyncResult | undefined;
      let transientRetried = false;
      let lockedRetried = false;
      let foregroundRetried = false;
      while (!result) {
        attempt.activeUploadCrossedBackground = false;
        try {
          result = await this.#withGate(() => this.#runCheckpoint(attempt, checkpoint));
        } catch (error) {
          this.#assertAttempt(attempt);
          const locked = isHealthKitDatabaseInaccessible(error);
          const transient =
            !locked &&
            !transientRetried &&
            attempt.activeUploadCrossedBackground &&
            isBackgroundHealthKitTransientNetworkError(error);
          const foregroundPause =
            error instanceof ManualHealthKitSyncInterruptedError &&
            !attempt.supported &&
            !foregroundRetried &&
            !this.#retired &&
            !this.#disposed;
          if (!isExpectedOrRetryableManualAttemptError(error, transient)) throw error;
          if (locked && !lockedRetried) lockedRetried = true;
          else if (transient) transientRetried = true;
          else if (foregroundPause) foregroundRetried = true;
          else throw error;
          attempt.recovering = true;
          this.#publish({
            status: "paused",
            message: locked
              ? "Unlock your phone to continue Apple Health sync"
              : "Apple Health sync paused",
            error: null,
          });
          await this.#deps.waitUntilForegroundConnected(
            attempt.abort.signal,
            locked || foregroundPause,
          );
          attempt.recovering = false;
          if (foregroundPause) attempt.interrupted = false;
          this.#assertCanContinue(attempt);
          this.#publish({ status: "running", message: "Resuming Apple Health sync", error: null });
        }
      }
      this.#assertCanContinue(attempt);
      if (result.errors.length > 0) {
        const next = { ...checkpoint, requiresResume: true };
        await this.#savePausedCheckpoint(next);
        this.#assertAttempt(attempt);
        this.#publish({
          status: "paused",
          message: "Apple Health sync paused",
          error: result.errors.join("; "),
        });
      } else {
        await this.#deps.clearCheckpoint(this.userId, checkpoint.requestId);
        this.#assertAttempt(attempt);
        this.#checkpoint = null;
        dataFinalized = true;
      }
      this.#assertCanContinue(attempt);
      outcomeAttempted = true;
      try {
        await this.#deps.recordOutcome(result, null, Date.now() - startedAt);
      } catch (error) {
        captureException(error, { source: "apple-health-sync-log", origin: "manual" });
        throw new Error(
          `Apple Health data synced, but sync history could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.#assertCanContinue(attempt);
      if (result.errors.length === 0) {
        this.#publish({ status: "complete", message: "Apple Health sync complete", error: null });
      }
      this.#completeNative(attempt, result.errors.length === 0);
      return result;
    } catch (error) {
      const current = this.#attempt === attempt;
      const paused =
        attempt.interrupted ||
        isHealthKitDatabaseInaccessible(error) ||
        error instanceof ManualHealthKitSyncInterruptedError;
      if (current && paused && !this.#retired && !this.#disposed) {
        if (!dataFinalized) {
          await this.#savePausedCheckpoint({ ...checkpoint, requiresResume: true });
          if (this.#attempt !== attempt || this.#retired) throw error;
        }
        if (this.#attempt === attempt && !this.#retired) {
          this.#publish(
            dataFinalized
              ? {
                  status: "error",
                  message: null,
                  error:
                    error instanceof ManualHealthKitSyncInterruptedError
                      ? "Apple Health data was synced, but completion was interrupted. Start a new sync to check for additional data."
                      : error instanceof Error
                        ? error.message
                        : String(error),
                }
              : {
                  status: "paused",
                  message: isHealthKitDatabaseInaccessible(error)
                    ? "Unlock your phone to continue Apple Health sync"
                    : "Apple Health sync paused",
                  error: null,
                },
          );
        }
      } else if (current && !this.#retired && !attempt.expired) {
        let visibleError = error instanceof Error ? error.message : String(error);
        if (!outcomeAttempted && !attempt.nativeCompletionSent) {
          outcomeAttempted = true;
          if (!isExpectedManualSyncInterruption(error) && !attempt.recovering) {
            captureException(error, { source: "apple-health-sync", origin: "manual" });
          }
          try {
            await this.#deps.recordOutcome(null, error, Date.now() - startedAt);
          } catch (recordError) {
            captureException(recordError, { source: "apple-health-sync-log", origin: "manual" });
            visibleError = `Apple Health sync failed: ${visibleError}. Sync history could not be saved: ${recordError instanceof Error ? recordError.message : String(recordError)}`;
          }
        }
        if (this.#attempt === attempt && !this.#retired && !attempt.interrupted) {
          this.#publish({
            status: "error",
            message: null,
            error: visibleError,
          });
        }
      }
      if (current && !this.#retired) this.#completeNative(attempt, false);
      throw error;
    } finally {
      if (this.#attempt === attempt) this.#attempt = null;
    }
  }

  async #runCheckpoint(
    attempt: ManualAttempt,
    checkpoint: ManualHealthKitCheckpoint,
  ): Promise<SyncResult> {
    const taskId = attempt.taskId;
    const result = await this.#deps.runSync({
      syncRangeDays: null,
      manualExecution: {
        startDate: checkpoint.startDate,
        endDate: checkpoint.endDate,
        nextStage: checkpoint.nextStage,
        assertCanContinue: async () => this.#assertCanContinue(attempt),
        shouldRetryWorkoutRouteError: (error) =>
          attempt.activeUploadCrossedBackground &&
          isBackgroundHealthKitTransientNetworkError(error),
        onStageComplete: async ({ stage, completedStageCount, totalStageCount }) => {
          this.#assertCanContinue(attempt);
          checkpoint.nextStage = stage;
          const stageIndex = completedStageCount;
          const nextStage = MANUAL_HEALTH_KIT_SYNC_STAGES[stageIndex];
          if (nextStage) checkpoint.nextStage = nextStage;
          await this.#deps.saveCheckpoint(checkpoint);
          this.#assertCanContinue(attempt);
          this.#checkpoint = checkpoint;
          this.#publish({
            status: "running",
            message: describeManualStage(stage),
            error: null,
            completedStageCount,
            totalStageCount,
          });
          this.#assertCanContinue(attempt);
          this.#deps.updateProgress(
            taskId,
            completedStageCount,
            totalStageCount,
            describeManualStage(stage),
          );
        },
      },
      onStage: (stage) => {
        attempt.activeUpload =
          stage.operation.startsWith("push") || stage.operation.startsWith("delete");
        attempt.activeUploadCrossedBackground = false;
      },
    });
    this.#assertCanContinue(attempt);
    return result;
  }

  async #savePausedCheckpoint(checkpoint: ManualHealthKitCheckpoint): Promise<void> {
    if (this.#retired || this.#disposed) return;
    await this.#deps.saveCheckpoint({ ...checkpoint, requiresResume: true });
    if (!this.#retired && !this.#disposed)
      this.#checkpoint = { ...checkpoint, requiresResume: true };
  }

  async #withGate<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#gate;
    let release!: () => void;
    this.#gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #assertAvailable(): void {
    if (this.#retired || this.#disposed) {
      throw new ManualHealthKitSyncInterruptedError(
        "Apple Health sync is no longer available for this account.",
      );
    }
  }

  async #replaceInterruptedAttempt(): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt) return;
    if (!attempt.expired && !attempt.recovering) return;
    attempt.interrupted = true;
    attempt.abort.abort();
    if (!attempt.expired) this.#completeNative(attempt, false);
    await Promise.allSettled([attempt.promise]);
  }

  #completeNative(attempt: ManualAttempt, success: boolean): void {
    if (attempt.nativeCompletionSent) return;
    attempt.nativeCompletionSent = true;
    this.#deps.completeNative(attempt.taskId, success);
  }

  #assertAttempt(attempt: ManualAttempt): void {
    if (this.#attempt !== attempt) throw new ManualHealthKitSyncInterruptedError();
    this.#assertAvailable();
  }

  #assertCanContinue(attempt: ManualAttempt): void {
    this.#assertAttempt(attempt);
    this.#assertAvailable();
    if (attempt.interrupted || (!attempt.supported && !this.#deps.isForeground())) {
      throw new ManualHealthKitSyncInterruptedError();
    }
  }

  #publish(patch: Partial<HealthKitManualSyncState>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
