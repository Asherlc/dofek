# Shared Pending Email Signup Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace process-local pending email signup state with a Redis-backed, retry-safe, single-use store shared by all web replicas.

**Architecture:** Add a focused store with in-memory and Redis implementations beside the existing authentication state stores. Redis entries retain their original ten-minute TTL while a unique-owner, 60-second Redis lease serializes valid completion requests. Active completion requests renew that lease every 20 seconds with an atomic owner comparison and `PEXPIRE`; route code stops and awaits renewal before release or atomic completion.

**Tech Stack:** TypeScript, Vitest, Zod, BullMQ `RedisConnection`, Redis `SET NX PX`, Redis Lua scripts, Sentry.

## Global Constraints

- Pending entries expire exactly 600,000 milliseconds after issuance; retries never extend that TTL.
- Completion claims expire after 60,000 milliseconds.
- Active completion requests renew claims every 20,000 milliseconds without overlapping renewals.
- Renewal must atomically compare the claim owner before resetting the claim TTL to exactly 60,000
  milliseconds with Redis `PEXPIRE`, which sets expiration in milliseconds:
  https://redis.io/docs/latest/commands/pexpire/.
- Stop and await renewal before every `complete` or `release`; a renewal failure must prevent a
  success response.
- A valid completion must claim the token before database, credential, session, or mobile-exchange writes.
- Invalid email and transient completion failures must leave the pending entry retryable.
- Successful completion must delete the pending entry and claim exactly once.
- Never log or report serialized entries, access tokens, or refresh tokens, including through
  Redis command errors raised while issuing an entry.
- Do not add a dependency, environment variable, migration, or deployment change.
- All shell commands use the repository-required `rtk` prefix.

---

### Task 1: Build the Pending Email Signup Store

**Files:**
- Create: `packages/server/src/lib/pending-email-signup-store.ts`
- Create: `packages/server/src/lib/pending-email-signup-store.test.ts`

**Interfaces:**
- Consumes: `TokenSet` from `dofek/auth/oauth`, `RedisConnection` from `bullmq`, `getRedisConnection()` from `dofek/jobs/queues`, and `Sentry.captureException`.
- Produces:

```typescript
export interface PendingEmailSignupEntry {
  providerId: string;
  providerName: string;
  apiBaseUrl?: string;
  identity: {
    providerAccountId: string;
    email: null;
    name: string | null;
  };
  tokens: TokenSet;
  mobileScheme?: string;
  returnTo?: string;
}

export interface PendingEmailSignupClaim {
  token: string;
  claimId: string;
  entry: PendingEmailSignupEntry;
}

export interface PendingEmailSignupStore {
  issue(entry: PendingEmailSignupEntry): Promise<string>;
  get(token: string): Promise<PendingEmailSignupEntry | null>;
  claim(token: string): Promise<PendingEmailSignupClaim | null>;
  renew(claim: PendingEmailSignupClaim): Promise<void>;
  release(claim: PendingEmailSignupClaim): Promise<void>;
  complete(claim: PendingEmailSignupClaim): Promise<void>;
}

export class InMemoryPendingEmailSignupStore implements PendingEmailSignupStore
export class RedisPendingEmailSignupStore implements PendingEmailSignupStore
export function getPendingEmailSignupStore(): PendingEmailSignupStore
```

- [ ] **Step 1: Write cross-instance Redis tests first**

Create a shared fake command client in
`packages/server/src/lib/pending-email-signup-store.test.ts`. It must model `SET` with `PX` and
optional `NX`, `GET`, `DEL`, and the two exact `EVAL` operations used by the store while sharing
one backing `Map` between two `RedisPendingEmailSignupStore` instances.

Add this first regression test:

