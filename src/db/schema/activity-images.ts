import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ImageDiscovery, ProviderImageCandidate } from "../../activity-images/types.ts";
import { activity } from "./activity.ts";
import { climbingLogEntry } from "./climbing.ts";
import { fitness } from "./core.ts";
import { provider, userProfile } from "./reference.ts";

export const activityImageObject = fitness.table(
  "activity_image_object",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("activity_image_object_user_hash_idx").on(t.userId, t.sha256),
    uniqueIndex("activity_image_object_user_id_idx").on(t.userId, t.id),
    uniqueIndex("activity_image_object_key_idx").on(t.objectKey),
    check("activity_image_object_hash", sql`${t.sha256} ~ '^[a-f0-9]{64}$'`),
    check(
      "activity_image_object_dimensions",
      sql`${t.width} > 0 AND ${t.height} > 0 AND ${t.sizeBytes} > 0`,
    ),
  ],
);

export const activityImage = fitness.table(
  "activity_image",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    activityId: uuid("activity_id"),
    climbingLogEntryId: uuid("climbing_log_entry_id"),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    sourceId: text("source_id").notNull(),
    candidate: jsonb("candidate").$type<ProviderImageCandidate>().notNull(),
    generation: integer("generation").notNull().default(1),
    objectId: uuid("object_id"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("activity_image_source_idx").on(t.userId, t.activityId, t.providerId, t.sourceId),
    uniqueIndex("activity_image_climbing_source_idx").on(
      t.userId,
      t.climbingLogEntryId,
      t.providerId,
      t.sourceId,
    ),
    uniqueIndex("activity_image_user_id_idx").on(t.userId, t.id),
    index("activity_image_user_object_idx")
      .on(t.userId, t.objectId)
      .where(sql`${t.objectId} IS NOT NULL`),
    foreignKey({
      columns: [t.userId, t.activityId],
      foreignColumns: [activity.userId, activity.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.userId, t.providerId, t.climbingLogEntryId],
      foreignColumns: [climbingLogEntry.userId, climbingLogEntry.providerId, climbingLogEntry.id],
      name: "activity_image_owned_climbing_log_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.userId, t.objectId],
      foreignColumns: [activityImageObject.userId, activityImageObject.id],
      name: "activity_image_owned_object_fk",
    }),
    check("activity_image_generation", sql`${t.generation} > 0`),
    check(
      "activity_image_one_owner",
      sql`num_nonnulls(${t.activityId}, ${t.climbingLogEntryId}) = 1`,
    ),
  ],
);

export const activityImageDiscovery = fitness.table(
  "activity_image_discovery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    activityId: uuid("activity_id"),
    climbingLogEntryId: uuid("climbing_log_entry_id"),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    coverage: text("coverage").$type<ImageDiscovery["coverage"]>().notNull(),
    expectedCount: integer("expected_count"),
    reason: text("reason"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("activity_image_discovery_source_idx").on(t.userId, t.activityId, t.providerId),
    uniqueIndex("activity_image_discovery_climbing_source_idx").on(
      t.userId,
      t.climbingLogEntryId,
      t.providerId,
    ),
    foreignKey({
      columns: [t.userId, t.activityId],
      foreignColumns: [activity.userId, activity.id],
      name: "activity_image_discovery_owned_activity_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.userId, t.providerId, t.climbingLogEntryId],
      foreignColumns: [climbingLogEntry.userId, climbingLogEntry.providerId, climbingLogEntry.id],
      name: "activity_image_discovery_owned_climbing_log_fk",
    }).onDelete("cascade"),
    check(
      "activity_image_discovery_one_owner",
      sql`num_nonnulls(${t.activityId}, ${t.climbingLogEntryId}) = 1`,
    ),
    check(
      "activity_image_discovery_coverage",
      sql`${t.coverage} IN ('complete', 'partial', 'unavailable', 'failed')`,
    ),
  ],
);

export const activityImageWork = fitness.table(
  "activity_image_work",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    imageId: uuid("image_id").notNull(),
    generation: integer("generation").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    processingAt: timestamp("processing_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.imageId],
      foreignColumns: [activityImage.userId, activityImage.id],
      name: "activity_image_work_owned_image_fk",
    }).onDelete("cascade"),
    index("activity_image_work_pending_idx").on(t.state, t.availableAt),
    index("activity_image_work_user_image_idx").on(t.userId, t.imageId),
    check(
      "activity_image_work_state",
      sql`${t.state} IN ('pending','processing','stored','retryable_failure','terminal_failure')`,
    ),
  ],
);

export const activityImageBackfill = fitness.table("activity_image_backfill", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => userProfile.id),
  providerId: text("provider_id")
    .notNull()
    .references(() => provider.id),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  cursorStartedAt: timestamp("cursor_started_at", { withTimezone: true }),
  cursorId: uuid("cursor_id"),
  highWaterAt: timestamp("high_water_at", { withTimezone: true }).notNull().defaultNow(),
  scanned: integer("scanned").notNull().default(0),
  discovered: integer("discovered").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  state: text("state").notNull().default("pending"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
