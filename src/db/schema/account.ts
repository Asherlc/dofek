import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { fitness, resolveImplicitUserId } from "./core.ts";
import { userProfile } from "./reference.ts";

// ============================================================
// Authentication — links external OAuth identities to users
// ============================================================

export const authAccount = fitness.table(
  "auth_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    authProvider: text("auth_provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    email: text("email"),
    name: text("name"),
    groups: text("groups").array(),
    revocationAccessToken: text("revocation_access_token"),
    revocationRefreshToken: text("revocation_refresh_token"),
    revocationClientId: text("revocation_client_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_account_provider_id_idx").on(table.authProvider, table.providerAccountId),
    index("auth_account_user_idx").on(table.userId),
  ],
);

// ============================================================
// Password credentials — email/password login for Dofek accounts
// ============================================================

export const userPasswordCredential = fitness.table("user_password_credential", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => userProfile.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Sessions — database-backed session tokens
// ============================================================

export const session = fitness.table(
  "session",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("session_user_idx").on(table.userId),
    index("session_expires_idx").on(table.expiresAt),
  ],
);

export const companionToken = fitness.table(
  "companion_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    connectionType: text("connection_type").notNull().default("zepp-main"),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "companion_token_connection_type_check",
      sql`${table.connectionType} IN ('zepp-main', 'zepp-workout')`,
    ),
    uniqueIndex("companion_token_user_connection_type_idx")
      .on(table.userId, table.connectionType)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

// ============================================================
// Durable account erasure
// ============================================================

/**
 * Short-lived activation capabilities created before account erasure begins.
 *
 * The bearer itself is never stored. This table intentionally has no user
 * foreign key because activation deletes authentication state in the same
 * transaction that consumes the preparation.
 */
export const accountErasurePreparation = fitness.table(
  "account_erasure_preparation",
  {
    userId: uuid("user_id").primaryKey(),
    requestId: uuid("request_id").notNull(),
    preparationTokenHash: text("preparation_token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("account_erasure_preparation_request_idx").on(table.requestId),
    uniqueIndex("account_erasure_preparation_token_idx").on(table.preparationTokenHash),
  ],
);

/**
 * Live account-erasure state plus the opaque public-status credential.
 *
 * userId intentionally has no foreign key: the coordinator clears it only after
 * deleting user_profile, while the pseudonymous request remains available for
 * restore-ledger enforcement and public completion status.
 */
export const accountErasureRequest = fitness.table(
  "account_erasure_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id"),
    userHash: text("user_hash").notNull(),
    userHashKeyId: text("user_hash_key_id").notNull(),
    writeFenceHash: text("write_fence_hash").notNull(),
    preparationTokenHash: text("preparation_token_hash"),
    statusTokenHash: text("status_token_hash").notNull(),
    status: text("status").notNull().default("pending"),
    currentPhase: text("current_phase"),
    encryptedRemoteSnapshot: text("encrypted_remote_snapshot"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    replayRetainedUntil: timestamp("replay_retained_until", { withTimezone: true }).notNull(),
    completionDeadline: timestamp("completion_deadline", { withTimezone: true }).notNull(),
    retryAt: timestamp("retry_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    phaseProgress: jsonb("phase_progress").notNull().default({}),
    failureCount: bigint("failure_count", { mode: "number" }).notNull().default(0),
    recoveredFromRestore: timestamp("recovered_from_restore", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    piiScrubbedAt: timestamp("pii_scrubbed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "account_erasure_request_status_valid",
      sql`${table.status} IN (
        'pending',
        'running',
        'waiting_replay',
        'waiting_retention',
        'failed',
        'completed'
      )`,
    ),
    uniqueIndex("account_erasure_request_active_user_idx").on(table.userId),
    uniqueIndex("account_erasure_request_write_fence_idx").on(table.writeFenceHash),
    uniqueIndex("account_erasure_request_preparation_token_idx").on(table.preparationTokenHash),
    uniqueIndex("account_erasure_request_status_token_idx").on(table.statusTokenHash),
    index("account_erasure_request_status_retry_idx").on(table.status, table.retryAt),
  ],
);

export const accountErasureCheckpoint = fitness.table(
  "account_erasure_checkpoint",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => accountErasureRequest.id, { onDelete: "cascade" }),
    phase: text("phase").notNull(),
    details: jsonb("details"),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.requestId, table.phase] })],
);

export const accountErasureIdentityFence = fitness.table(
  "account_erasure_identity_fence",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => accountErasureRequest.id, { onDelete: "restrict" }),
    identityKind: text("identity_kind").notNull(),
    keyId: text("key_id").notNull(),
    identityHash: text("identity_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "account_erasure_identity_fence_kind_valid",
      sql`${table.identityKind} IN ('provider_account', 'email')`,
    ),
    primaryKey({
      columns: [table.identityKind, table.keyId, table.identityHash],
    }),
    index("account_erasure_identity_fence_request_idx").on(table.requestId),
  ],
);

export const accountErasureOutbox = fitness.table(
  "account_erasure_outbox",
  {
    requestId: uuid("request_id")
      .primaryKey()
      .references(() => accountErasureRequest.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  },
  (table) => [
    check("account_erasure_outbox_status_valid", sql`${table.status} IN ('pending', 'dispatched')`),
    index("account_erasure_outbox_pending_idx").on(table.status, table.createdAt),
  ],
);

// ============================================================
// MCP access tokens — per-user bearer tokens for remote MCP clients
// ============================================================

export const mcpAccessToken = fitness.table(
  "mcp_access_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    oauthClientId: text("oauth_client_id"),
    oauthResource: text("oauth_resource"),
  },
  (table) => [
    index("mcp_access_token_user_idx").on(table.userId),
    index("mcp_access_token_token_hash_idx").on(table.tokenHash),
    index("mcp_access_token_active_idx").on(table.userId, table.revokedAt, table.expiresAt),
  ],
);

