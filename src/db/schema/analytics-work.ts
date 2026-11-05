import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  numeric,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnalyticsEffectCursor } from "../../analytics/journal-position.ts";
import type { MetricStreamPosition } from "../../metric-stream/transport-position.ts";
import { fitness } from "./core.ts";
import { processingOperation } from "./processing.ts";
import { userProfile } from "./reference.ts";

export const analyticsQueryOwner = fitness.table("analytics_query_owner", {
  resourceId: text("resource_id").primaryKey(),
  ownerId: uuid("owner_id"),
  backendPid: integer("backend_pid"),
  quiescent: boolean("quiescent").notNull().default(true),
  intentId: text("intent_id"),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().default(sql`'epoch'`),
  queryId: uuid("query_id"),
  queryTerminal: boolean("query_terminal").notNull().default(true),
});

export const analyticsRun = fitness.table("analytics_run", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id"),
  sealed: boolean("sealed").notNull().default(false),
});

export const analyticsRequiredFrontier = fitness.table(
  "analytics_required_frontier",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => analyticsRun.id, { onDelete: "cascade" }),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => processingOperation.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => userProfile.id, { onDelete: "cascade" }),
    datasetKey: text("dataset_key").notNull(),
    transport: text("transport", { enum: ["pulsar", "kafka"] }).notNull(),
    epoch: text("epoch").notNull(),
    topic: text("topic").notNull(),
    partition: integer("partition").notNull(),
    position: jsonb("position").$type<MetricStreamPosition>().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.runId,
        table.operationId,
        table.datasetKey,
        table.transport,
        table.epoch,
        table.topic,
        table.partition,
      ],
    }),
  ],
);

export const analyticsStreamState = fitness.table(
  "analytics_stream_state",
  {
    transport: text("transport", { enum: ["pulsar", "kafka"] }).notNull(),
    epoch: text("epoch").notNull(),
    topic: text("topic").notNull(),
    partition: integer("partition").notNull(),
    ownerId: uuid("owner_id").notNull(),
    processed: jsonb("processed").$type<MetricStreamPosition>(),
    pending: jsonb("pending").$type<MetricStreamPosition>(),
    groupState: text("group_state", { enum: ["pending", "completed"] }),
    groupFirstPosition: jsonb("group_first_position").$type<MetricStreamPosition>(),
    groupLastPosition: jsonb("group_last_position").$type<MetricStreamPosition>(),
    groupMemberCount: integer("group_member_count"),
    groupPositionsDigest: text("group_positions_digest"),
    groupFirstIngestedAt: timestamp("group_first_ingested_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    primaryKey({ columns: [table.transport, table.epoch, table.topic, table.partition] }),
    check(
      "analytics_stream_state_delivery_group",
      sql`(
        ${table.groupState} IS NULL
        AND ${table.groupFirstPosition} IS NULL
        AND ${table.groupLastPosition} IS NULL
        AND ${table.groupMemberCount} IS NULL
        AND ${table.groupPositionsDigest} IS NULL
        AND ${table.groupFirstIngestedAt} IS NULL
      ) OR (
        ${table.groupState} IS NOT NULL
        AND ${table.groupFirstPosition} IS NOT NULL
        AND ${table.groupLastPosition} IS NOT NULL
        AND ${table.groupMemberCount} IS NOT NULL
        AND ${table.groupPositionsDigest} IS NOT NULL
        AND ${table.groupFirstIngestedAt} IS NOT NULL
        AND jsonb_typeof(${table.groupFirstPosition}) = 'object'
        AND jsonb_typeof(${table.groupLastPosition}) = 'object'
        AND ${table.groupMemberCount} BETWEEN 1 AND 500
        AND ${table.groupPositionsDigest} ~ '^[a-f0-9]{64}$'
        AND (
          (${table.groupState} = 'pending' AND ${table.pending} IS NOT NULL
            AND ${table.pending} = ${table.groupLastPosition})
          OR (${table.groupState} = 'completed' AND ${table.pending} IS NULL
            AND ${table.processed} IS NOT NULL AND ${table.processed} = ${table.groupLastPosition})
        )
      )`,
    ),
  ],
);

export const analyticsStageCursor = fitness.table(
  "analytics_stage_cursor",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => analyticsRun.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    transport: text("transport", { enum: ["pulsar", "kafka"] }).notNull(),
    epoch: text("epoch").notNull(),
    topic: text("topic").notNull(),
    partition: integer("partition").notNull(),
    cursor: jsonb("cursor").$type<AnalyticsEffectCursor>(),
    pageAfter: jsonb("page_after").$type<AnalyticsEffectCursor>(),
    pageSize: integer("page_size"),
    pagePublicationRevision: numeric("page_publication_revision", { precision: 20, scale: 0 }),
    pageState: text("page_state", { enum: ["pending", "completed"] }),
    pageNext: jsonb("page_next").$type<AnalyticsEffectCursor>(),
    pageOutputComplete: boolean("page_output_complete").notNull().default(false),
    pageEffectsDigest: text("page_effects_digest"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.runId,
        table.stage,
        table.transport,
        table.epoch,
        table.topic,
        table.partition,
      ],
    }),
    check("analytics_stage_cursor_stage", sql`${table.stage} IN ('scalar','dedup','activity')`),
    check(
      "analytics_stage_cursor_page",
      sql`(
      ${table.pageState} IS NULL AND ${table.pageAfter} IS NULL AND ${table.pageSize} IS NULL AND ${table.pagePublicationRevision} IS NULL AND ${table.pageNext} IS NULL
    ) OR (
      ${table.pageState} IS NOT NULL AND ${table.pageState} IN ('pending','completed') AND ${table.pageSize} IS NOT NULL AND ${table.pageSize} BETWEEN 1 AND 20
      AND ${table.pagePublicationRevision} IS NOT NULL AND ${table.pagePublicationRevision} > 0 AND ${table.pagePublicationRevision} <= 18446744073709551615
      AND (${table.pageState} <> 'completed' OR ${table.pageNext} IS NOT DISTINCT FROM ${table.cursor})
    )`,
    ),
  ],
);
