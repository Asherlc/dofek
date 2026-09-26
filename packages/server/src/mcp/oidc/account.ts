import type { Database } from "dofek/db";

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
 * Resolve a Dofek `userId` into an oidc-provider account. The `_db` argument is
 * accepted for interface symmetry and future claims loading, but the Dofek
 * account requires no persistence lookups today: the `userId` is already the
 * session-derived identity and is returned verbatim as `accountId`.
 */
export function findAccount(
  _db: Pick<Database, "execute">,
  _ctx: unknown,
  userId: string,
): DofekOidcAccount | undefined {
  if (typeof userId !== "string" || userId.length === 0) return undefined;
  return {
    accountId: userId,
    claims: async () => ({}),
  };
}
