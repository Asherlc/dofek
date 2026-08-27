import { randomBytes } from "node:crypto";
import {
  type DeveloperClientDetail,
  type DeveloperClientInput,
  DeveloperClientInputSchema,
  type DeveloperClientSummary,
  type DeveloperClientUpdate,
  DeveloperClientUpdateSchema,
} from "@dofek/auth/developer-clients";
import type { Database, TransactionDatabase } from "dofek/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  externalClient,
  externalClientAudit,
  externalClientRedirectUri,
  externalGrant,
} from "../../../../src/db/schema/external.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

type DeveloperClientDatabase = Pick<Database, "execute" | "transaction">;
type DeveloperClientQueryDatabase = Pick<TransactionDatabase, "execute"> | DeveloperClientDatabase;

export interface DeveloperClientSupportSummary extends DeveloperClientSummary {
  ownerName: string | null;
  ownerEmail: string | null;
}

const scopesSchema = z.array(z.literal("nutrition:write")).length(1);
const statusSchema = z.enum(["active", "revoked"]);
const secretHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const clientIdRowSchema = z.object({ client_id: z.string().min(1) });
const clientSummaryRowSchema = z.object({
  client_id: z.string().min(1),
  name: z.string().min(1),
  scopes: scopesSchema,
  status: statusSchema,
  created_at: timestampStringSchema,
  last_rotated_at: timestampStringSchema,
});
const clientDetailRowSchema = clientSummaryRowSchema.extend({
  redirect_uris: z.array(z.string()).min(1),
});
const supportSummaryRowSchema = clientSummaryRowSchema.extend({
  owner_name: z.string().nullable(),
  owner_email: z.string().nullable(),
});
const exactRedirectRowSchema = z.object({ has_redirect: z.boolean() });

function toSummary(row: z.infer<typeof clientSummaryRowSchema>): DeveloperClientSummary {
  return {
    clientId: row.client_id,
    name: row.name,
    scopes: row.scopes,
    status: row.status,
    createdAt: row.created_at,
    lastRotatedAt: row.last_rotated_at,
  };
}

function toDetail(row: z.infer<typeof clientDetailRowSchema>): DeveloperClientDetail {
  return { ...toSummary(row), redirectUris: row.redirect_uris };
}

async function readOwned(
  database: DeveloperClientQueryDatabase,
  ownerUserId: string,
  clientId: string,
): Promise<DeveloperClientDetail | null> {
  const rows = await executeWithSchema(
    database,
    clientDetailRowSchema,
    sql`SELECT
          client.client_id,
          client.name,
          client.scopes,
          CASE
            WHEN client.revoked_at IS NULL THEN 'active'
            ELSE 'revoked'
          END AS status,
          client.created_at::text AS created_at,
          client.last_rotated_at::text AS last_rotated_at,
          ARRAY_AGG(redirect.redirect_uri ORDER BY redirect.redirect_uri) AS redirect_uris
        FROM fitness.external_client AS client
        JOIN fitness.external_client_redirect_uri AS redirect
          ON redirect.client_id = client.client_id
        WHERE client.owner_user_id = ${ownerUserId}
          AND client.client_id = ${clientId}
        GROUP BY client.client_id
        LIMIT 1`,
  );
  const row = rows[0];
  return row ? toDetail(row) : null;
}

async function lockActiveClient(
  transaction: TransactionDatabase,
  condition: ReturnType<typeof sql>,
): Promise<boolean> {
  const rows = await executeWithSchema(
    transaction,
    clientIdRowSchema,
    sql`SELECT client_id
        FROM fitness.external_client
        WHERE ${condition}
          AND revoked_at IS NULL
        FOR UPDATE`,
  );
  return rows.length === 1;
}

async function appendAudit(
  transaction: TransactionDatabase,
  input: {
    action: "create" | "update" | "rotate" | "revoke";
    actorUserId: string;
    clientId: string;
  },
): Promise<void> {
  await transaction.insert(externalClientAudit).values(input);
}

async function revokeLockedClient(
  transaction: TransactionDatabase,
  actorUserId: string,
  clientId: string,
): Promise<void> {
  await transaction
    .update(externalClient)
    .set({ revokedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(externalClient.clientId, clientId));
  await transaction
    .update(externalGrant)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(externalGrant.clientId, clientId), isNull(externalGrant.revokedAt)));
  await appendAudit(transaction, { action: "revoke", actorUserId, clientId });
}

export class DeveloperClientRepository {
  readonly #db: DeveloperClientDatabase;

  constructor(db: DeveloperClientDatabase) {
    this.#db = db;
  }

  async listOwned(ownerUserId: string): Promise<DeveloperClientSummary[]> {
    const rows = await executeWithSchema(
      this.#db,
      clientSummaryRowSchema,
      sql`SELECT
            client_id,
            name,
            scopes,
            CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS status,
            created_at::text AS created_at,
            last_rotated_at::text AS last_rotated_at
          FROM fitness.external_client
          WHERE owner_user_id = ${ownerUserId}
          ORDER BY created_at DESC, client_id`,
    );
    return rows.map(toSummary);
  }

