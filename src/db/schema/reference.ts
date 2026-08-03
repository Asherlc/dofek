import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  DEFAULT_PROVIDER_PRIORITY,
  DEFAULT_SENSOR_PROVIDER_PRIORITY,
} from "../provider-priority.ts";
import { fitness, resolveImplicitUserId } from "./core.ts";

// ============================================================
// User profile — multi-user support
// ============================================================

export const userProfile = fitness.table("user_profile", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").unique(),
  birthDate: date("birth_date"),
  maxHr: smallint("max_hr"),
  restingHr: smallint("resting_hr"),
  ftp: smallint("ftp"),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Reference / lookup tables
// ============================================================

export const provider = fitness.table(
  "provider",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    apiBaseUrl: text("api_base_url"),
    /** @deprecated Legacy owner cleared during migration. Ownership lives in provider_connection. */
    userId: uuid("user_id").references(() => userProfile.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("provider_user_name_idx").on(table.userId, table.name)],
);

export const providerConnection = fitness.table(
  "provider_connection",
  {
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.providerId] }),
    index("provider_connection_provider_idx").on(table.providerId),
  ],
);

export const providerPriority = fitness.table("provider_priority", {
  providerId: text("provider_id").primaryKey(),
  priority: integer("priority").notNull().default(DEFAULT_PROVIDER_PRIORITY),
  sleepPriority: integer("sleep_priority"),
  bodyPriority: integer("body_priority"),
  recoveryPriority: integer("recovery_priority"),
  dailyActivityPriority: integer("daily_activity_priority"),
});

export const devicePriority = fitness.table(
  "device_priority",
  {
    providerId: text("provider_id").notNull(),
    sourceNamePattern: text("source_name_pattern").notNull(),
    priority: integer("priority"),
    sleepPriority: integer("sleep_priority"),
    bodyPriority: integer("body_priority"),
    recoveryPriority: integer("recovery_priority"),
    dailyActivityPriority: integer("daily_activity_priority"),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.sourceNamePattern] })],
);

export const sensorProviderPriority = fitness.table(
  "sensor_provider_priority",
  {
    providerId: text("provider_id").notNull(),
    channel: text("channel").notNull(),
    priority: bigint("priority", { mode: "number" })
      .notNull()
      .default(DEFAULT_SENSOR_PROVIDER_PRIORITY),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.channel] })],
);

export const sensorDevicePriority = fitness.table(
  "sensor_device_priority",
  {
    providerId: text("provider_id").notNull(),
    sourceNamePattern: text("source_name_pattern").notNull(),
    channel: text("channel").notNull(),
    priority: bigint("priority", { mode: "number" })
      .notNull()
      .default(DEFAULT_SENSOR_PROVIDER_PRIORITY),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.sourceNamePattern, table.channel] })],
);

export const providerPriorityAudit = fitness.table(
  "provider_priority_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    changedBy: text("changed_by").notNull(),
    priorityTable: text("priority_table").notNull(),
    providerId: text("provider_id").notNull(),
    sourceNamePattern: text("source_name_pattern"),
    channel: text("channel"),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    reason: text("reason"),
  },
  (table) => [
    index("provider_priority_audit_changed_at_idx").on(table.changedAt),
    index("provider_priority_audit_provider_idx").on(table.providerId),
  ],
);

export const exercise = fitness.table(
  "exercise",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    muscleGroup: text("muscle_group"),
    muscleGroups: text("muscle_groups").array(),
    equipment: text("equipment"),
    exerciseType: text("exercise_type"),
    movement: text("movement"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("exercise_name_equipment_idx").on(table.name, table.equipment)],
);

export const exerciseAlias = fitness.table(
  "exercise_alias",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercise.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id, { onDelete: "cascade" }),
    providerExerciseId: text("provider_exercise_id"),
    providerExerciseName: text("provider_exercise_name").notNull(),
  },
  (table) => [
    uniqueIndex("exercise_alias_id_exercise_idx").on(table.id, table.exerciseId),
    uniqueIndex("exercise_alias_provider_name_idx").on(
      table.providerId,
      table.providerExerciseName,
    ),
  ],
);

/**
 * Canonical ownership/provenance for shared exercise catalog rows.
 *
 * System rows keep seeded/shared exercises alive. User rows identify the
 * provider import that caused a user to contribute or reuse an exercise.
 */
