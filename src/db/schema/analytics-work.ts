import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { MetricStreamPosition } from "../../metric-stream/transport-position.ts";
import { fitness } from "./core.ts";

export const analyticsQueryOwner = fitness.table("analytics_query_owner", {
  resourceId: text("resource_id").primaryKey(),
  ownerId: uuid("owner_id"),
  backendPid: bigint("backend_pid", { mode: "number" }),
  quiescent: boolean("quiescent").notNull().default(true),
  intentId: text("intent_id"),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().default(sql`'epoch'`),
  queryId: uuid("query_id"),
  queryTerminal: boolean("query_terminal").notNull().default(true),
});

export const analyticsStreamState = fitness.table(
  "analytics_stream_state",
  {
    transport: text("transport", { enum: ["pulsar", "kafka"] }).notNull(),
    epoch: text("epoch").notNull(),
    topic: text("topic").notNull(),
    partition: bigint("partition", { mode: "number" }).notNull(),
    ownerId: uuid("owner_id").notNull(),
    processed: jsonb("processed").$type<MetricStreamPosition>(),
    pending: jsonb("pending").$type<MetricStreamPosition>(),
    groupState: text("group_state", { enum: ["pending", "completed"] }),
    groupFirstPosition: jsonb("group_first_position").$type<MetricStreamPosition>(),
    groupLastPosition: jsonb("group_last_position").$type<MetricStreamPosition>(),
    groupMemberCount: bigint("group_member_count", { mode: "number" }),
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
    AND ${table.groupFirstPosition} IS NULL AND ${table.groupLastPosition} IS NULL
    AND ${table.groupMemberCount} IS NULL AND ${table.groupPositionsDigest} IS NULL
    AND ${table.groupFirstIngestedAt} IS NULL
  ) OR (
    ${table.groupState} IS NOT NULL
    AND ${table.groupFirstPosition} IS NOT NULL AND ${table.groupLastPosition} IS NOT NULL
    AND ${table.groupMemberCount} IS NOT NULL AND ${table.groupPositionsDigest} IS NOT NULL
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
