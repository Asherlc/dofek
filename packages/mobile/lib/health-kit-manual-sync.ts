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
  if (stage.startsWith("clinical:") && /medication/i.test(stage)) {
    return "Synced medication records";
  }
  const labels: Record<string, string> = {
    "raw:HKQuantityTypeIdentifierBodyMass": "Synced body mass",
    "clinical:medication": "Synced medication records",
  };
  if (labels[stage]) return labels[stage];
  const name = stage
    .replace(/^(raw|clinical):/, "")
    .replace(/^HK(?:Quantity|Category)TypeIdentifier/, "");
  const readable = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/Record$/, " records");
  return `Synced ${readable.toLowerCase()}`;
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
  #attempt: ManualAttempt | null = null;
  #retired = false;
  #disposed = false;
  #gate: Promise<void> = Promise.resolve();

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
    await this.ready;
    this.#assertAvailable();
    await this.#replaceInterruptedAttempt();
    if (this.#attempt) throw new Error("Apple Health sync is already running.");
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
    return this.#beginAttempt(checkpoint);
  }

  async resume(): Promise<SyncResult> {
    await this.ready;
    this.#assertAvailable();
    await this.#replaceInterruptedAttempt();
    if (this.#attempt) throw new Error("Apple Health sync is already running.");
    if (!this.#checkpoint) throw new Error("There is no paused Apple Health sync to resume.");
    return this.#beginAttempt(this.#checkpoint);
  }

  async runObserverAttempt<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#withGate(async () => {
      this.#assertAvailable();
      return operation();
    });
  }

  assertCanContinue(): void {
    this.#assertAvailable();
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
    if (this.#attempt) {
      this.#attempt.interrupted = true;
      this.#completeNative(this.#attempt, false);
      this.#attempt.abort.abort();
    }
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

  async #beginAttempt(checkpoint: ManualHealthKitCheckpoint): Promise<SyncResult> {
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
    void attempt.promise.catch(() => undefined);
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
    let outcomeRecorded = false;
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
        this.#publish({ status: "complete", message: "Apple Health sync complete", error: null });
      }
      this.#assertCanContinue(attempt);
      outcomeRecorded = true;
      await this.#deps.recordOutcome(result, null, Date.now() - startedAt);
      this.#completeNative(attempt, result.errors.length === 0);
      return result;
    } catch (error) {
      const current = this.#attempt === attempt;
      const paused =
        attempt.interrupted ||
        isHealthKitDatabaseInaccessible(error) ||
        error instanceof ManualHealthKitSyncInterruptedError;
      if (current && paused && !this.#retired) {
        await this.#savePausedCheckpoint({ ...checkpoint, requiresResume: true });
        if (this.#attempt !== attempt || this.#retired) throw error;
        this.#publish({
          status: "paused",
          message: isHealthKitDatabaseInaccessible(error)
            ? "Unlock your phone to continue Apple Health sync"
            : "Apple Health sync paused",
          error: null,
        });
      } else if (current && !this.#retired && !attempt.expired) {
        if (!outcomeRecorded && !attempt.nativeCompletionSent) {
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
      if (current && !this.#retired && !attempt.expired) this.#completeNative(attempt, false);
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
      onProgress: (message) => this.#publish({ status: "running", message, error: null }),
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
    await attempt.promise.catch(() => undefined);
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