```typescript
it("shares a pending signup across Redis store instances and completes it once", async () => {
  const client = new FakeRedisCommandClient();
  const callbackStore = new RedisPendingEmailSignupStore(async () => client);
  const completionStore = new RedisPendingEmailSignupStore(async () => client);

  const token = await callbackStore.issue(sampleEntry);
  expect(await completionStore.get(token)).toEqual(sampleEntry);

  const claim = await completionStore.claim(token);
  expect(claim?.entry).toEqual(sampleEntry);
  if (!claim) throw new Error("Expected completion claim");

  await completionStore.complete(claim);
  await expect(callbackStore.get(token)).resolves.toBeNull();
  await expect(callbackStore.claim(token)).resolves.toBeNull();
});
```

The fixture must include nullable token fields and a real `Date`:

```typescript
const sampleEntry: PendingEmailSignupEntry = {
  providerId: "strava",
  providerName: "Strava",
  identity: {
    providerAccountId: "provider-account-1",
    email: null,
    name: "Runner",
  },
  tokens: {
    accessToken: "access-token",
    refreshToken: null,
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    scopes: null,
  },
  returnTo: "/settings",
};
```

- [ ] **Step 2: Run the regression test and verify RED**

Run:

```bash
rtk pnpm exec vitest run --project unit packages/server/src/lib/pending-email-signup-store.test.ts
```

Expected: FAIL because `pending-email-signup-store.ts` does not exist.

- [ ] **Step 3: Add the public types, schemas, and constants**

Create `packages/server/src/lib/pending-email-signup-store.ts` with:

```typescript
import { randomBytes } from "node:crypto";
import * as Sentry from "@sentry/node";
import { RedisConnection } from "bullmq";
import type { TokenSet } from "dofek/auth/oauth";
import { getRedisConnection } from "dofek/jobs/queues";
import { z } from "zod";

const ENTRY_TTL_MS = 10 * 60 * 1000;
const CLAIM_TTL_MS = 60 * 1000;
const ENTRY_PREFIX = "pending-email-signup:";
const CLAIM_PREFIX = "pending-email-signup-claim:";

const pendingEmailSignupEntrySchema = z.object({
  providerId: z.string(),
  providerName: z.string(),
  apiBaseUrl: z.string().optional(),
  identity: z.object({
    providerAccountId: z.string(),
    email: z.null(),
    name: z.string().nullable(),
  }),
  tokens: z.object({
    accessToken: z.string(),
    refreshToken: z.string().nullable(),
    expiresAt: z.coerce.date(),
    scopes: z.string().nullable(),
  }),
  mobileScheme: z.string().optional(),
  returnTo: z.string().optional(),
});

export type PendingEmailSignupEntry = z.infer<typeof pendingEmailSignupEntrySchema>;

export interface PendingEmailSignupClaim {
  token: string;
  claimId: string;
  entry: PendingEmailSignupEntry;
}

export interface PendingEmailSignupStore {
  issue(entry: PendingEmailSignupEntry): Promise<string>;
  get(token: string): Promise<PendingEmailSignupEntry | null>;
  claim(token: string): Promise<PendingEmailSignupClaim | null>;
  renew(claim: PendingEmailSignupClaim): Promise<void>;
  release(claim: PendingEmailSignupClaim): Promise<void>;
  complete(claim: PendingEmailSignupClaim): Promise<void>;
}
```

Use private `#entries` and `#claims` fields in the in-memory class. `issue` records
`expiresAt = Date.now() + ENTRY_TTL_MS`; `get` removes and rejects expired entries; `claim`
rejects missing entries and unexpired claims, replaces expired claims, and generates
`randomBytes(16).toString("hex")`; `release` and `complete` compare the stored claim ID before
deleting. `complete` deletes both keys only for the current owner.

- [ ] **Step 4: Add Redis persistence, validation, and owner-safe scripts**

Define the injected Redis boundary without `any` or double casts:

```typescript
interface RedisCommandClient {
  sendCommand(command: string[]): Promise<unknown>;
}
```

Use these scripts:

