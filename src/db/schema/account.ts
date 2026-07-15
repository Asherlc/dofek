import {
  bigint,
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_account_provider_id_idx").on(table.authProvider, table.providerAccountId),
    index("auth_account_user_idx").on(table.userId),
  ],
);

// ============================================================
// Slack installations — multi-workspace bot token storage
// ============================================================

export const slackInstallation = fitness.table(
  "slack_installation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: text("team_id").notNull().unique(),
    teamName: text("team_name"),
    botToken: text("bot_token").notNull(),
    botId: text("bot_id"),
    botUserId: text("bot_user_id"),
    appId: text("app_id"),
    installerSlackUserId: text("installer_slack_user_id"),
    rawInstallation: jsonb("raw_installation").notNull(),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("slack_installation_team_idx").on(table.teamId)],
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
    scopes: text("scopes").array().notNull(),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("mcp_oauth_refresh_token_active_idx").on(
      table.clientId,
      table.revokedAt,
      table.expiresAt,
    ),
  ],
);

// User billing — Stripe subscription state and internal paid grants
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
    paidGrantReason: text("paid_grant_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("user_billing_stripe_customer_idx").on(table.stripeCustomerId),
    index("user_billing_stripe_subscription_idx").on(table.stripeSubscriptionId),
  ],
);

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
