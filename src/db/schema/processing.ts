import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { fitness } from "./core.ts";
import { userProfile } from "./reference.ts";

export const processingOperation = fitness.table(
  "processing_operation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id"),
    providerId: text("provider_id"),
    kind: text("kind").notNull(),
    externalCorrelationKey: text("external_correlation_key"),
    datasetKeys: text("dataset_keys").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "processing_operation_user_fk",
      columns: [table.userId],
      foreignColumns: [userProfile.id],
    }).onDelete("cascade"),
    uniqueIndex("processing_operation_correlation_key")
      .on(
        sql`coalesce(${table.userId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        table.kind,
        table.externalCorrelationKey,
      )
      .where(sql`${table.externalCorrelationKey} IS NOT NULL`),
    index("processing_operation_user_created_idx").on(
      table.userId,
      table.createdAt.desc(),
      table.id,
    ),
    check(
      "processing_operation_kind_valid",
      sql`${table.kind} IN ('provider_sync', 'file_import', 'push_ingest', 'data_deletion', 'analytics_build', 'cache_refresh')`,
    ),
    check("processing_operation_datasets_nonempty", sql`cardinality(${table.datasetKeys}) > 0`),
  ],
);

export const processingAlertDismissal = fitness.table(
  "processing_alert_dismissal",
  {
    userId: uuid("user_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "processing_alert_dismissal_pkey",
      columns: [table.userId, table.operationId],
    }),
    foreignKey({
      name: "processing_alert_dismissal_user_fk",
      columns: [table.userId],
      foreignColumns: [userProfile.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "processing_alert_dismissal_operation_fk",
      columns: [table.operationId],
      foreignColumns: [processingOperation.id],
    }).onDelete("cascade"),
  ],
);

export const processingStageEvent = fitness.table(
  "processing_stage_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity(),
    operationId: uuid("operation_id").notNull(),
    stage: text("stage").notNull(),
    status: text("status").notNull(),
    datasetKey: text("dataset_key"),
    outputPath: text("output_path"),
    modelName: text("model_name"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    progressPercentage: integer("progress_percentage"),
    sourceWatermark: text("source_watermark"),
    servingWatermark: text("serving_watermark"),
    message: text("message"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    metadataSchemaVersion: integer("metadata_schema_version").notNull().default(1),
    metadata: jsonb("metadata").$type<Record<string, string | number | boolean | null>>(),
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (table) => [
    foreignKey({
      name: "processing_stage_event_operation_fk",
      columns: [table.operationId],
      foreignColumns: [processingOperation.id],
    }).onDelete("cascade"),
    unique("processing_stage_event_idempotency_key")
      .on(
        table.operationId,
        table.stage,
        table.datasetKey,
        table.outputPath,
        table.modelName,
        table.status,
        table.idempotencyKey,
      )
      .nullsNotDistinct(),
    index("processing_stage_event_operation_sequence_idx").on(
      table.operationId,
      table.sequence.desc(),
    ),
    index("processing_stage_event_latest_idx").on(
      table.operationId,
      table.stage,
      table.datasetKey,
      table.outputPath,
      table.modelName,
      table.sequence.desc(),
    ),
    index("processing_stage_event_dataset_sequence_idx").on(
      table.datasetKey,
      table.sequence.desc(),
    ),
    check(
      "processing_stage_event_stage_valid",
      sql`${table.stage} IN ('ingest', 'canonical_commit', 'cdc', 'analytics', 'cache_refresh')`,
    ),
    check(
      "processing_stage_event_status_valid",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')`,
    ),
    check(
      "processing_stage_event_output_path_valid",
      sql`${table.outputPath} IS NULL OR ${table.outputPath} IN ('relational', 'metric_stream')`,
    ),
    check(
      "processing_stage_event_progress_valid",
      sql`${table.progressPercentage} IS NULL OR ${table.progressPercentage} BETWEEN 0 AND 100`,
    ),
    check(
      "processing_stage_event_metadata_version_positive",
      sql`${table.metadataSchemaVersion} > 0`,
    ),
  ],
);

