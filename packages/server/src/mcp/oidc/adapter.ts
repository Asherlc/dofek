import { createHash } from "node:crypto";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../../lib/typed-sql.ts";

/**
 * Postgres-backed adapter for oidc-provider.
 *
 * oidc-provider persists each model artifact (Client, AccessToken, Grant,
 * Session, AuthorizationCode, RefreshToken, Interaction, etc.) via a small
 * `Adapter` contract: `find`, `findByUid`, `findByUserCode`, `upsert`,
 * `consume`, `destroy`, and `revokeByGrantId`. This adapter stores every
 * artifact in a single generic table (`fitness.mcp_oidc_adapter`) keyed by
 * `(model, id)`, the canonical layout used by oidc-provider's relational
 * adapters. Secondary indexes mirror the in-memory adapter: `uid` for Session
 * lookup, `userCode` for DeviceCode lookup, and `grantId` for token-family
 * revocation.
 *
 * This adapter is the canonical storage for OAuth state.
 */

export interface AdapterPayload {
  // Unknown at compile time: oidc-provider stores arbitrary artifact state.
  [key: string]: unknown;
}

const adapterRowSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  expires_at: z.union([z.string(), z.date()]).nullable(),
});

type ExecutableDatabase = Pick<Database, "execute">;

const adapterUserIdSchema = z.string().uuid();

/**
 * Derives the `user_id` ownership column from an artifact's `accountId`.
 * Client metadata and other shared artifacts have no account id. Only valid
 * UUIDs map to `user_id` so account erasure can attribute and delete a user's
 * rows while leaving shared rows untouched.
 */
export function resolveAdapterUserId(accountId: unknown): string | null {
  const result = adapterUserIdSchema.safeParse(accountId);
  return result.success ? result.data : null;
}

/**
 * Derives the `expires_at` column for an adapter upsert. A numeric
 * `expiresIn` (seconds, as oidc-provider supplies) becomes an absolute
 * timestamp; anything else means the artifact does not expire.
 */
export function resolveExpiresAt(expiresIn?: number): Date | null {
  if (typeof expiresIn !== "number") return null;
  return new Date(Date.now() + expiresIn * 1000);
}

const nowEpoch = (): number => Math.floor(Date.now() / 1000);
const protectedIdModels = new Set([
  "AccessToken",
  "AuthorizationCode",
  "DeviceCode",
  "RefreshToken",
  "Session",
]);

function storedId(model: string, id: string): string {
  return protectedIdModels.has(model) ? createHash("sha256").update(id).digest("hex") : id;
}

function isExpired(expiresAt: string | Date | null | undefined): boolean {
  if (expiresAt === null || expiresAt === undefined) return false;
  const timestamp = new Date(expiresAt).getTime();
  return Number.isNaN(timestamp) ? false : timestamp <= Date.now();
}

export class McpOidcAdapter {
  readonly #db: ExecutableDatabase;
  readonly model: string;

  constructor(db: ExecutableDatabase, model: string) {
    this.#db = db;
    this.model = model;
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const expiresAt = resolveExpiresAt(expiresIn);
    const userId = resolveAdapterUserId(payload.accountId);
    await this.#db.execute(
      sql`INSERT INTO fitness.mcp_oidc_adapter (model, id, payload, uid, user_id, user_code, grant_id, expires_at)
          VALUES (
            ${this.model}, ${storedId(this.model, id)}, ${payload},
            ${payload.uid ?? null}, ${userId}, ${payload.userCode ?? null}, ${payload.grantId ?? null},
            ${expiresAt}
          )
          ON CONFLICT (model, id) DO UPDATE
          SET payload = EXCLUDED.payload,
              uid = EXCLUDED.uid,
              user_id = EXCLUDED.user_id,
              user_code = EXCLUDED.user_code,
              grant_id = EXCLUDED.grant_id,
              expires_at = EXCLUDED.expires_at`,
    );
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    return this.#findByColumn("id", id);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.#findByColumn("uid", uid);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.#findByColumn("user_code", userCode);
  }

  async #findByColumn(
    column: "id" | "uid" | "user_code",
    value: string,
  ): Promise<AdapterPayload | undefined> {
    let query: ReturnType<typeof sql>;
    if (column === "id") {
      query = sql`SELECT payload, expires_at FROM fitness.mcp_oidc_adapter
                  WHERE model = ${this.model} AND id = ${storedId(this.model, value)} LIMIT 1`;
    } else if (column === "uid") {
      query = sql`SELECT payload, expires_at FROM fitness.mcp_oidc_adapter
                  WHERE model = ${this.model} AND uid = ${value} LIMIT 1`;
    } else {
      query = sql`SELECT payload, expires_at FROM fitness.mcp_oidc_adapter
                  WHERE model = ${this.model} AND user_code = ${value} LIMIT 1`;
    }
    const rows = await executeWithSchema(this.#db, adapterRowSchema, query);
    const row = rows[0];
    if (!row || isExpired(row.expires_at)) return undefined;
    return row.payload;
  }

  async consume(id: string): Promise<void> {
    await this.#db.execute(
      sql`UPDATE fitness.mcp_oidc_adapter
          SET payload = jsonb_set(payload, '{consumed}', to_jsonb(${nowEpoch()}::bigint))
          WHERE model = ${this.model} AND id = ${storedId(this.model, id)}`,
    );
  }

  async destroy(id: string): Promise<void> {
    await this.#db.execute(
      sql`DELETE FROM fitness.mcp_oidc_adapter WHERE model = ${this.model} AND id = ${storedId(this.model, id)}`,
    );
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.#db.execute(
      sql`DELETE FROM fitness.mcp_oidc_adapter WHERE model = ${this.model} AND grant_id = ${grantId}`,
    );
  }
}

/**
 * Factory conforming to oidc-provider's `adapter` option: a function that
 * receives the model name and returns an `Adapter` instance.
 */
export function createMcpOidcAdapter(db: ExecutableDatabase) {
  return (model: string): McpOidcAdapter => new McpOidcAdapter(db, model);
}
