import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { fitness, resolveImplicitUserId } from "./core.ts";
import { userProfile } from "./reference.ts";

export type HumanRecordFieldDecision =
  | { operation: "set"; value: string | number | boolean | null }
  | { operation: "clear" };

export const humanRecordIdentity = fitness.table(
  "human_record_identity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    domain: text("domain").notNull(),
    namespace: text("namespace").notNull(),
    sourceKey: text("source_key").notNull(),
  },
  (table) => [
    unique("human_record_identity_source_key").on(
      table.userId,
      table.domain,
      table.namespace,
      table.sourceKey,
    ),
    unique("human_record_identity_owner_key").on(table.id, table.userId),
    check(
      "human_record_identity_parts_nonempty",
      sql`length(btrim(${table.domain})) > 0 AND length(btrim(${table.namespace})) > 0 AND length(btrim(${table.sourceKey})) > 0`,
    ),
  ],
);

export const humanRecordChange = fitness.table(
  "human_record_change",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    requestId: uuid("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    kind: text("kind", {
      enum: ["create", "update", "clear", "delete", "restore", "undo", "legacy_delete"],
    }).notNull(),
    channel: text("channel", { enum: ["web", "mobile", "mcp", "migration"] }).notNull(),
    clientId: text("client_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    schemaVersion: bigint("schema_version", { mode: "number" }).notNull(),
    undoChangeId: uuid("undo_change_id"),
  },
  (table) => [
    unique("human_record_change_request_key").on(table.userId, table.requestId),
    unique("human_record_change_owner_key").on(table.id, table.userId),
    foreignKey({
      name: "human_record_change_undo_fk",
      columns: [table.undoChangeId, table.userId],
      foreignColumns: [table.id, table.userId],
    }),
    check("human_record_change_hash_valid", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "human_record_change_kind_valid",
      sql`${table.kind} IN ('create', 'update', 'clear', 'delete', 'restore', 'undo', 'legacy_delete')`,
    ),
    check(
      "human_record_change_channel_valid",
      sql`${table.channel} IN ('web', 'mobile', 'mcp', 'migration')`,
    ),
    check(
      "human_record_change_client_valid",
      sql`${table.channel} <> 'mcp' OR (${table.clientId} IS NOT NULL AND length(btrim(${table.clientId})) > 0)`,
    ),
    check("human_record_change_version_positive", sql`${table.schemaVersion} > 0`),
  ],
);

export const humanRecordTarget = fitness.table(
  "human_record_target",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().$defaultFn(resolveImplicitUserId),
    identityId: uuid("identity_id").notNull(),
    changeId: uuid("change_id").notNull(),
    predecessorId: uuid("predecessor_id"),
    fields: jsonb("fields").$type<Record<string, HumanRecordFieldDecision>>().notNull().default({}),
    deleted: boolean("deleted"),
  },
  (table) => [
    unique("human_record_target_change_key").on(table.identityId, table.changeId),
    unique("human_record_target_successor_key")
      .on(table.identityId, table.predecessorId)
      .nullsNotDistinct(),
    unique("human_record_target_owner_key").on(table.id, table.identityId, table.userId),
    foreignKey({
      name: "human_record_target_identity_fk",
      columns: [table.identityId, table.userId],
      foreignColumns: [humanRecordIdentity.id, humanRecordIdentity.userId],
    }),
    foreignKey({
      name: "human_record_target_change_fk",
      columns: [table.changeId, table.userId],
      foreignColumns: [humanRecordChange.id, humanRecordChange.userId],
    }),
    foreignKey({
      name: "human_record_target_predecessor_fk",
      columns: [table.predecessorId, table.identityId, table.userId],
      foreignColumns: [table.id, table.identityId, table.userId],
    }),
    check(
      "human_record_target_not_self",
      sql`${table.predecessorId} IS NULL OR ${table.predecessorId} <> ${table.id}`,
    ),
    check(
      "human_record_target_fields_valid",
      sql`fitness.human_record_fields_valid(${table.fields})`,
    ),
  ],
);
