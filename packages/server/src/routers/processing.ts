import { PROCESSING_ALERT_ACTIONS } from "@dofek/providers/processing-alerts";
import { processingPollInterval } from "@dofek/providers/processing-status";
import {
  PROCESSING_DATASET_KEYS,
  PROCESSING_OUTPUT_PATHS,
} from "dofek/processing/dataset-contracts";
import { PROCESSING_OPERATION_KINDS } from "dofek/processing/processing-event-store";
import {
  DERIVED_PROCESSING_STATUSES,
  PROCESSING_EVENT_STATUSES,
  PROCESSING_STAGES,
} from "dofek/processing/processing-state";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { timestampStringSchema } from "../lib/typed-sql.ts";
import { DataQualityRepository } from "../repositories/data-quality-repository.ts";
import { ProcessingRepository } from "../repositories/processing-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";
import { ensureProvidersRegistered } from "./sync-helpers.ts";

const datasetKeySchema = z.enum(PROCESSING_DATASET_KEYS);
const outputPathSchema = z.enum(PROCESSING_OUTPUT_PATHS);
const stageSchema = z.enum(PROCESSING_STAGES);
const eventStatusSchema = z.enum(PROCESSING_EVENT_STATUSES);
const operationKindSchema = z.enum(PROCESSING_OPERATION_KINDS);
const derivedStatusSchema = z.enum(DERIVED_PROCESSING_STATUSES);
const statusInputSchema = z.object({
  providerId: z.string().min(1).optional(),
  datasets: z.array(datasetKeySchema).min(1).optional(),
});
const timelineEventSchema = z.object({
  sequence: z.number().int().positive(),
  stage: stageSchema,
  status: eventStatusSchema,
  datasetKey: datasetKeySchema.nullable(),
  outputPath: outputPathSchema.nullable(),
  occurredAt: z.string().datetime(),
  progressPercentage: z.number().int().min(0).max(100).nullable(),
  message: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
const statusOutputSchema = z.object({
  generatedAt: z.string().datetime(),
  scope: z.object({
    providerId: z.string().nullable(),
    datasets: z.array(datasetKeySchema),
  }),
  overallStatus: derivedStatusSchema,
  datasets: z.array(
    z.object({
      key: datasetKeySchema,
      label: z.string(),
      status: derivedStatusSchema,
      currentStage: stageSchema.nullable(),
      progressPercentage: z.number().int().min(0).max(100).nullable(),
      lastAdvancedAt: z.string().datetime().nullable(),
      lastReadyAt: z.string().datetime().nullable(),
    }),
  ),
  operations: z.array(
    z.object({
      id: z.uuid(),
      providerId: z.string().nullable(),
      kind: operationKindSchema,
      createdAt: z.string().datetime(),
      status: derivedStatusSchema,
      datasets: z.array(datasetKeySchema),
      timeline: z.array(timelineEventSchema),
    }),
  ),
});
const alertsOutputSchema = z.object({
  generatedAt: z.string().datetime(),
  alerts: z.array(
    z.object({
      id: z.string().min(1),
      providerId: z.string().nullable(),
      providerLabel: z.string().nullable(),
      datasetKey: datasetKeySchema,
      occurredAt: z.string().datetime(),
      title: z.string().min(1),
      message: z.string().min(1),
      action: z.enum(PROCESSING_ALERT_ACTIONS),
      actionLabel: z.string().min(1),
    }),
  ),
});
const historyOutputSchema = z.object({
  operations: z.array(
    z.object({
      id: z.uuid(),
      userId: z.uuid().nullable(),
      providerId: z.string().nullable(),
      kind: operationKindSchema,
      externalCorrelationKey: z.string().nullable(),
      datasetKeys: z.array(datasetKeySchema).min(1),
      createdAt: timestampStringSchema.pipe(z.string().datetime()),
    }),
  ),
  nextCursor: z.uuid().nullable(),
});
const dataQualityOutputSchema = z.object({
  generatedAt: z.string().datetime(),
  window: z.object({
    days: z.number().int().positive(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  overallStatus: z.enum(["healthy", "attention"]),
  overallMessage: z.string().min(1),
  checks: z.array(
    z.object({
      key: z.enum(["coverage", "source_overlap", "sync_freshness", "outliers", "manual_edits"]),
      label: z.string().min(1),
      status: z.enum(["healthy", "attention", "informational"]),
      title: z.string().min(1),
      message: z.string().min(1),
      count: z.number().int().nonnegative(),
      lastObservedDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
      details: z.array(z.string().min(1)),
    }),
  ),
});

export const processingRouter = router({
  alerts: cachedProtectedQuery({ maxAge: processingPollInterval("failed") })
    .output(alertsOutputSchema)
    .query(({ ctx }) => new ProcessingRepository(ctx.db, ctx.userId).alerts()),
  status: cachedProtectedQuery({ maxAge: processingPollInterval("active") })
    .input(statusInputSchema)
    .output(statusOutputSchema)
    .query(({ ctx, input }) => new ProcessingRepository(ctx.db, ctx.userId).status(input)),
  history: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(
      z.object({
        cursor: z.uuid().nullable().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .output(historyOutputSchema)
    .query(({ ctx, input }) => new ProcessingRepository(ctx.db, ctx.userId).history(input)),
  dataQuality: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(z.object({ endDate: endDateSchema }))
    .output(dataQualityOutputSchema)
    .query(async ({ ctx, input }) => {
      await ensureProvidersRegistered();
      return new DataQualityRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.sensorStore,
        ctx.accessWindow,
      ).overview(input.endDate);
    }),
});