export const processingOperationOutput = fitness.table(
  "processing_operation_output",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id").notNull(),
    datasetKey: text("dataset_key").notNull(),
    outputPath: text("output_path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "processing_operation_output_operation_fk",
      columns: [table.operationId],
      foreignColumns: [processingOperation.id],
    }).onDelete("cascade"),
    unique("processing_operation_output_key").on(
      table.operationId,
      table.datasetKey,
      table.outputPath,
    ),
    check(
      "processing_operation_output_path_valid",
      sql`${table.outputPath} IN ('relational', 'metric_stream')`,
    ),
  ],
);

export const processingFlowMarker = fitness.table(
  "processing_flow_marker",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id").notNull(),
    datasetKey: text("dataset_key").notNull(),
    flowName: text("flow_name").notNull(),
    batchKey: text("batch_key").notNull(),
    sourceWatermark: text("source_watermark").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "processing_flow_marker_operation_fk",
      columns: [table.operationId],
      foreignColumns: [processingOperation.id],
    }).onDelete("cascade"),
    unique("processing_flow_marker_operation_dataset_flow").on(
      table.operationId,
      table.datasetKey,
      table.flowName,
      table.batchKey,
    ),
    index("processing_flow_marker_watermark_idx").on(table.sourceWatermark),
  ],
);

export const processingMetricStreamBatch = fitness.table(
  "processing_metric_stream_batch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id").notNull(),
    batchId: text("batch_id").notNull(),
    datasetKeys: text("dataset_keys").array().notNull(),
    expectedEventCount: integer("expected_event_count").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "processing_metric_batch_operation_fk",
      columns: [table.operationId],
      foreignColumns: [processingOperation.id],
    }).onDelete("cascade"),
    unique("processing_metric_stream_batch_key").on(table.operationId, table.batchId),
    check(
      "processing_metric_stream_batch_datasets_nonempty",
      sql`cardinality(${table.datasetKeys}) > 0`,
    ),
    check(
      "processing_metric_stream_batch_event_count_positive",
      sql`${table.expectedEventCount} > 0`,
    ),
  ],
);

export const activityIntegrityRepairJournal = fitness.table(
  "activity_integrity_repair_journal",
  {
    runId: uuid("run_id").primaryKey(),
    userId: uuid("user_id").notNull(),
    artifactPath: text("artifact_path").notNull(),
    artifactChecksum: text("artifact_checksum").notNull(),
    acceptanceOwner: text("acceptance_owner").notNull(),
    acceptanceDeadline: timestamp("acceptance_deadline", { withTimezone: true }).notNull(),
    phase: text("phase").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("activity_integrity_repair_journal_artifact_path_key").on(table.artifactPath),
    uniqueIndex("activity_integrity_repair_journal_single_eligible_idx")
      .on(sql`(true)`)
      .where(
        sql`${table.phase} IN ('postgres_committed', 'rebuild_failed', 'executed', 'rollback_committed')`,
      ),
    check(
      "activity_integrity_repair_journal_checksum_valid",
      sql`${table.artifactChecksum} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "activity_integrity_repair_journal_phase_valid",
      sql`${table.phase} IN (
        'postgres_committed',
        'rebuild_failed',
        'executed',
        'rollback_committed',
        'rolled_back',
        'retired'
      )`,
    ),
  ],
);

export const processingQueueOutbox = fitness.table(
  "processing_queue_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id").notNull(),
    queueName: text("queue_name").notNull(),
    jobId: text("job_id").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "processing_queue_outbox_operation_fk",
      columns: [table.operationId],
      foreignColumns: [processingOperation.id],
    }).onDelete("cascade"),
    unique("processing_queue_outbox_job_key").on(table.queueName, table.jobId),
    index("processing_queue_outbox_dispatch_idx").on(table.status, table.createdAt),
    check(
      "processing_queue_outbox_status_valid",
      sql`${table.status} IN ('pending', 'dispatched', 'completed', 'failed')`,
    ),
  ],
);
