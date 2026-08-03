import {
  GarminApiError,
  GarminConnectClient,
  GarminRateLimitError,
} from "@dofek/garmin-connect/client";
import {
  parseActivityDetail,
  parseConnectActivity,
  parseConnectDailySummary,
  parseConnectSleep,
  parseConnectSleepStages,
  parseHeartRateTimeSeries,
  parseHrvSummary,
  parseStressTimeSeries,
} from "@dofek/garmin-connect/parsing";
import type { GarminTokens } from "@dofek/garmin-connect/types";
import { isIndoorCyclingModality } from "@dofek/training/endurance-types";
import { and, eq, inArray } from "drizzle-orm";
import type { SyncDatabase } from "../../db/index.ts";
import { writeMetricStreamBatch } from "../../db/metric-stream-writer.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../../db/provider-activity-sync.ts";
import { activity, dailyMetrics, sleepSession, sleepStage } from "../../db/schema/activity.ts";
import { SOURCE_TYPE_API } from "../../db/sensor-channels.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { saveTokens } from "../../db/tokens.ts";
import { captureException } from "../../lib/error-reporting.ts";
import { isRetryableInfraError } from "../../lib/retryable-infra-error.ts";
import { runWithSyncStepAdmission } from "../../lib/sync-step-admission-context.ts";
import { logger } from "../../logger.ts";
import type { SyncDegradation } from "../../sync/sync-degradation.ts";
import { ProviderAuthenticationFailedError } from "../auth-errors.ts";
import type { SyncRun } from "../sync-run.ts";
import type { SyncError, SyncOptions, SyncResult } from "../types.ts";
import { eachDay, formatDate } from "./date-utils.ts";
import { serializeInternalTokens } from "./internal-tokens.ts";
import {
  applyRateLimitToCheckpoint,
  createGarminSyncCheckpoint,
  type GarminSyncCheckpoint,
  type GarminSyncStep,
  insertStepsAfterCurrent,
  parseGarminSyncCheckpoint,
} from "./sync-checkpoint.ts";
import { planGarminSyncSteps } from "./sync-step-plan.ts";

export const GARMIN_ACTIVITY_PAGE_SIZE = 50;
const GARMIN_MAX_ACTIVITY_LIST_PAGES = 100;

type GarminOrchestratorResult = {
  checkpoint: GarminSyncCheckpoint;
  recordsSynced: number;
  errors: SyncError[];
  degradations: SyncDegradation[];
  complete: boolean;
  stopSync?: boolean;
};

function isNoDataError(error: unknown): boolean {
  return error instanceof GarminApiError && error.statusCode === 204;
}

function throwIfProviderSyncAbortError(error: unknown): void {
  if (isRetryableInfraError(error) || error instanceof GarminRateLimitError) throw error;
}

class SyncErrorTracker {
  readonly operation: string;
  readonly errors: Array<{ context: string; error: unknown }> = [];
  #sentryReported = false;

  constructor(operation: string) {
    this.operation = operation;
  }

  record(context: string, error: unknown): void {
    throwIfProviderSyncAbortError(error);
    if (isNoDataError(error)) return;

    this.errors.push({ context, error });
    logger.warn(`[garmin] ${this.operation} failed for ${context}: ${error}`);

    if (!this.#sentryReported) {
      captureException(error, {
        tags: { provider: "garmin", operation: this.operation },
        extra: { context },
      });
      this.#sentryReported = true;
    }
  }

  throwIfErrors(): void {
    if (this.errors.length === 0) return;
    const count = this.errors.length;
    const firstContext = this.errors[0]?.context ?? "unknown";
    const firstMessage =
      this.errors[0]?.error instanceof Error
        ? this.errors[0].error.message
        : String(this.errors[0]?.error);
    throw new Error(
      `${this.operation}: ${count} error(s), first at ${firstContext}: ${firstMessage}`,
    );
  }
}

function syncErrorLabelForStep(step: GarminSyncStep): string {
  switch (step.type) {
    case "activities_list":
    case "activity_detail":
    case "activity_reconcile":
      return "Activities";
    case "daily_summary":
    case "hrv_summary":
      return "Daily metrics";
    case "sleep":
      return "Sleep";
    case "stress":
      return "Stress";
    case "heart_rate":
      return "Heart rate";
  }
}

