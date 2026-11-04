import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnalyticsEffectCursor } from "../../analytics/effect-journal.ts";
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
  },
  (table) => [
    primaryKey({ columns: [table.transport, table.epoch, table.topic, table.partition] }),
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
    cursor: jsonb("cursor").$type<AnalyticsEffectCursor>().notNull(),
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
  ],
);