  async getOwned(ownerUserId: string, clientId: string): Promise<DeveloperClientDetail | null> {
    return readOwned(this.#db, ownerUserId, clientId);
  }

  async createOwned(
    ownerUserId: string,
    input: DeveloperClientInput,
    secretHash: string,
  ): Promise<DeveloperClientDetail> {
    const parsedInput = DeveloperClientInputSchema.parse(input);
    const parsedSecretHash = secretHashSchema.parse(secretHash);
    const clientId = `ext_${randomBytes(18).toString("base64url")}`;

    return this.#db.transaction(async (transaction) => {
      await transaction.insert(externalClient).values({
        clientId,
        ownerUserId,
        name: parsedInput.name,
        scopes: [...parsedInput.scopes],
        secretHash: parsedSecretHash,
      });
      await transaction
        .insert(externalClientRedirectUri)
        .values(parsedInput.redirectUris.map((redirectUri) => ({ clientId, redirectUri })));
      await appendAudit(transaction, {
        action: "create",
        actorUserId: ownerUserId,
        clientId,
      });
      const detail = await readOwned(transaction, ownerUserId, clientId);
      if (!detail) throw new Error("Created developer client could not be read");
      return detail;
    });
  }

  async updateOwned(
    ownerUserId: string,
    clientId: string,
    input: DeveloperClientUpdate,
  ): Promise<DeveloperClientDetail | null> {
    const parsedInput = DeveloperClientUpdateSchema.parse(input);
    return this.#db.transaction(async (transaction) => {
      const locked = await lockActiveClient(
        transaction,
        sql`client_id = ${clientId} AND owner_user_id = ${ownerUserId}`,
      );
      if (!locked) return null;

      await transaction
        .update(externalClient)
        .set({ name: parsedInput.name, updatedAt: sql`now()` })
        .where(eq(externalClient.clientId, clientId));
      await transaction
        .delete(externalClientRedirectUri)
        .where(eq(externalClientRedirectUri.clientId, clientId));
      await transaction
        .insert(externalClientRedirectUri)
        .values(parsedInput.redirectUris.map((redirectUri) => ({ clientId, redirectUri })));
      await appendAudit(transaction, {
        action: "update",
        actorUserId: ownerUserId,
        clientId,
      });
      const detail = await readOwned(transaction, ownerUserId, clientId);
      if (!detail) throw new Error("Updated developer client could not be read");
      return detail;
    });
  }

  async rotateOwned(
    ownerUserId: string,
    clientId: string,
    secretHash: string,
  ): Promise<DeveloperClientDetail | null> {
    const parsedSecretHash = secretHashSchema.parse(secretHash);
    return this.#db.transaction(async (transaction) => {
      const locked = await lockActiveClient(
        transaction,
        sql`client_id = ${clientId} AND owner_user_id = ${ownerUserId}`,
      );
      if (!locked) return null;

      await transaction
        .update(externalClient)
        .set({
          secretHash: parsedSecretHash,
          lastRotatedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(externalClient.clientId, clientId));
      await appendAudit(transaction, {
        action: "rotate",
        actorUserId: ownerUserId,
        clientId,
      });
      const detail = await readOwned(transaction, ownerUserId, clientId);
      if (!detail) throw new Error("Rotated developer client could not be read");
      return detail;
    });
  }

  async revokeOwned(ownerUserId: string, clientId: string): Promise<boolean> {
    return this.#db.transaction(async (transaction) => {
      const locked = await lockActiveClient(
        transaction,
        sql`client_id = ${clientId} AND owner_user_id = ${ownerUserId}`,
      );
      if (!locked) return false;
      await revokeLockedClient(transaction, ownerUserId, clientId);
      return true;
    });
  }

  async listForSupport(): Promise<DeveloperClientSupportSummary[]> {
    const rows = await executeWithSchema(
      this.#db,
      supportSummaryRowSchema,
      sql`SELECT
            client.client_id,
            client.name,
            client.scopes,
            CASE WHEN client.revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS status,
            client.created_at::text AS created_at,
            client.last_rotated_at::text AS last_rotated_at,
            owner.name AS owner_name,
            owner.email AS owner_email
          FROM fitness.external_client AS client
          LEFT JOIN fitness.user_profile AS owner
            ON owner.id = client.owner_user_id
          ORDER BY client.created_at DESC, client.client_id`,
    );
    return rows.map((row) => ({
      ...toSummary(row),
      ownerName: row.owner_name,
      ownerEmail: row.owner_email,
    }));
  }

  async revokeForSupport(actorUserId: string, clientId: string): Promise<boolean> {
    return this.#db.transaction(async (transaction) => {
      const locked = await lockActiveClient(transaction, sql`client_id = ${clientId}`);
      if (!locked) return false;
      await revokeLockedClient(transaction, actorUserId, clientId);
      return true;
    });
  }

  async hasExactRedirect(clientId: string, redirectUri: string): Promise<boolean> {
    const rows = await executeWithSchema(
      this.#db,
      exactRedirectRowSchema,
      sql`SELECT EXISTS (
            SELECT 1
            FROM fitness.external_client_redirect_uri AS redirect
            JOIN fitness.external_client AS client
              ON client.client_id = redirect.client_id
            WHERE redirect.client_id = ${clientId}
              AND redirect.redirect_uri = ${redirectUri}
              AND client.revoked_at IS NULL
          ) AS has_redirect`,
    );
    return rows[0]?.has_redirect === true;
  }
}