function describeStep(step: GarminSyncStep): string {
  switch (step.type) {
    case "activities_list":
      return step.offset > 0 ? `Activity list (offset ${step.offset})` : "Activity list";
    case "activity_detail":
      return `Activity detail ${step.activityId}`;
    case "activity_reconcile":
      return "Activity reconciliation";
    case "sleep":
      return `Sleep ${step.date}`;
    case "daily_summary":
      return `Daily summary ${step.date}`;
    case "hrv_summary":
      return `HRV ${step.date}`;
    case "stress":
      return `Stress ${step.date}`;
    case "heart_rate":
      return `Heart rate ${step.date}`;
  }
}

async function resolveGarminClient(
  db: SyncDatabase,
  providerId: string,
  tokens: GarminTokens,
  userId: string,
  fetchFn: typeof globalThis.fetch,
): Promise<GarminConnectClient> {
  const client = await GarminConnectClient.fromTokens(tokens, "garmin.com", fetchFn);
  const refreshedTokens = client.getTokens();
  if (refreshedTokens) {
    await saveTokens(db, providerId, serializeInternalTokens(refreshedTokens), userId);
  }
  return client;
}

async function runActivitiesListStep(
  db: SyncDatabase,
  client: GarminConnectClient,
  providerId: string,
  userId: string,
  since: Date,
  until: Date,
  checkpoint: GarminSyncCheckpoint,
  step: Extract<GarminSyncStep, { type: "activities_list" }>,
): Promise<{
  checkpoint: GarminSyncCheckpoint;
  recordsSynced: number;
  degradations: SyncDegradation[];
}> {
  const page = await client.getActivities(step.offset, GARMIN_ACTIVITY_PAGE_SIZE);
  const degradations: SyncDegradation[] = [];

  let recordsSynced = 0;
  const presentActivityExternalIds = new Set(checkpoint.presentActivityExternalIds);

  const pageExternalIds = page.map((raw) => String(raw.activityId));
  const existingActivityIds =
    pageExternalIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db
              .select({ externalId: activity.externalId })
              .from(activity)
              .where(
                and(
                  eq(activity.userId, userId),
                  eq(activity.providerId, providerId),
                  inArray(activity.externalId, pageExternalIds),
                ),
              )
          ).map((row) => row.externalId),
        );

  const detailSteps: GarminSyncStep[] = [];
  for (const raw of page) {
    const parsed = parseConnectActivity(raw);
    presentActivityExternalIds.add(parsed.externalId);

    const connectDeviceName = raw.deviceName ?? null;
    await upsertProviderActivity(
      db,
      {
        providerId,
        externalId: parsed.externalId,
        activityType: parsed.activityType,
        startedAt: parsed.startedAt,
        endedAt: parsed.endedAt,
        name: parsed.name,
        sourceName: connectDeviceName,
        raw: parsed.raw,
      },
      {
        activityType: parsed.activityType,
        startedAt: parsed.startedAt,
        endedAt: parsed.endedAt,
        name: parsed.name,
        sourceName: connectDeviceName,
        raw: parsed.raw,
      },
    );

    const needsDetail =
      parsed.startedAt >= since &&
      parsed.startedAt <= until &&
      !existingActivityIds.has(parsed.externalId);

    if (needsDetail) {
      detailSteps.push({
        type: "activity_detail",
        activityId: raw.activityId,
        activityModality: parsed.activityType.modality,
      });
    } else {
      recordsSynced++;
    }
  }

  let followUpSteps: GarminSyncStep[];
  if (
    page.length === GARMIN_ACTIVITY_PAGE_SIZE &&
    step.offset / GARMIN_ACTIVITY_PAGE_SIZE >= GARMIN_MAX_ACTIVITY_LIST_PAGES - 1
  ) {
    degradations.push({
      kind: "pagination_stalled",
      providerId,
      stepName: "activities_list",
      message: "Garmin activity pagination exceeded the maximum offset guard",
      context: {
        offset: step.offset,
        pageSize: GARMIN_ACTIVITY_PAGE_SIZE,
      },
    });
    followUpSteps = detailSteps;
  } else {
    followUpSteps =
      page.length === GARMIN_ACTIVITY_PAGE_SIZE
        ? [{ type: "activities_list", offset: step.offset + page.length }]
        : [...detailSteps, { type: "activity_reconcile" }];
  }

  return {
    recordsSynced,
    degradations,
    checkpoint: insertStepsAfterCurrent(
      {
        ...checkpoint,
        presentActivityExternalIds: [...presentActivityExternalIds],
      },
      followUpSteps,
    ),
  };
}

