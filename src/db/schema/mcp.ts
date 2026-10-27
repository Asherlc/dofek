import { index, jsonb, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { fitness } from "./core.ts";
import { userProfile } from "./reference.ts";

/** Generic oidc-provider artifacts; account-owned records cascade on erasure. */
export const mcpOidcAdapter = fitness.table(
  "mcp_oidc_adapter",
  {
    model: text("model").notNull(),
    id: text("id").notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    uid: text("uid"),
    userCode: text("user_code"),
    grantId: text("grant_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id").references(() => userProfile.id, { onDelete: "cascade" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.model, table.id] }),
    index("mcp_oidc_adapter_uid_idx").on(table.model, table.uid),
    index("mcp_oidc_adapter_user_code_idx").on(table.model, table.userCode),
    index("mcp_oidc_adapter_grant_id_idx").on(table.model, table.grantId),
    index("mcp_oidc_adapter_expires_idx").on(table.expiresAt),
    index("mcp_oidc_adapter_user_idx").on(table.userId),
  ],
);