export const mcpOauthClient = fitness.table("mcp_oauth_client", {
  clientId: text("client_id").primaryKey(),
  clientSecret: text("client_secret"),
  clientMetadata: jsonb("client_metadata").notNull(),
  clientIdIssuedAt: bigint("client_id_issued_at", { mode: "number" }),
  clientSecretExpiresAt: bigint("client_secret_expires_at", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpOauthAuthorizationCode = fitness.table(
  "mcp_oauth_authorization_code",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeHash: text("code_hash").notNull().unique(),
    clientId: text("client_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().notNull(),
    codeChallenge: text("code_challenge").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("mcp_oauth_authorization_code_expires_idx").on(table.expiresAt)],
);

export const mcpOauthRefreshToken = fitness.table(
  "mcp_oauth_refresh_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    clientId: text("client_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    accessTokenId: uuid("access_token_id")
      .notNull()
      .references(() => mcpAccessToken.id, { onDelete: "cascade" }),
    parentRefreshTokenId: uuid("parent_refresh_token_id"),
    scopes: text("scopes").array().notNull(),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.parentRefreshTokenId],
      foreignColumns: [table.id],
      name: "mcp_oauth_refresh_token_parent_fk",
    }).onDelete("cascade"),
    index("mcp_oauth_refresh_token_active_idx").on(
      table.clientId,
      table.revokedAt,
      table.expiresAt,
    ),
    index("mcp_oauth_refresh_token_parent_idx").on(table.parentRefreshTokenId),
  ],
);

// User billing — subscription state and internal paid grants
// ============================================================

export const userBilling = fitness.table(
  "user_billing",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").unique(),
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    stripeSubscriptionStatus: text("stripe_subscription_status"),
    stripeCurrentPeriodEnd: timestamp("stripe_current_period_end", { withTimezone: true }),
    stripeSubscriptionEventId: text("stripe_subscription_event_id"),
    stripeSubscriptionEventCreated: bigint("stripe_subscription_event_created", {
      mode: "number",
    }),
    appStoreAccountToken: uuid("app_store_account_token"),
    appStoreOriginalTransactionId: text("app_store_original_transaction_id"),
    appStoreTransactionId: text("app_store_transaction_id"),
    appStoreProductId: text("app_store_product_id"),
    appStoreSubscriptionStatus: text("app_store_subscription_status"),
    appStoreExpiresAt: timestamp("app_store_expires_at", { withTimezone: true }),
    appStoreRevocationAt: timestamp("app_store_revocation_at", { withTimezone: true }),
    appStoreEnvironment: text("app_store_environment"),
    paidGrantReason: text("paid_grant_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("user_billing_stripe_customer_idx").on(table.stripeCustomerId),
    index("user_billing_stripe_subscription_idx").on(table.stripeSubscriptionId),
    uniqueIndex("user_billing_app_store_account_token_unique")
      .on(table.appStoreAccountToken)
      .where(sql`${table.appStoreAccountToken} IS NOT NULL`),
    uniqueIndex("user_billing_app_store_original_transaction_id_unique")
      .on(table.appStoreOriginalTransactionId)
      .where(sql`${table.appStoreOriginalTransactionId} IS NOT NULL`),
    uniqueIndex("user_billing_app_store_transaction_id_unique")
      .on(table.appStoreTransactionId)
      .where(sql`${table.appStoreTransactionId} IS NOT NULL`),
  ],
);

export const userExternalEffect = fitness.table(
  "user_external_effect",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    system: text("system").notNull(),
    resourceType: text("resource_type").notNull(),
    externalId: text("external_id").notNull(),
    contactEmail: text("contact_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "user_external_effect_supported_resource",
      sql`(
        ${table.system} = 'stripe'
        AND ${table.resourceType} = 'customer'
      ) OR (
        ${table.system} = 'zoho_desk'
        AND ${table.resourceType} = 'ticket'
      )`,
    ),
    uniqueIndex("user_external_effect_resource_idx").on(
      table.system,
      table.resourceType,
      table.externalId,
    ),
    index("user_external_effect_user_idx").on(table.userId),
  ],
);

export const stripeWebhookEvent = fitness.table("stripe_webhook_event", {
  eventId: text("event_id").primaryKey(),
  eventCreated: bigint("event_created", { mode: "number" }).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Global App Store notification replay-protection ledger.
 *
 * This intentionally has no user foreign key so account erasure cannot remove
 * records needed to reject replayed Apple notifications.
 */
export const appStoreNotification = fitness.table("app_store_notification", {
  notificationUuid: uuid("notification_uuid").primaryKey(),
  signedDate: bigint("signed_date", { mode: "number" }).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Data exports — offline user exports stored in R2
// ============================================================

export const dataExport = fitness.table(
  "data_export",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    objectKey: text("object_key"),
    filename: text("filename").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    errorMessage: text("error_message"),
  },
  (table) => [
    index("data_export_user_created_idx").on(table.userId, table.createdAt),
    index("data_export_user_status_idx").on(table.userId, table.status),
    index("data_export_expires_idx").on(table.expiresAt),
  ],
);

// ============================================================
// User settings (key-value store, scoped per user)
// ============================================================

export const userSettings = fitness.table(
  "user_settings",
  {
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })],
);