```typescript
const RELEASE_CLAIM_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

const RENEW_CLAIM_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

const COMPLETE_CLAIM_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  redis.call("del", KEYS[1])
  return redis.call("del", KEYS[2])
end
return 0
`;
```

Implement commands exactly as follows:

```typescript
await client.sendCommand(["SET", entryKey(token), JSON.stringify(entry), "PX", `${ENTRY_TTL_MS}`]);
await client.sendCommand(["GET", entryKey(token)]);
await client.sendCommand([
  "SET",
  claimKey(token),
  claimId,
  "NX",
  "PX",
  `${CLAIM_TTL_MS}`,
]);
await client.sendCommand(["EVAL", RELEASE_CLAIM_SCRIPT, "1", claimKey(token), claimId]);
await client.sendCommand([
  "EVAL",
  RENEW_CLAIM_SCRIPT,
  "1",
  claimKey(token),
  claimId,
  `${CLAIM_TTL_MS}`,
]);
await client.sendCommand([
  "EVAL",
  COMPLETE_CLAIM_SCRIPT,
  "2",
  claimKey(token),
  entryKey(token),
  claimId,
]);
```

Require `SET` to return `"OK"` during `issue`; otherwise throw
`Failed to store pending email signup`. Catch a rejected issuance `SET` command and replace its
error with that same constant message without retaining the original error, because Redis errors
may include the serialized entry and provider credentials. Treat a claim `SET` result other than
`"OK"` as a busy claim and return `null`. After acquiring a claim, call `get`; if the entry is
missing or invalid, release the claim and return `null`.

Parse only string `GET` results. On malformed JSON or a failed Zod parse, delete the entry and
report a sanitized constant error so a parser message cannot include credential fragments:

```typescript
Sentry.captureException(new Error("Invalid pending email signup Redis payload"), {
  tags: {
    context: "pending-email-signup-parse",
    reason: "json",
  },
});
await client.sendCommand(["DEL", entryKey(token)]);
return null;
```

Use `reason: "schema"` for a failed Zod parse. Never pass the parser error, Zod error, raw
payload, entry, or credentials to Sentry.

Require `complete` to return a Redis integer result of `1`. If the owner comparison fails, throw
`Pending email signup claim is no longer owned` so the route cannot report success after its
lease was lost. Require `renew` to return the same integer result of `1`; otherwise throw that
same error. The in-memory implementation must enforce an unexpired matching owner before setting
`expiresAt = Date.now() + claimTtlMs`.

Create one module-level shared `RedisConnection`, validate that its client has a callable
`sendCommand`, and expose:

```typescript
const defaultStore: PendingEmailSignupStore =
  process.env.NODE_ENV === "test"
    ? new InMemoryPendingEmailSignupStore()
    : new RedisPendingEmailSignupStore();

export function getPendingEmailSignupStore(): PendingEmailSignupStore {
  return defaultStore;
}
```

- [ ] **Step 5: Add locking, retry, expiry, validation, and secrecy tests**

Add focused tests that assert:

```typescript
expect(client.commands[0]).toEqual([
  "SET",
  expect.stringMatching(/^pending-email-signup:[a-f0-9]{32}$/),
  expect.any(String),
  "PX",
  "600000",
]);
```

Also test:

- two simultaneous `claim(token)` calls yield one claim and one `null`;
- `release(claim)` allows a later claim without rewriting or extending the entry;
- `complete(claim)` makes both `get` and `claim` return `null`;
- a stale owner cannot release or complete a newer claim;
- renewal crosses the original claim expiry while continuing to exclude a second claimant;
- expired and stale owners cannot renew;
- malformed JSON and schema-invalid JSON are deleted, reported to Sentry, and return `null`;
- the Sentry mock was not called with either known token fixture string;
- an `InMemoryPendingEmailSignupStore({ entryTtlMs: 1, claimTtlMs: 1 })` rejects expired entries;
- the factory selects in-memory in tests and Redis outside tests, following the existing
  module-reset pattern in `identity-flow-store.test.ts`.

Allow optional TTL constructor overrides only on the in-memory implementation for deterministic
unit tests:

```typescript
constructor(options: { entryTtlMs?: number; claimTtlMs?: number } = {})
```

- [ ] **Step 6: Run the store tests and verify GREEN**

Run:

```bash
rtk pnpm exec vitest run --project unit packages/server/src/lib/pending-email-signup-store.test.ts
```

Expected: all pending email signup store tests PASS with no warnings.

- [ ] **Step 7: Commit the standalone store**

```bash
rtk git add packages/server/src/lib/pending-email-signup-store.ts packages/server/src/lib/pending-email-signup-store.test.ts
rtk git commit -m "fix(auth): share pending signup state"
```

---

### Task 2: Wire Callback and Completion Routes to the Shared Store

**Files:**
- Modify: `packages/server/src/routes/auth/shared.ts`
- Modify: `packages/server/src/routes/auth/shared.test.ts`
- Modify: `packages/server/src/routes/auth/data-provider-callback.ts`
- Modify: `packages/server/src/routes/auth/data-provider-callback.test.ts`
- Modify: `packages/server/src/routes/auth/complete-signup.ts`
- Modify: `packages/server/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: `PendingEmailSignupStore`, `PendingEmailSignupEntry`, and
  `getPendingEmailSignupStore()` from Task 1.