export const exerciseSource = fitness.table(
  "exercise_source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercise.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    userId: uuid("user_id").references(() => userProfile.id, {
      onDelete: "cascade",
    }),
    providerId: text("provider_id").references(() => provider.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "exercise_source_shape_valid",
      sql`(
        ${table.sourceKind} = 'system'
        AND ${table.userId} IS NULL
        AND ${table.providerId} IS NULL
      ) OR (
        ${table.sourceKind} = 'user'
        AND ${table.userId} IS NOT NULL
        AND ${table.providerId} IS NOT NULL
      )`,
    ),
    uniqueIndex("exercise_source_id_exercise_idx").on(table.id, table.exerciseId),
    uniqueIndex("exercise_source_system_idx")
      .on(table.exerciseId)
      .where(sql`${table.sourceKind} = 'system'`),
    uniqueIndex("exercise_source_user_provider_idx")
      .on(table.exerciseId, table.userId, table.providerId)
      .where(sql`${table.sourceKind} = 'user'`),
    index("exercise_source_user_idx").on(table.userId),
  ],
);

/** Attributes a provider alias to the same source as its exercise. */
export const exerciseAliasSource = fitness.table(
  "exercise_alias_source",
  {
    aliasId: uuid("alias_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    exerciseId: uuid("exercise_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.aliasId, table.sourceId] }),
    foreignKey({
      columns: [table.aliasId, table.exerciseId],
      foreignColumns: [exerciseAlias.id, exerciseAlias.exerciseId],
      name: "exercise_alias_source_alias_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sourceId, table.exerciseId],
      foreignColumns: [exerciseSource.id, exerciseSource.exerciseId],
      name: "exercise_alias_source_source_fkey",
    }).onDelete("cascade"),
    index("exercise_alias_source_exercise_idx").on(table.exerciseId),
    index("exercise_alias_source_source_idx").on(table.sourceId),
  ],
);

// ============================================================
// OAuth tokens
// ============================================================

export const oauthToken = fitness.table(
  "oauth_token",
  {
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    providerAccountId: text("provider_account_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    scopes: text("scopes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "oauth_token_provider_account_id_nonempty",
      sql`${table.providerAccountId} IS NULL OR length(${table.providerAccountId}) > 0`,
    ),
    primaryKey({ columns: [table.userId, table.providerId] }),
    foreignKey({
      columns: [table.userId, table.providerId],
      foreignColumns: [providerConnection.userId, providerConnection.providerId],
      name: "oauth_token_provider_connection_fkey",
    }).onDelete("cascade"),
    index("oauth_token_provider_idx").on(table.providerId),
    index("oauth_token_user_idx").on(table.userId),
  ],
);

// ============================================================
// Webhook subscriptions
// ============================================================

export const webhookSubscription = fitness.table(
  "webhook_subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** User owner for per-user subscriptions. App-level subscriptions leave this NULL. */
    userId: uuid("user_id"),
    /** Provider ID for per-user subscriptions. App-level subscriptions leave this NULL. */
    providerId: text("provider_id").references(() => provider.id),
    /** Provider name for app-level subscriptions where there's no per-user provider row */
    providerName: text("provider_name").notNull(),
    /** Subscription ID from the provider's API (for unsubscribe) */
    subscriptionExternalId: text("subscription_external_id"),
    /** Random token used for validation challenges */
    verifyToken: text("verify_token").notNull(),
    /** HMAC key or signing secret from the provider (for signature verification) */
    signingSecret: text("signing_secret"),
    /** Current subscription state */
    status: text("status").notNull().default("active"),
    /** When this subscription expires (Oura requires renewal) */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Provider-specific metadata (JSON) */
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId, table.providerId],
      foreignColumns: [providerConnection.userId, providerConnection.providerId],
      name: "webhook_subscription_provider_connection_fkey",
    }).onDelete("cascade"),
    uniqueIndex("webhook_subscription_app_provider_name_idx")
      .on(table.providerName)
      .where(sql`${table.userId} IS NULL AND ${table.status} = 'active'`),
    uniqueIndex("webhook_subscription_user_provider_idx")
      .on(table.userId, table.providerId)
      .where(
        sql`${table.userId} IS NOT NULL AND ${table.providerId} IS NOT NULL AND ${table.status} = 'active'`,
      ),
    index("webhook_subscription_provider_name_idx").on(table.providerName),
  ],
);
