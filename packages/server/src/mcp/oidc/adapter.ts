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
 * We deliberately do NOT reuse Dofek's `fitness.mcp_oauth_*` tables: those
 * encode Dofek's own hand-rolled authorization flow (SHA-256 token hashes,
 * PKCE challenge columns, a custom refresh-token family graph) and do not map
 * onto oidc-provider's artifact shape without lossy translation. A dedicated,
 * generic table keeps the authorization server's state cleanly isolated and
 * easily re-creatable.
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
 * Derives the `user_id` ownership column from an oidc-provider `uid`.
 * The adapter's `uid` carries the Dofek account id (a uuid string) for
 * user-attributable artifacts (Session, Grant, tokens); client metadata
 * and other shared artifacts have no `uid`. Only valid uuids map to
 * `user_id` so account erasure can attribute and delete a user's rows
 * while leaving shared rows untouched.
 */
export function resolveAdapterUserId(uid: unknown): string | null {
  if (typeof uid !== "string") return null;
  return adapterUserIdSchema.safeParse(uid).success ? uid : null;
}

const nowEpoch = (): number => Math.floor(Date.now() / 1000);

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
    const expiresAt =
      typeof expiresIn === "number" ? new Date(Date.now() + expiresIn * 1000) : null;
    const userId = resolveAdapterUserId(payload.uid);
    await this.#db.execute(
      sql`INSERT INTO fitness.mcp_oidc_adapter (model, id, payload, uid, user_id, user_code, grant_id, expires_at)
          VALUES (
            ${this.model}, ${id}, ${payload},
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
                  WHERE model = ${this.model} AND id = ${value} LIMIT 1`;
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
    const existing = await this.find(id);
    if (!existing) return;
    await this.upsert(id, { ...existing, consumed: nowEpoch() });
  }

  async destroy(id: string): Promise<void> {
    await this.#db.execute(
      sql`DELETE FROM fitness.mcp_oidc_adapter WHERE model = ${this.model} AND id = ${id}`,
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
