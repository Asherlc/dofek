# Shared Pending Email Signup Store

## Problem

The OAuth callback stores pending email signup state in a module-local `Map`, while
`POST /auth/complete-signup` reads it in a later request. Production runs multiple web
replicas, so the requests can reach different processes. A restart or rolling deployment
also discards otherwise-valid state.

The pending entry contains provider credentials and must remain available for ten minutes,
survive replica changes, support retries after validation or transient failures, and be
consumed once after successful completion.

## Chosen Design

Add a dedicated `PendingEmailSignupStore` beside the existing Redis-backed authentication
stores. It will have in-memory and Redis implementations with the same interface:

- `issue(entry)` creates a cryptographically random token and stores the entry for ten minutes.
- `get(token)` reads a valid entry without consuming it.
- `claim(token)` obtains an exclusive, short-lived completion lease and returns the entry plus
  an opaque claim identifier.
- `renew(claim)` extends an unexpired lease only when the opaque claim identifier still owns it.
- `release(claim)` releases an owned claim after a failed completion attempt.
- `complete(claim)` atomically deletes the pending entry and its owned claim after success.

The Redis implementation will store entries and claims under separate namespaced keys. Claims
will use Redis `SET` with `NX` and `PX`, plus a unique owner value. Release and completion will
use Lua scripts that compare the owner value before deleting keys. Renewal uses the same atomic
owner comparison before resetting the claim key to exactly 60,000 milliseconds with `PEXPIRE`;
Redis documents that `PEXPIRE` sets a key's expiration in milliseconds:
https://redis.io/docs/latest/commands/pexpire/. This follows Redis's documented single-instance
locking pattern and prevents one request from renewing or releasing another request's lease:
https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/.

The in-memory implementation will provide equivalent behavior for Docker-free unit tests.

## Data Model and Validation

The store owns the pending-entry type and validates serialized Redis values with Zod. The schema
contains only the fields already required by signup completion:

- provider ID and display name
- optional provider API base URL
- provider account ID and optional display name
- OAuth token set
- optional mobile redirect scheme
- optional post-login return path

`TokenSet.expiresAt` is serialized as JSON and restored as a `Date` at the runtime boundary.
Malformed or schema-invalid Redis values are deleted and treated as missing. Parse failures are
reported to Sentry as sanitized constant errors without recording the original parser error,
serialized value, entry, or credentials.

## Request Flow

The OAuth callback awaits `issue(entry)` and renders the returned token in the existing form.

Completion first uses `get(token)` so an invalid email can re-render the form without acquiring
or consuming a claim. After email validation succeeds, it calls `claim(token)` before any
database or credential writes:

1. A missing entry returns the existing expired-session response.
2. An existing claim returns a conflict response and performs no side effects.
3. A successful claim supplies the validated pending entry.
4. The request starts a non-overlapping renewal loop immediately after claiming. Every 20 seconds,
   it atomically verifies ownership and resets the claim TTL to exactly 60 seconds.
5. Any renewal failure is retained and checked after each awaited completion stage, preventing
   later credential or session writes and preventing the request from reporting success.
6. Before completion or release, the request clears the timer and awaits any in-flight renewal.
7. Any thrown completion error releases the claim and leaves the pending entry's original TTL
   unchanged.
8. Web session setup or mobile exchange-code issuance completes before `complete(claim)`.
9. `complete(claim)` deletes the entry and claim together, making later submissions invalid.

The claim has a 60-second TTL so a terminated process cannot block the pending token forever.
Active requests renew at a fixed 20-second cadence, leaving two renewal opportunities before the
lease would expire. Renewal changes only the claim TTL. The pending entry retains its original
ten-minute TTL, and retrying never extends the signup window.

## Alternatives Rejected

Extending the OAuth state store would combine unrelated schemas and lifecycle operations in one
interface. Reusing the identity-flow store would couple provider credential state to identity
provider PKCE state.

Deleting the entry before completion and recreating it on failure would make concurrent use
simple, but a process termination between deletion and restoration would destroy a valid signup
session. The claim design keeps the durable entry intact until successful completion.

## Testing

Unit tests will prove:

- one Redis store instance can issue state that another instance can read and claim;
- Redis writes use the ten-minute TTL;
- malformed data is rejected without exposing its contents;
- only one concurrent claimant succeeds;
- owner-safe renewal extends an active claim across its original lease expiry;
- expired or stale owners cannot renew a claim;
- releasing a failed claim preserves the entry for retry;
- completing a claim makes the token single-use;
- an expired in-memory entry cannot be read or claimed.

Route tests will continue covering invalid-email and transient-failure retries. They will be
updated for asynchronous store operations and will verify that a second submission after success
is rejected. A fake-timer route test will delay completion past 60 seconds and verify the
20-second renewal keeps a second request at conflict without duplicate writes. Renewal-failure
coverage will verify the request fails, releases the claim, and leaves no active timer or
unhandled renewal promise. Focused server tests, type checking, and linting will validate the
implementation.

## Scope

This change only replaces pending email signup state storage and coordinates completion. It does
not change the signup form, provider token format, account-linking policy, session format, Redis
deployment, or user-visible success redirects.