async function runActivityDetailStep(
  db: SyncDatabase,
  client: GarminConnectClient,
  providerId: string,
  userId: string,
  step: Extract<GarminSyncStep, { type: "activity_detail" }>,
  metricStreamPublisher: SyncOptions["metricStreamPublisher"],
): Promise<number> {
  const detail = await client.getActivityDetail(step.activityId);
  const stream = parseActivityDetail(detail);
  const rows = await db
    .select({ id: activity.id })
    .from(activity)
    .where(
      and(
        eq(activity.userId, userId),
        eq(activity.providerId, providerId),
        eq(activity.externalId, String(step.activityId)),
      ),
    )
    .limit(1);
  const activityUuid = rows[0]?.id;

  let count = 0;
  for (const sample of stream.samples) {
    const timestamp = sample.directTimestamp;
    if (timestamp === null || timestamp === undefined) continue;

    await writeMetricStreamBatch(
      db,
      [
        {
          recordedAt: new Date(timestamp),
          providerId,
          activityId: activityUuid,
          heartRate: sample.directHeartRate !== null ? sample.directHeartRate : undefined,
          power: sample.directPower !== null ? sample.directPower : undefined,
          cadence:
            sample.directRunCadence !== null
              ? sample.directRunCadence
              : sample.directBikeCadence !== null
                ? sample.directBikeCadence
                : undefined,
          speed: isIndoorCyclingModality(step.activityModality)
            ? undefined
            : sample.directSpeed !== null
              ? sample.directSpeed
              : undefined,
          altitude: sample.directElevation !== null ? sample.directElevation : undefined,
          lat: sample.directLatitude !== null ? sample.directLatitude : undefined,
          lng: sample.directLongitude !== null ? sample.directLongitude : undefined,
          temperature:
            sample.directAirTemperature !== null ? sample.directAirTemperature : undefined,
        },
      ],
      SOURCE_TYPE_API,
      undefined,
      metricStreamPublisher,
    );
    count++;
  }
  return count > 0 ? 1 : 0;
}

async function runActivityReconcileStep(
  db: SyncDatabase,
  providerId: string,
  userId: string,
  since: Date,
  until: Date,
  checkpoint: GarminSyncCheckpoint,
): Promise<void> {
  await finishProviderActivityListSync(db, {
    providerId,
    userId,
    windowStart: since,
    windowEnd: until,
    presentExternalIds: new Set(checkpoint.presentActivityExternalIds),
  });
}

async function runSleepStep(
  db: SyncDatabase,
  client: GarminConnectClient,
  providerId: string,
  date: string,
): Promise<number> {
  const tracker = new SyncErrorTracker("sleep");
  try {
    let raw: Awaited<ReturnType<GarminConnectClient["getSleepData"]>>;
    try {
      raw = await client.getSleepData(date);
    } catch (error) {
      if (isNoDataError(error)) return 0;
      throw error;
    }
    const parsed = parseConnectSleep(raw);
    if (!parsed) return 0;

    const [session] = await db
      .insert(sleepSession)
      .values({
        providerId,
        externalId: parsed.externalId,
        startedAt: parsed.startedAt,
        endedAt: parsed.endedAt,
        durationMinutes: parsed.durationMinutes,
        deepMinutes: parsed.deepMinutes,
        lightMinutes: parsed.lightMinutes,
        remMinutes: parsed.remMinutes,
        awakeMinutes: parsed.awakeMinutes,
        stagingAvailable: parsed.stagingAvailable,
      })
      .onConflictDoUpdate({
        target: [sleepSession.userId, sleepSession.providerId, sleepSession.externalId],
        set: {
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          durationMinutes: parsed.durationMinutes,
          deepMinutes: parsed.deepMinutes,
          lightMinutes: parsed.lightMinutes,
          remMinutes: parsed.remMinutes,
          awakeMinutes: parsed.awakeMinutes,
          stagingAvailable: parsed.stagingAvailable,
        },
      })
      .returning({ id: sleepSession.id });

    const stages = parseConnectSleepStages(raw);
    if (session && stages.length > 0) {
      await db.delete(sleepStage).where(eq(sleepStage.sessionId, session.id));
      await db.insert(sleepStage).values(
        stages.map((stage) => ({
          sessionId: session.id,
          stage: stage.stage,
          startedAt: stage.startedAt,
          endedAt: stage.endedAt,
        })),
      );
    }

    return 1;
  } catch (error) {
    tracker.record(date, error);
  }
  tracker.throwIfErrors();
  return 0;
}

