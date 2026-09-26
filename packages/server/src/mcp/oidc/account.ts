import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../../lib/typed-sql.ts";

const accountRowSchema = z.object({ id: z.string().uuid() });
const accountIdSchema = z.string().uuid();

/**
 * Dofek session/account bridge for oidc-provider.
 *
 * Dofek does not keep an OIDC "account" with claims — the authorization server
 * is OAuth-only (no `openid`, no ID Tokens). The `findAccount` callback only
 * needs to resolve a stable, non-empty `accountId` for a given Dofek `userId`
 * (the Dofek session primary key is itself a UUID we use verbatim). Claims are
 * an empty object because Dofek exposes no OIDC claims and `sub` is derived
 * from `accountId` by oidc-provider itself.
 */

export interface DofekOidcAccount {
  accountId: string;
  claims(): Promise<Record<string, never>>;
}

/**
 * Resolve a Dofek `userId` into an oidc-provider account only while the user
 * still exists. This also prevents stale session rows from creating grants
 * after account deletion has begun.
 */
export async function findAccount(
  db: Pick<Database, "execute">,
  _ctx: unknown,
  userId: string,
): Promise<DofekOidcAccount | undefined> {
  const accountId = accountIdSchema.safeParse(userId);
  if (!accountId.success) return undefined;
  const rows = await executeWithSchema(
    db,
    accountRowSchema,
    sql`SELECT id FROM fitness.user_profile WHERE id = ${accountId.data}::uuid LIMIT 1`,
  );
  if (!rows[0]) return undefined;
  return {
    accountId: accountId.data,
    claims: async () => ({}),
  };
}