- Produces:

```typescript
export function getPendingEmailSignupStoreRef(): PendingEmailSignupStore;
```

- [ ] **Step 1: Write route-level RED tests for cross-instance access and post-success reuse**

In `packages/server/src/routes/auth.test.ts`, keep the existing callback-to-completion test and
add an assertion that the same token cannot complete twice:

```typescript
const reusedTokenRes = await request(app, "post", "/auth/complete-signup", {
  formBody: { token, email: "runner@example.com" },
});

expect(reusedTokenRes.status).toBe(400);
expect(reusedTokenRes.body).toContain("Signup session expired");
expect(createSession).toHaveBeenCalledTimes(1);
```

In `packages/server/src/routes/auth/shared.test.ts`, replace direct synchronous map tests with
factory wiring assertions:

```typescript
expect(getPendingEmailSignupStoreRef()).toBeInstanceOf(InMemoryPendingEmailSignupStore);
```

Update the callback unit mock in `data-provider-callback.test.ts` to expose:

```typescript
getPendingEmailSignupStoreRef: vi.fn(() => ({
  issue: mockIssuePendingEmailSignup,
})),
```

and assert the missing-email callback awaits `issue` and renders its returned token.

- [ ] **Step 2: Run the affected tests and verify RED**

Run:

```bash
rtk pnpm exec vitest run --project unit \
  packages/server/src/routes/auth/shared.test.ts \
  packages/server/src/routes/auth/data-provider-callback.test.ts \
  packages/server/src/routes/auth.test.ts
```

Expected: FAIL because `shared.ts` still exposes the synchronous map helpers and successful
completion does not use the new store.

- [ ] **Step 3: Replace the map wiring in `shared.ts`**

Remove the `randomBytes` and `TokenSet` imports, `PendingEmailSignupEntry`, the module-local
`Map`, and the three map helper functions.

Add:

```typescript
import {
  getPendingEmailSignupStore,
  type PendingEmailSignupStore,
} from "../../lib/pending-email-signup-store.ts";

let pendingEmailSignupStore: PendingEmailSignupStore;

export function initAuthStores(database: import("dofek/db").Database): void {
  db = database;
  identityFlowStore = getIdentityFlowStore();
  oauthStateStore = getOAuthStateStore();
  oauth1SecretStore = getOAuth1SecretStore();
  pendingEmailSignupStore = getPendingEmailSignupStore();
  mobileAuthExchangeStore =
    process.env.NODE_ENV === "test"
      ? new InMemoryMobileAuthExchangeStore()
      : new RedisMobileAuthExchangeStore();
}

export function getPendingEmailSignupStoreRef(): PendingEmailSignupStore {
  return pendingEmailSignupStore;
}
```