async function runDailySummaryStep(
  db: SyncDatabase,
  client: GarminConnectClient,
  providerId: string,
  date: string,
): Promise<number> {
  let raw: Awaited<ReturnType<GarminConnectClient["getDailySummary"]>>;
  try {
    raw = await client.getDailySummary(date);
  } catch (error) {
    if (isNoDataError(error)) return 0;
    throw error;
  }
  if (raw.privacyProtected) return 0;

  const parsed = parseConnectDailySummary(raw);
  await db
    .insert(dailyMetrics)
    .values({
      date: parsed.date,
      providerId,
      steps: parsed.steps,
      distanceKm: parsed.distanceKm,
      spo2Avg: parsed.spo2Avg,
      respiratoryRateAvg: parsed.respiratoryRateAvg,
      flightsClimbed: parsed.flightsClimbed,
      exerciseMinutes: parsed.exerciseMinutes,
    })
    .onConflictDoUpdate({
      target: [
        dailyMetrics.userId,
        dailyMetrics.date,
        dailyMetrics.providerId,
        dailyMetrics.sourceName,
      ],
      set: {
        steps: parsed.steps,
        distanceKm: parsed.distanceKm,
        spo2Avg: parsed.spo2Avg,
        respiratoryRateAvg: parsed.respiratoryRateAvg,
        flightsClimbed: parsed.flightsClimbed,
        exerciseMinutes: parsed.exerciseMinutes,
      },
    });

  return 1;
}

async function runHrvSummaryStep(
  db: SyncDatabase,
  client: GarminConnectClient,
  providerId: string,
  userId: string,
  date: string,
): Promise<number> {
  try {
    const hrvData = await client.getHrvSummary(date);
    const parsedHrv = parseHrvSummary(hrvData);
    const hrv = parsedHrv.lastNightAvg ?? parsedHrv.lastNight;

    const existing = await db
      .select({ id: dailyMetrics.id })
      .from(dailyMetrics)
      .where(
        and(
          eq(dailyMetrics.userId, userId),
          eq(dailyMetrics.date, date),
          eq(dailyMetrics.providerId, providerId),
        ),
      )
      .limit(1);
    if (existing.length === 0) return 0;

    await db
      .insert(dailyMetrics)
      .values({
        date,
        providerId,
        hrv,
      })
      .onConflictDoUpdate({
        target: [
          dailyMetrics.userId,
          dailyMetrics.date,
          dailyMetrics.providerId,
          dailyMetrics.sourceName,
        ],
        set: { hrv },
      });

    return 1;
  } catch (error) {
    if (isNoDataError(error)) return 0;
    throw error;
  }
}

async function runStressStep(
  db: SyncDatabase,
  client: GarminConnectClient,
  providerId: string,
  date: string,
  metricStreamPublisher: SyncOptions["metricStreamPublisher"],
): Promise<number> {
  let raw: Awaited<ReturnType<GarminConnectClient["getDailyStress"]>>;
  try {
    raw = await client.getDailyStress(date);
  } catch (error) {
    if (isNoDataError(error)) return 0;
    throw error;
  }
  const parsed = parseStressTimeSeries(raw);
  const stressRows = parsed.samples.map((sample) => ({
    recordedAt: sample.timestamp,
    providerId,
    stress: sample.stressLevel,
  }));
  await writeMetricStreamBatch(db, stressRows, SOURCE_TYPE_API, undefined, metricStreamPublisher);
  return stressRows.length;
}

