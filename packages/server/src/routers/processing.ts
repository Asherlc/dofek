import { PROCESSING_DATASET_KEYS } from "dofek/processing/dataset-contracts";
import { z } from "zod";
import { ProcessingRepository } from "../repositories/processing-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

const datasetKeySchema = z.enum(PROCESSING_DATASET_KEYS);
const outputPathSchema = z.enum(["relational", "metric_stream"]);
const stageSchema = z.enum(["ingest", "canonical_commit", "cdc", "analytics", "cache_refresh"]);
const eventStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);
const operationKindSchema = z.enum([
  "provider_sync",
  "file_import",
  "push_ingest",
  "data_deletion",
  "analytics_build",
  "cache_refresh",
]);
const derivedStatusSchema = z.enum([
  "ready",
  "waiting",
  "active",
  "partial",
  "delayed",
  "blocked",
  "failed",
  "cancelled",
]);
const statusInputSchema = z.object({
  providerId: z.string().min(1).optional(),
  datasets: z.array(datasetKeySchema).min(1).optional(),
});
const timelineEventSchema = z.object({
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
const historyOutputSchema = z.object({
  operations: z.array(
    z.object({
      id: z.uuid(),
      userId: z.uuid().nullable(),
      providerId: z.string().nullable(),
      kind: operationKindSchema,
      externalCorrelationKey: z.string().nullable(),
      datasetKeys: z.array(datasetKeySchema).min(1),
      createdAt: z.date(),
    }),
  ),
  nextCursor: z.uuid().nullable(),
});

export const processingRouter = router({
  status: protectedProcedure
    .input(statusInputSchema)
    .output(statusOutputSchema)
    .query(({ ctx, input }) => new ProcessingRepository(ctx.db, ctx.userId).status(input)),
  history: protectedProcedure
    .input(
      z.object({
        cursor: z.uuid().nullable().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .output(historyOutputSchema)
    .query(({ ctx, input }) => new ProcessingRepository(ctx.db, ctx.userId).history(input)),
});