- [ ] **Step 4: Await Redis issuance in the OAuth callback**

In `data-provider-callback.ts`, replace the old helper import with
`getPendingEmailSignupStoreRef` and change:

```typescript
const token = await getPendingEmailSignupStoreRef().issue({
  providerId,
  providerName: provider.name,
  apiBaseUrl: setup.apiBaseUrl,
  identity: {
    providerAccountId: identity.providerAccountId,
    email: null,
    name: identity.name,
  },
  tokens,
  mobileScheme: stateEntry.mobileScheme,
  returnTo,
});
```

Do not log the entry or token data.

- [ ] **Step 5: Claim and finalize completion in `complete-signup.ts`**

Import `PendingEmailSignupClaim` from the new store and keep one nullable local outside the
top-level `try`:

```typescript
let pendingClaim: PendingEmailSignupClaim | null = null;
```

Keep a nullable renewal controller beside the claim. Immediately after a successful claim, start
a fixed 20,000-millisecond interval. Each tick may start `pendingStore.renew(pendingClaim)` only
when no renewal is already in flight, and every rejection must be observed and retained as a
sanitized renewal failure. Do not log or report the pending entry, token, claim token, claim ID, or
the underlying Redis command error.

Check the retained renewal failure after each awaited completion stage so a failed renewal stops
later provider-credential, session, or mobile-exchange writes as soon as the current awaited stage
settles.

Read without consuming before email validation:

```typescript
const pendingStore = getPendingEmailSignupStoreRef();
const pending = await pendingStore.get(token);
if (!pending) {
  res.status(400).type("text/plain").send("Signup session expired — please try again");
  return;
}
```

After valid email parsing and before `resolveOrCreateUser`, claim the entry:

```typescript
pendingClaim = await pendingStore.claim(token);
if (!pendingClaim) {
  if (!(await pendingStore.get(token))) {
    res.status(400).type("text/plain").send("Signup session expired — please try again");
    return;
  }
  res.status(409).type("text/plain").send("Signup is already being completed — please try again");
  return;
}
const claimedPending = pendingClaim.entry;
```

Before every `complete(pendingClaim)` or `release(pendingClaim)`, clear the interval and await any
in-flight renewal. If renewal failed, do not complete or report success; enter the existing failure
path and release the still-owned claim after renewal has stopped. The provider-missing branch and
the top-level `catch` must also stop and await renewal before releasing. This prevents timer or
promise leaks and ensures no renewal can race with completion or release.

Use `claimedPending` for every subsequent identity, provider, token, mobile, and return-path
read. For mobile, issue the exchange code before completing the claim:

```typescript
const exchangeCode = await getMobileAuthExchangeStoreRef().issue({
  kind: "session",
  sessionId: sessionInfo.sessionId,
  isNewUser,
});
await pendingStore.complete(pendingClaim);
pendingClaim = null;
res.redirect(`${claimedPending.mobileScheme}://auth/callback?code=${exchangeCode}`);
```

For web, complete the claim after the session exists but before setting the cookie, logging, and
redirecting:

```typescript
await pendingStore.complete(pendingClaim);
pendingClaim = null;
setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
logger.info(`[auth] User ${userId} completed signup via ${claimedPending.providerId}`);
res.redirect(getPostLoginRedirect(claimedPending.returnTo, isNewUser));
```

At the start of the existing `catch`, release only an acquired claim and separately report a
release failure without recording entry data:

```typescript
if (pendingClaim) {
  try {
    await getPendingEmailSignupStoreRef().release(pendingClaim);
  } catch (releaseError: unknown) {
    Sentry.captureException(releaseError, {
      tags: { context: "pending-email-signup-release" },
    });
    logger.error(`[auth] Releasing pending signup claim failed: ${releaseError}`);
  }
}
Sentry.captureException(err);
```

- [ ] **Step 6: Preserve and extend route behavior tests**

Update existing tests to await asynchronous store behavior. Keep the existing tests proving:

- invalid email re-renders the form and the same token remains available;
- a transient `resolveOrCreateUser` failure returns 500 and the same token succeeds on retry;
- a missing provider returns 500 without deleting the pending entry;
- mobile exchange issuance occurs before successful consumption.

Add a fake-timer concurrency test that delays the first `resolveOrCreateUser` completion, advances
past the original 60,000-millisecond lease, posts the same valid token twice, and asserts the
second response is 409 with no second credential/session write. Resolve the first promise and
assert it finishes with 302. The test must exercise the 20,000-millisecond cadence rather than
manually calling `renew`.

Add focused renewal-failure cleanup coverage: reject a scheduled renewal, finish the delayed
database operation, and assert the request returns 500, does not call `complete`, releases the
claim, preserves the entry, reports only the sanitized renewal error, and leaves no renewal timer
or unhandled promise.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
rtk pnpm exec vitest run --project unit \
  packages/server/src/lib/pending-email-signup-store.test.ts \
  packages/server/src/routes/auth/shared.test.ts \
  packages/server/src/routes/auth/data-provider-callback.test.ts \
  packages/server/src/routes/auth.test.ts
```

