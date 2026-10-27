import { sql } from "drizzle-orm";
import { check, index, jsonb, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { fitness } from "./core.ts";
import { userProfile } from "./reference.ts";

export const externalClient = fitness.table(
  "external_client",
  {
    clientId: text("client_id").primaryKey(),
    ownerUserId: uuid("owner_user_id").references(() => userProfile.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    secretHash: text("secret_hash").notNull(),
    scopes: text("scopes").array().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "external_client_active_owner_check",
      sql`${table.ownerUserId} IS NOT NULL OR ${table.revokedAt} IS NOT NULL`,
    ),
    index("external_client_owner_idx").on(table.ownerUserId),
    index("external_client_last_rotated_idx").on(table.lastRotatedAt),
  ],
);

export const externalClientRedirectUri = fitness.table(
  "external_client_redirect_uri",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => externalClient.clientId, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.redirectUri] }),
    check(
      "external_client_redirect_uri_https_check",
      sql`${table.redirectUri} ~ '^https://[^[:space:]]+$'`,
    ),
    index("external_client_redirect_uri_client_idx").on(table.clientId),
  ],
);

export const externalClientAudit = fitness.table(
  "external_client_audit",
  {
    id: uuid("audit_id").primaryKey().defaultRandom(),
    clientId: text("client_id")
      .notNull()
      .references(() => externalClient.clientId, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => userProfile.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "external_client_audit_action_check",
      sql`${table.action} IN ('create', 'update', 'rotate', 'revoke')`,
    ),
    index("external_client_audit_client_occurred_idx").on(table.clientId, table.occurredAt.desc()),
  ],
);

export const externalLink = fitness.table(
  "external_link",
  {
    linkId: uuid("link_id").primaryKey().defaultRandom(),
    clientId: text("client_id")
      .notNull()
      .references(() => externalClient.clientId, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    requestedScopes: text("requested_scopes").array().notNull(),
    state: text("state"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userId: uuid("user_id").references(() => userProfile.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").unique(),
    codeExpiresAt: timestamp("code_expires_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    exchangedAt: timestamp("exchanged_at", { withTimezone: true }),
    approvalCsrfHash: text("approval_csrf_hash"),
    approvalSessionHash: text("approval_session_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("external_link_expiry_idx").on(table.expiresAt)],
);

export const externalIdentityLink = fitness.table(
  "external_identity_link",
  {
    namespace: text("namespace").notNull(),
    subject: text("subject").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    opaqueSubject: text("opaque_subject").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.namespace, table.subject] })],
);

export const externalGrant = fitness.table(
  "external_grant",
  {
    grantId: uuid("grant_id").primaryKey().defaultRandom(),
    clientId: text("client_id")
      .notNull()
      .references(() => externalClient.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull(),
    subject: text("subject").notNull(),
    opaqueSubject: text("opaque_subject").notNull(),
    accessTokenHash: text("access_token_hash").notNull().unique(),
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("external_grant_lookup_idx").on(
      table.clientId,
      table.namespace,
      table.subject,
      table.revokedAt,
      table.createdAt.desc(),
    ),
  ],
);

export const externalIdempotencyReceipt = fitness.table(
  "external_idempotency_receipt",
  {
    grantId: uuid("grant_id")
      .notNull()
      .references(() => externalGrant.grantId, { onDelete: "cascade" }),
    method: text("method").notNull(),
    path: text("path").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull(),
    responseJson: jsonb("response_json"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.grantId, table.method, table.path, table.idempotencyKey] }),
    check(
      "external_idempotency_receipt_status_check",
      sql`${table.status} IN ('in_progress', 'completed')`,
    ),
    index("external_idempotency_receipt_completed_at_idx")
      .on(table.completedAt)
      .where(sql`${table.status} = 'completed'`),
  ],
);

export const externalErasureAck = fitness.table(
  "external_erasure_ack",
  {
    eventId: text("event_id").primaryKey(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => externalGrant.grantId, { onDelete: "cascade" }),
    result: text("result").notNull(),
    reasonCode: text("reason_code"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("external_erasure_ack_result_check", sql`${table.result} IN ('completed', 'failed')`),
  ],
);
