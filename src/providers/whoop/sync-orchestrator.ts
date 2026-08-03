import { WhoopClient } from "@dofek/whoop/client";
import { withSyncLog } from "../../db/sync-log.ts";
import { captureException } from "../../lib/error-reporting.ts";
import { runWithSyncStepAdmission } from "../../lib/sync-step-admission-context.ts";
import { logger } from "../../logger.ts";
import { fingerprintOpaqueValue } from "../../sync/pagination-fingerprint.ts";
import type { SyncDegradation } from "../../sync/sync-degradation.ts";
import type { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import type { SyncError, SyncResult } from "../types.ts";
import { findWhoopRateLimitError, isWhoopRateLimitError } from "./rate-limit.ts";
import { resolveWhoopTokens } from "./resolve-tokens.ts";
import {
  createWhoopSyncCheckpoint,
  parseWhoopSyncCheckpoint,
  WHOOP_CYCLE_WINDOW_MS,
  type WhoopSyncCheckpoint,
  type WhoopSyncStep,
} from "./sync-checkpoint.ts";
import { syncWhoopStrainDeepDiveForDate } from "./sync-daily-activity.ts";
import { syncWhoopJournal } from "./sync-journal.ts";
import { syncWhoopRecovery } from "./sync-recovery.ts";
import { syncWhoopSleepSessions, syncWhoopSleepStagesForId } from "./sync-sleep.ts";
import { planWhoopApiSteps } from "./sync-step-plan.ts";
import { syncWhoopHeartRateForWindow } from "./sync-streams.ts";
import type { WhoopPersistenceContext, WhoopSyncContext } from "./sync-types.ts";
import {
  fetchWhoopDeveloperWorkoutsPage,
  persistWhoopWorkoutsFromCycles,
  syncWhoopStrengthForActivity,
} from "./sync-workouts.ts";

const WHOOP_ACTIVITY_ABSENCE_RECONCILE_DAYS = 30;

type WhoopOrchestratorResult = {
  checkpoint: WhoopSyncCheckpoint;
  recordsSynced: number;
  errors: SyncError[];
  degradations: SyncDegradation[];
  complete: boolean;
};

async function createWhoopClient(
  db: SyncRun["db"],
  fetchFn: typeof globalThis.fetch,
  runUserId?: string,
): Promise<WhoopClient> {
  const token = await resolveWhoopTokens({ db, fetchFn, userId: runUserId });
  return new WhoopClient(token, fetchFn, createWhoopRequestLogger());
}

function createWhoopRequestLogger(): (event: {
  userId: number;
  endpoint: string;
  status: number;
  attempt: number;
  retryAfterSeconds: number | null;
  timestamp: Date;
}) => void {
  return (event) => {
    const logMethod = event.status === 429 ? "warn" : "info";
    logger[logMethod]("[whoop] API request", {
      whoopUserId: event.userId,
      endpoint: event.endpoint,
      status: event.status,
      attempt: event.attempt,
      retryAfterSeconds: event.retryAfterSeconds,
      timestamp: event.timestamp.toISOString(),
    });
  };
}

function makeBootstrapContext(
  run: SyncRun,
  cycles: WhoopSyncCheckpoint["cycles"],
  errors: SyncError[],
): WhoopPersistenceContext {
  return {
    db: run.db,
    cycles,
    providerId: "whoop",
    since: run.window.since,
    windowEnd: run.window.until,
    options: run.options,
    errors,
  };
}

function makeContext(
  run: SyncRun,
  client: WhoopClient,
  cycles: WhoopSyncCheckpoint["cycles"],
  errors: SyncError[],
): WhoopSyncContext {
  return {
    db: run.db,
    client,
    cycles,
    providerId: "whoop",
    since: run.window.since,
    windowEnd: run.window.until,
    options: run.options,
    errors,
  };
}

function syncErrorLabelForStep(step: WhoopSyncStep): string {
  switch (step.type) {
    case "strain_deep_dive":
      return "daily_activity";
    case "persist_workouts":
      return "workouts";
    case "weightlifting":
      return "strength";
    case "heart_rate":
      return "hr_stream";
    default:
      return step.type;
  }
}

function describeStep(step: WhoopSyncStep | "bootstrap_cycles" | "bootstrap_persist"): string {
  if (step === "bootstrap_cycles") return "Fetching cycles";
  if (step === "bootstrap_persist") return "Persisting cycle data";
  switch (step.type) {
    case "strain_deep_dive":
      return `Daily steps ${step.date}`;
    case "sleep_stages":
      return `Sleep stages ${step.sleepId}`;
    case "developer_workouts":
      return "Developer workout list";
    case "persist_workouts":
      return "Persist workouts";
    case "weightlifting":
      return `Strength ${step.activityId}`;
    case "heart_rate":
      return "Heart rate stream";
    case "journal":
      return "Journal";
  }
}

type WhoopStepDescription = WhoopSyncStep | "bootstrap_cycles" | "bootstrap_persist";

function developerWorkoutTokensSeenByCurrentStep(checkpoint: WhoopSyncCheckpoint): Set<string> {
  const tokens = new Set<string>();
  for (const step of checkpoint.apiSteps.slice(0, checkpoint.apiStepIndex + 1)) {
    if (step.type === "developer_workouts" && step.nextToken) {
      tokens.add(step.nextToken);
    }
  }
  return tokens;
}

function developerWorkoutPaginationDegradation(
  checkpoint: WhoopSyncCheckpoint,
  nextToken: string | null,
): SyncDegradation | null {
  if (!nextToken) return null;
  const seenTokens = developerWorkoutTokensSeenByCurrentStep(checkpoint);
  if (!seenTokens.has(nextToken)) return null;

  return {
    kind: "pagination_stalled",
    providerId: "whoop",
    stepName: "developer_workouts",
    message: "WHOOP returned a repeated developer workout pagination cursor",
    context: {
      cursorFingerprint: fingerprintOpaqueValue(nextToken),
      pagesFetched: seenTokens.size + 1,
    },
  };
}

function resolveStepDescription(checkpoint: WhoopSyncCheckpoint): WhoopStepDescription {
  if (checkpoint.phase === "bootstrap") {
    return checkpoint.cycleFetchCursorMs == null && checkpoint.cycles.length > 0
      ? "bootstrap_persist"
      : "bootstrap_cycles";
  }
  const fallbackJournalStep: WhoopSyncStep = { type: "journal" };
  return checkpoint.apiSteps[checkpoint.apiStepIndex] ?? fallbackJournalStep;
}

async function runBootstrapPersist(
  run: SyncRun,
  checkpoint: WhoopSyncCheckpoint,
  errors: SyncError[],
): Promise<WhoopOrchestratorResult> {
  const context = makeBootstrapContext(run, checkpoint.cycles, errors);
  checkpoint.recordsSynced += await syncWhoopRecovery(context);
  checkpoint.recordsSynced += await syncWhoopSleepSessions(context);

  checkpoint.apiSteps = await planWhoopApiSteps(context);
  checkpoint.apiStepIndex = 0;
  checkpoint.phase = "api";
  checkpoint.cycleFetchCursorMs = null;

  return {
    checkpoint,
    recordsSynced: checkpoint.recordsSynced,
    errors,
    degradations: [],
    complete: false,
  };
}

async function runBootstrapStep(
  run: SyncRun,
  checkpoint: WhoopSyncCheckpoint,
  client: WhoopClient,
  errors: SyncError[],
): Promise<WhoopOrchestratorResult> {
  const windowEndMs = run.window.until.getTime();
  const cursorMs = checkpoint.cycleFetchCursorMs;

  if (cursorMs != null && cursorMs < windowEndMs) {
    const chunkEndMs = Math.min(cursorMs + WHOOP_CYCLE_WINDOW_MS, windowEndMs);
    const startStr = new Date(cursorMs).toISOString();
    const endStr = new Date(chunkEndMs).toISOString();
    logger.info(`[whoop] Fetching cycles ${startStr} → ${endStr}`);
    try {
      const chunk = await client.getCycles(startStr, endStr);
      checkpoint.cycles.push(...chunk);
      checkpoint.cycleFetchCursorMs = chunkEndMs >= windowEndMs ? null : chunkEndMs;
    } catch (err) {
      if (isWhoopRateLimitError(err)) {
        throw err;
      }
      errors.push({
        message: `getCycles: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
      checkpoint.phase = "done";
      return {
        checkpoint,
        recordsSynced: checkpoint.recordsSynced,
        errors,
        degradations: [],
        complete: true,
      };
    }
    return {
      checkpoint,
      recordsSynced: checkpoint.recordsSynced,
      errors,
      degradations: [],
      complete: false,
    };
  }

  return runBootstrapPersist(run, checkpoint, errors);
}

async function runApiStep(
  run: SyncRun,
  checkpoint: WhoopSyncCheckpoint,
  client: WhoopClient,
  errors: SyncError[],
): Promise<WhoopOrchestratorResult> {
  const step = checkpoint.apiSteps[checkpoint.apiStepIndex];
  if (!step) {
    checkpoint.phase = "done";
    return {
      checkpoint,
      recordsSynced: checkpoint.recordsSynced,
      errors,
      degradations: [],
      complete: true,
    };
  }

  const context = makeContext(run, client, checkpoint.cycles, errors);
  const degradations: SyncDegradation[] = [];
  const absenceWindow = new SyncWindow({
    since: run.window.since,
    until: run.window.until,
  }).withMinimumLookback(WHOOP_ACTIVITY_ABSENCE_RECONCILE_DAYS);
  const userId = run.options.userId;

  try {
    switch (step.type) {
      case "strain_deep_dive":
        checkpoint.recordsSynced += await withSyncLog(
          run.db,
          "whoop",
          "daily_activity",
          async () => {
            const count = await syncWhoopStrainDeepDiveForDate(context, step.date);
            return { recordCount: count, result: count };
          },
          userId,
        );
        break;
      case "sleep_stages":
        checkpoint.recordsSynced += await withSyncLog(
          run.db,
          "whoop",
          "sleep_stages",
          async () => {
            const count = await syncWhoopSleepStagesForId(context, step.sleepId);
            return { recordCount: count, result: count };
          },
          userId,
        );
        break;
      case "developer_workouts": {
        const developerWorkoutResult = await withSyncLog(
          run.db,
          "whoop",
          "developer_workouts",
          async () => {
            const page = await fetchWhoopDeveloperWorkoutsPage(
              context,
              absenceWindow,
              step.nextToken,
            );
            checkpoint.presentExternalIds.push(...page.presentIds);
            const degradation = developerWorkoutPaginationDegradation(checkpoint, page.nextToken);

            if (page.nextToken && !page.reachedWindowStart && !degradation) {
              checkpoint.apiSteps.splice(checkpoint.apiStepIndex + 1, 0, {
                type: "developer_workouts",
                nextToken: page.nextToken,
              });
            }
            if (!page.nextToken || page.reachedWindowStart) {
              checkpoint.developerWorkoutPaginationComplete = true;
            }

            return {
              recordCount: page.presentIds.length,
              result: {
                recordsSynced: 0,
                degradations: degradation ? [degradation] : [],
              },
              degradations: degradation ? [degradation] : [],
            };
          },
          userId,
        );
        degradations.push(...developerWorkoutResult.degradations);
        break;
      }
      case "persist_workouts":
        checkpoint.recordsSynced += await withSyncLog(
          run.db,
          "whoop",
          "workouts",
          async () => {
            const count = await persistWhoopWorkoutsFromCycles(
              context,
              new Set(checkpoint.presentExternalIds),
              { reconcileAbsence: checkpoint.developerWorkoutPaginationComplete },
            );
            return { recordCount: count, result: count };
          },
          userId,
        );
        break;
      case "weightlifting":
        checkpoint.recordsSynced += await withSyncLog(
          run.db,
          "whoop",
          "strength",
          async () => {
            const count = await syncWhoopStrengthForActivity(context, step.activityId);
            return { recordCount: count, result: count };
          },
          userId,
        );
        break;
      case "heart_rate":
        checkpoint.recordsSynced += await withSyncLog(
          run.db,
          "whoop",
          "hr_stream",
          async () => {
            const count = await syncWhoopHeartRateForWindow(context, step.start, step.end);
            return { recordCount: count, result: count };
          },
          userId,
        );
        break;
      case "journal":
        checkpoint.recordsSynced += await withSyncLog(
          run.db,
          "whoop",
          "journal",
          async () => {
            const count = await syncWhoopJournal(context);
            return { recordCount: count, result: count };
          },
          userId,
        );
        break;
    }
  } catch (err) {
    if (isWhoopRateLimitError(err)) {
      throw err;
    }
    if (step.type === "developer_workouts") {
      throw err;
    }
    errors.push({
      message: `${syncErrorLabelForStep(step)}: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }

  checkpoint.apiStepIndex += 1;
  if (checkpoint.apiStepIndex >= checkpoint.apiSteps.length) {
    checkpoint.phase = "done";
    return {
      checkpoint,
      recordsSynced: checkpoint.recordsSynced,
      errors,
      degradations,
      complete: true,
    };
  }

  return {
    checkpoint,
    recordsSynced: checkpoint.recordsSynced,
    errors,
    degradations,
    complete: false,
  };
}

async function runWhoopSyncStep(
  run: SyncRun,
  checkpoint: WhoopSyncCheckpoint,
  fetchFn: typeof globalThis.fetch,
): Promise<WhoopOrchestratorResult> {
  const errors: SyncError[] = [];

  if (checkpoint.phase === "bootstrap") {
    const windowEndMs = run.window.until.getTime();
    const needsFetch =
      checkpoint.cycleFetchCursorMs != null && checkpoint.cycleFetchCursorMs < windowEndMs;
    if (needsFetch) {
      const client = await createWhoopClient(run.db, fetchFn, run.options.userId);
      return runBootstrapStep(run, checkpoint, client, errors);
    }
    return runBootstrapPersist(run, checkpoint, errors);
  }

  const client = await createWhoopClient(run.db, fetchFn, run.options.userId);
  if (checkpoint.phase === "api") {
    return runApiStep(run, checkpoint, client, errors);
  }

  return {
    checkpoint,
    recordsSynced: checkpoint.recordsSynced,
    errors,
    degradations: [],
    complete: true,
  };
}

export async function runWhoopOrchestratedSync(
  run: SyncRun,
  fetchFn: typeof globalThis.fetch,
  startMs: number,
): Promise<SyncResult> {
  const checkpointStore = run.options.checkpoint;
  let checkpoint =
    parseWhoopSyncCheckpoint(await checkpointStore?.load()) ??
    createWhoopSyncCheckpoint(run.window.since.getTime());

  const errors: SyncError[] = [];
  const degradations: SyncDegradation[] = [];
  let recordsSynced = checkpoint.recordsSynced;

  try {
    while (true) {
      const stepDescription = resolveStepDescription(checkpoint);

      run.options.onProgress?.(
        checkpoint.phase === "done"
          ? 100
          : Math.min(
              99,
              Math.round((checkpoint.apiStepIndex / Math.max(checkpoint.apiSteps.length, 1)) * 100),
            ),
        describeStep(stepDescription),
      );

      const outcome = await runWithSyncStepAdmission(() =>
        runWhoopSyncStep(run, checkpoint, fetchFn),
      );
      checkpoint = outcome.checkpoint;
      recordsSynced = checkpoint.recordsSynced;
      errors.push(...outcome.errors);
      degradations.push(...outcome.degradations);
      await checkpointStore?.save(checkpoint);

      if (outcome.complete) {
        await checkpointStore?.clear();
        const rateLimitError = findWhoopRateLimitError(errors);
        if (rateLimitError) {
          throw rateLimitError;
        }
        return {
          provider: "whoop",
          recordsSynced,
          errors,
          ...(degradations.length > 0 ? { degradations } : {}),
          duration: Date.now() - startMs,
          continued: false,
        };
      }

      if (!run.options.enqueueSyncContinuation) {
        continue;
      }

      await run.options.enqueueSyncContinuation(checkpoint);
      return {
        provider: "whoop",
        recordsSynced,
        errors,
        ...(degradations.length > 0 ? { degradations } : {}),
        duration: Date.now() - startMs,
        continued: true,
      };
    }
  } catch (err) {
    if (isWhoopRateLimitError(err)) {
      await checkpointStore?.save(checkpoint);
      throw err;
    }
    captureException(err);
    errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
    return {
      provider: "whoop",
      recordsSynced,
      errors,
      ...(degradations.length > 0 ? { degradations } : {}),
      duration: Date.now() - startMs,
      continued: false,
    };
  }
}