Expected: all focused auth tests PASS with no unhandled rejections or warnings.

- [ ] **Step 8: Run server type checking and changed-file lint**

Run:

```bash
rtk pnpm --filter dofek-server typecheck
rtk pnpm exec biome check \
  packages/server/src/lib/pending-email-signup-store.ts \
  packages/server/src/lib/pending-email-signup-store.test.ts \
  packages/server/src/routes/auth/shared.ts \
  packages/server/src/routes/auth/shared.test.ts \
  packages/server/src/routes/auth/data-provider-callback.ts \
  packages/server/src/routes/auth/data-provider-callback.test.ts \
  packages/server/src/routes/auth/complete-signup.ts \
  packages/server/src/routes/auth.test.ts
```

Expected: both commands exit 0 with no diagnostics.

- [ ] **Step 9: Run the broader changed-test tier**

Run:

```bash
rtk pnpm test:changed
```

Expected: all unit and mobile tests affected relative to `origin/main` PASS.

- [ ] **Step 10: Commit route integration**

```bash
rtk git add \
  packages/server/src/routes/auth/shared.ts \
  packages/server/src/routes/auth/shared.test.ts \
  packages/server/src/routes/auth/data-provider-callback.ts \
  packages/server/src/routes/auth/data-provider-callback.test.ts \
  packages/server/src/routes/auth/complete-signup.ts \
  packages/server/src/routes/auth.test.ts
rtk git commit -m "fix(auth): consume pending signup once"
```

---

### Task 3: Final Verification and Review

**Files:**
- Review only: all files changed by Tasks 1 and 2

**Interfaces:**
- Consumes: completed store and route integration.
- Produces: verified implementation ready for branch completion.

- [ ] **Step 1: Inspect the complete branch diff**

```bash
rtk git diff --check origin/main...
rtk git diff --stat origin/main...
rtk git diff origin/main... -- \
  packages/server/src/lib/pending-email-signup-store.ts \
  packages/server/src/lib/pending-email-signup-store.test.ts \
  packages/server/src/routes/auth/shared.ts \
  packages/server/src/routes/auth/shared.test.ts \
  packages/server/src/routes/auth/data-provider-callback.ts \
  packages/server/src/routes/auth/data-provider-callback.test.ts \
  packages/server/src/routes/auth/complete-signup.ts \
  packages/server/src/routes/auth.test.ts
```

Expected: no whitespace errors, no token values in logging statements, no process-local pending
signup map, and no unrelated changes.

- [ ] **Step 2: Run final verification**

```bash
rtk pnpm --filter dofek-server typecheck
rtk pnpm test:changed
```

Expected: both commands exit 0.

- [ ] **Step 3: Confirm the worktree is clean**

```bash
rtk git status --short --branch
```

Expected: the branch is shown with no unstaged or uncommitted files.
