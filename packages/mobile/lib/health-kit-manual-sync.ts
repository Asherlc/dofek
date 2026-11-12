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
  loadManualHealthKitCheckpoint,
  type ManualHealthKitCheckpoint,
  purgeManualHealthKitCheckpoint,
  saveManualHealthKitCheckpoint,
} from "./health-kit-manual-checkpoint";
import { MANUAL_HEALTH_KIT_SYNC_STAGES } from "./health-kit-sync";
import {
  ManualHealthKitSyncInterruptedError,
  type SyncResult,
  type SyncTrpcClient,
} from "./health-kit-sync-types";
import { captureException } from "./telemetry";

export type HealthKitManualSyncState = {
  status: "idle" | "running" | "paused" | "error" | "complete";
  message: string | null;
  completedStageCount: number;
  totalStageCount: number;
  error: string | null;
};

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
    input: Parameters<AppleHealthSyncService["sync"]>[0] & {
      manualExecution: NonNullable<
        Parameters<AppleHealthSyncService["sync"]>[0]["manualExecution"]
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

function isExpectedManualSyncInterruption(error: unknown): boolean {
  return (
    error instanceof ManualHealthKitSyncInterruptedError || isHealthKitDatabaseInaccessible(error)
  );
}

function isExpectedOrRetryableManualAttemptError(error: unknown, transient: boolean): boolean {
  return isExpectedManualSyncInterruption(error) || transient;
}

const defaultWaitUntilForegroundConnected: HealthKitManualSyncDependencies["waitUntilForegroundConnected"] =
  (signal, requireNewActivation = false) =>
    new Promise((resolve, reject) => {
      let sawActivation = false;
      const check = async () => {
        if (signal.aborted) {
          cleanup();
          reject(new ManualHealthKitSyncInterruptedError());
          return;
        }
        if (AppState.currentState !== "active" || (requireNewActivation && !sawActivation)) return;
        const network = await Network.getNetworkStateAsync();
        if (network.isConnected === true && network.isInternetReachable !== false) {
          cleanup();
          resolve();
        }
      };
      const appState = AppState.addEventListener("change", (state) => {
        if (state === "active") sawActivation = true;
        void check();
      });
      const network = Network.addNetworkStateListener(() => void check());
      const abort = () => {
        cleanup();
        reject(new ManualHealthKitSyncInterruptedError());
      };
      const cleanup = () => {
        appState.remove();
        network.remove();
        signal.removeEventListener("abort", abort);
      };
      signal.addEventListener("abort", abort, { once: true });
      void check();
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

export class HealthKitManualSyncController {
  readonly userId: string;
  readonly trpcClient: SyncTrpcClient;
  readonly ready: Promise<void>;
  readonly #deps: HealthKitManualSyncDependencies;
  readonly #listeners = new Set<() => void>();
  readonly #expirationSubscription: { remove(): void };
  readonly #appStateSubscription: { remove(): void };
  readonly #abort = new AbortController();
  #snapshot = INITIAL_STATE;
  #checkpoint: ManualHealthKitCheckpoint | null = null;
  #taskId: string | null = null;
  #nativeCompletionSent = false;
  #supported = false;
  #interrupted = false;
  #retired = false;
  #disposed = false;
  #activeUpload = false;
  #activeUploadCrossedBackground = false;
  #gate: Promise<void> = Promise.resolve();

  constructor({ userId, trpcClient, deps = createDefaultDependencies(trpcClient) }: Options) {
    this.userId = userId;
    this.trpcClient = trpcClient;
    this.#deps = deps;
    this.#expirationSubscription = deps.listenForExpiration((taskId) => {
      if (taskId !== this.#taskId || this.#retired) return;
      this.#interrupted = true;
      this.#publish({ status: "paused", message: "Apple Health sync paused", error: null });
    });
    this.#appStateSubscription = deps.listenForAppState((state) => {
      if (state === "background" && this.#activeUpload) this.#activeUploadCrossedBackground = true;
      if (!this.#supported && state !== "active" && this.#snapshot.status === "running") {
        this.#interrupted = true;
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
    await this.ready;
    this.#assertAvailable();
    if (this.#snapshot.status === "running")
      throw new Error("Apple Health sync is already running.");
    const existing = this.#checkpoint;
    if (existing) await this.#deps.clearCheckpoint(this.userId, existing.requestId);
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
    await this.#deps.saveCheckpoint(checkpoint);
    this.#checkpoint = checkpoint;
    return this.#attempt(checkpoint);
  }

  async resume(): Promise<SyncResult> {
    await this.ready;
    this.#assertAvailable();
    if (this.#snapshot.status === "running")
      throw new Error("Apple Health sync is already running.");
    if (!this.#checkpoint) throw new Error("There is no paused Apple Health sync to resume.");
    return this.#attempt(this.#checkpoint);
  }

  async runObserverAttempt<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#withGate(async () => {
      this.#assertAvailable();
      return operation();
    });
  }

  assertCanContinue(): void {
    this.#assertCanContinue();
  }

  assertAccountCurrent(): void {
    this.#assertAvailable();
  }

  /** Resource cleanup preserves the account's checkpoint so React effect replay is safe. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#interrupted = true;
    this.#completeNative(false);
    this.#abort.abort();
    this.#expirationSubscription.remove();
    this.#appStateSubscription.remove();
    if (this.#checkpoint && this.#snapshot.status === "running") {
      void this.#savePausedCheckpoint(this.#checkpoint);
    }
  }

  /** Account departure and erasure stop work and strictly purge only this account. */
  async retire(): Promise<void> {
    this.#retired = true;
    this.#interrupted = true;
    this.#completeNative(false);
    this.#abort.abort();
    this.#expirationSubscription.remove();
    this.#appStateSubscription.remove();
    const checkpoint = this.#checkpoint;
    if (checkpoint) await this.#deps.clearCheckpoint(this.userId, checkpoint.requestId);
    await this.#deps.purgeCheckpoint(this.userId);
    this.#checkpoint = null;
    this.#publish(INITIAL_STATE);
  }

  async #restore(): Promise<void> {
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
  }

  async #attempt(checkpoint: ManualHealthKitCheckpoint): Promise<SyncResult> {
    const taskId = this.#deps.createId();
    this.#taskId = taskId;
    this.#nativeCompletionSent = false;
    this.#interrupted = false;
    this.#activeUpload = false;
    this.#activeUploadCrossedBackground = false;
    this.#supported = false;
    this.#publish({
      status: "running",
      message: "Starting Apple Health sync",
      error: null,
      completedStageCount: MANUAL_HEALTH_KIT_SYNC_STAGES.indexOf(checkpoint.nextStage),
      totalStageCount: MANUAL_HEALTH_KIT_SYNC_STAGES.length,
    });
    let outcomeRecorded = false;
    const startedAt = Date.now();
    try {
      const grant = await this.#deps.startNative(taskId);
      this.#assertAvailable();
      this.#supported = grant.supported;
      let result: SyncResult | undefined;
      let transientRetried = false;
      let lockedRetried = false;
      let foregroundRetried = false;
      while (!result) {
        this.#activeUploadCrossedBackground = false;
        try {
          result = await this.#withGate(() => this.#runCheckpoint(checkpoint, taskId));
        } catch (error) {
          const locked = isHealthKitDatabaseInaccessible(error);
          const transient =
            !locked &&
            !transientRetried &&
            this.#activeUploadCrossedBackground &&
            isBackgroundHealthKitTransientNetworkError(error);
          const foregroundPause =
            error instanceof ManualHealthKitSyncInterruptedError &&
            !this.#supported &&
            !foregroundRetried &&
            !this.#retired &&
            !this.#disposed;
          if (!isExpectedOrRetryableManualAttemptError(error, transient)) throw error;
          if (locked && !lockedRetried) lockedRetried = true;
          else if (transient) transientRetried = true;
          else if (foregroundPause) foregroundRetried = true;
          else throw error;
          this.#publish({
            status: "paused",
            message: locked
              ? "Unlock your phone to continue Apple Health sync"
              : "Apple Health sync paused",
            error: null,
          });
          await this.#deps.waitUntilForegroundConnected(
            this.#abort.signal,
            locked || foregroundPause,
          );
          if (foregroundPause) this.#interrupted = false;
          this.#assertCanContinue();
          this.#publish({ status: "running", message: "Resuming Apple Health sync", error: null });
        }
      }
      this.#assertCanContinue();
      if (result.errors.length > 0) {
        const next = { ...checkpoint, requiresResume: true };
        await this.#savePausedCheckpoint(next);
        this.#publish({
          status: "paused",
          message: "Apple Health sync paused",
          error: result.errors.join("; "),
        });
      } else {
        await this.#deps.clearCheckpoint(this.userId, checkpoint.requestId);
        this.#checkpoint = null;
        this.#publish({ status: "complete", message: "Apple Health sync complete", error: null });
      }
      this.#assertCanContinue();
      outcomeRecorded = true;
      await this.#deps.recordOutcome(result, null, Date.now() - startedAt);
      this.#completeNative(result.errors.length === 0);
      return result;
    } catch (error) {
      const paused =
        this.#interrupted ||
        isHealthKitDatabaseInaccessible(error) ||
        error instanceof ManualHealthKitSyncInterruptedError;
      if (paused && !this.#retired) {
        await this.#savePausedCheckpoint({ ...checkpoint, requiresResume: true });
        this.#publish({
          status: "paused",
          message: isHealthKitDatabaseInaccessible(error)
            ? "Unlock your phone to continue Apple Health sync"
            : "Apple Health sync paused",
          error: null,
        });
      } else if (!this.#retired) {
        if (!outcomeRecorded && !this.#nativeCompletionSent && this.#taskId === taskId) {
          outcomeRecorded = true;
          if (!isExpectedManualSyncInterruption(error)) {
            captureException(error, { source: "apple-health-sync", origin: "manual" });
          }
          await this.#deps.recordOutcome(null, error, Date.now() - startedAt);
        }
        this.#publish({
          status: "error",
          message: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!this.#retired) this.#completeNative(false);
      throw error;
    }
  }

  async #runCheckpoint(checkpoint: ManualHealthKitCheckpoint, taskId: string): Promise<SyncResult> {
    const result = await this.#deps.runSync({
      syncRangeDays: null,
      manualExecution: {
        startDate: checkpoint.startDate,
        endDate: checkpoint.endDate,
        nextStage: checkpoint.nextStage,
        assertCanContinue: async () => this.#assertCanContinue(),
        onStageComplete: async ({ stage, completedStageCount, totalStageCount }) => {
          this.#assertCanContinue();
          checkpoint.nextStage = stage;
          const stageIndex = completedStageCount;
          const nextStage = MANUAL_HEALTH_KIT_SYNC_STAGES[stageIndex];
          if (nextStage) checkpoint.nextStage = nextStage;
          await this.#deps.saveCheckpoint(checkpoint);
          this.#checkpoint = checkpoint;
          this.#publish({
            status: "running",
            message: stage,
            error: null,
            completedStageCount,
            totalStageCount,
          });
          this.#assertCanContinue();
          this.#deps.updateProgress(taskId, completedStageCount, totalStageCount, stage);
        },
      },
      onProgress: (message) => this.#publish({ status: "running", message, error: null }),
      onStage: (stage) => {
        this.#activeUpload =
          stage.operation.startsWith("push") || stage.operation.startsWith("delete");
        this.#activeUploadCrossedBackground = false;
      },
    });
    this.#assertCanContinue();
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

  #completeNative(success: boolean): void {
    if (!this.#taskId || this.#nativeCompletionSent) return;
    const taskId = this.#taskId;
    this.#nativeCompletionSent = true;
    this.#taskId = null;
    this.#deps.completeNative(taskId, success);
  }

  #assertCanContinue(): void {
    this.#assertAvailable();
    if (this.#interrupted || (!this.#supported && !this.#deps.isForeground())) {
      throw new ManualHealthKitSyncInterruptedError();
    }
  }

  #publish(patch: Partial<HealthKitManualSyncState>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