async function runHeartRateStep(
  db: SyncDatabase,
  client: GarminConnectClient,
  providerId: string,
  date: string,
  metricStreamPublisher: SyncOptions["metricStreamPublisher"],
): Promise<number> {
  let raw: Awaited<ReturnType<GarminConnectClient["getDailyHeartRate"]>>;
  try {
    raw = await client.getDailyHeartRate(date);
  } catch (error) {
    if (isNoDataError(error)) return 0;
    throw error;
  }
  const parsed = parseHeartRateTimeSeries(raw);
  const hrRows = parsed.samples.map((sample) => ({
    recordedAt: sample.timestamp,
    providerId,
    heartRate: sample.heartRate,
  }));
  await writeMetricStreamBatch(db, hrRows, SOURCE_TYPE_API, undefined, metricStreamPublisher);
  return hrRows.length;
}

async function runGarminSyncStep(
  run: SyncRun,
  checkpoint: GarminSyncCheckpoint,
  tokens: GarminTokens,
  effectiveSince: Date,
  until: Date,
  userId: string,
  fetchFn: typeof globalThis.fetch,
): Promise<GarminOrchestratorResult> {
  const errors: SyncError[] = [];
  const degradations: SyncDegradation[] = [];
  const step = checkpoint.steps[checkpoint.stepIndex];
  if (!step) {
    return {
      checkpoint: { ...checkpoint, phase: "done" },
      recordsSynced: checkpoint.recordsSynced,
      errors,
      degradations,
      complete: true,
    };
  }

  let client: GarminConnectClient;
  try {
    client = await resolveGarminClient(run.db, "garmin", tokens, userId, fetchFn);
  } catch (err) {
    throwIfProviderSyncAbortError(err);
    errors.push({
      message: `Connect API authentication failed: ${err instanceof Error ? err.message : String(err)}`,
      cause: new ProviderAuthenticationFailedError("Garmin Connect", {
        cause: err instanceof Error ? err : undefined,
      }),
    });
    return {
      checkpoint,
      recordsSynced: checkpoint.recordsSynced,
      errors,
      degradations,
      complete: false,
      stopSync: true,
    };
  }

  let recordsSynced = 0;
  let nextCheckpoint = checkpoint;

  try {
    switch (step.type) {
      case "activities_list": {
        const outcome = await runActivitiesListStep(
          run.db,
          client,
          "garmin",
          userId,
          effectiveSince,
          until,
          checkpoint,
          step,
        );
        recordsSynced += outcome.recordsSynced;
        degradations.push(...outcome.degradations);
        nextCheckpoint = outcome.checkpoint;
        break;
      }
      case "activity_detail": {
        const tracker = new SyncErrorTracker("activity_detail");
        try {
          recordsSynced += await runActivityDetailStep(
            run.db,
            client,
            "garmin",
            userId,
            step,
            run.options.metricStreamPublisher,
          );
        } catch (error) {
          tracker.record(String(step.activityId), error);
        }
        tracker.throwIfErrors();
        break;
      }
      case "activity_reconcile":
        await runActivityReconcileStep(run.db, "garmin", userId, effectiveSince, until, checkpoint);
        break;
      case "sleep":
        recordsSynced += await withSyncLog(
          run.db,
          "garmin",
          "sleep",
          async () => {
            const count = await runSleepStep(run.db, client, "garmin", step.date);
            return { recordCount: count, result: count };
          },
          userId,
        );
        break;
      case "daily_summary":
        recordsSynced += await withSyncLog(
          run.db,
          "garmin",
          "daily_metrics",
          async () => {
            const count = await runDailySummaryStep(run.db, client, "garmin", step.date);
            return { recordCount: count, result: count };
          },
          userId,
        );
        break;
      case "hrv_summary": {
        const tracker = new SyncErrorTracker("hrv");
        try {
          recordsSynced += await runHrvSummaryStep(run.db, client, "garmin", userId, step.date);
        } catch (error) {
          tracker.record(step.date, error);
        }
        tracker.throwIfErrors();
        break;
      }
      case "stress":
        recordsSynced += await withSyncLog(
          run.db,
          "garmin",
          "stress",
          async () => {
            const count = await runStressStep(
              run.db,
              client,
              "garmin",
              step.date,
              run.options.metricStreamPublisher,
            );
            return { recordCount: count, result: count };
          },
          userId,
        );
        break;
      case "heart_rate":
        recordsSynced += await withSyncLog(
          run.db,
          "garmin",
          "heart_rate",
          async () => {
            const count = await runHeartRateStep(
              run.db,
              client,
              "garmin",
              step.date,
              run.options.metricStreamPublisher,
            );
            return { recordCount: count, result: count };
          },
          userId,
        );
        break;
    }
  } catch (err) {
    throwIfProviderSyncAbortError(err);
    errors.push({
      message: `${syncErrorLabelForStep(step)} sync failed: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }

  nextCheckpoint = {
    ...nextCheckpoint,
    recordsSynced: nextCheckpoint.recordsSynced + recordsSynced,
    stepIndex: nextCheckpoint.stepIndex + 1,
  };

  if (nextCheckpoint.stepIndex >= nextCheckpoint.steps.length) {
    nextCheckpoint = { ...nextCheckpoint, phase: "done" };
    return {
      checkpoint: nextCheckpoint,
      recordsSynced: nextCheckpoint.recordsSynced,
      errors,
      degradations,
      complete: true,
    };
  }

  return {
    checkpoint: nextCheckpoint,
    recordsSynced: nextCheckpoint.recordsSynced,
    errors,
    degradations,
    complete: false,
  };
}

export async function runGarminOrchestratedSync(
  run: SyncRun,
  tokens: GarminTokens,
  effectiveSince: Date,
  until: Date,
  userId: string,
  fetchFn: typeof globalThis.fetch,
  startMs: number,
): Promise<SyncResult> {
  const checkpointStore = run.options.checkpoint;
  const dates = eachDay(effectiveSince, until);
  let checkpoint =
    parseGarminSyncCheckpoint(await checkpointStore?.load()) ??
    createGarminSyncCheckpoint(
      await planGarminSyncSteps({
        db: run.db,
        providerId: "garmin",
        userId,
        sinceDate: formatDate(effectiveSince),
        untilDate: formatDate(until),
        dates,
      }),
    );

  const errors: SyncError[] = [];
  const degradations: SyncDegradation[] = [];
  let recordsSynced = checkpoint.recordsSynced;

  try {
    while (true) {
      const step = checkpoint.steps[checkpoint.stepIndex];
      run.options.onProgress?.(
        checkpoint.phase === "done"
          ? 100
          : Math.min(
              99,
              Math.round((checkpoint.stepIndex / Math.max(checkpoint.steps.length, 1)) * 100),
            ),
        step ? describeStep(step) : "Complete",
      );

      const outcome = await runWithSyncStepAdmission(() =>
        runGarminSyncStep(run, checkpoint, tokens, effectiveSince, until, userId, fetchFn),
      );
      checkpoint = outcome.checkpoint;
      recordsSynced = checkpoint.recordsSynced;
      errors.push(...outcome.errors);
      degradations.push(...outcome.degradations);
      await checkpointStore?.save(checkpoint);

      if (outcome.stopSync || outcome.complete) {
        if (outcome.complete) {
          await checkpointStore?.clear();
        }
        return {
          provider: "garmin",
          recordsSynced,
          errors,
          degradations,
          duration: Date.now() - startMs,
          continued: false,
        };
      }

      if (!run.options.enqueueSyncContinuation) {
        continue;
      }

      await run.options.enqueueSyncContinuation(checkpoint);
      return {
        provider: "garmin",
        recordsSynced,
        errors,
        degradations,
        duration: Date.now() - startMs,
        continued: true,
      };
    }
  } catch (err) {
    if (err instanceof GarminRateLimitError) {
      checkpoint = applyRateLimitToCheckpoint(checkpoint);
      await checkpointStore?.save(checkpoint);
      throw err;
    }
    errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
    return {
      provider: "garmin",
      recordsSynced,
      errors,
      degradations,
      duration: Date.now() - startMs,
      continued: false,
    };
  }
}
