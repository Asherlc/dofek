# External write API

This document defines the target-agnostic authenticated write boundary for
separately deployed input applications. It is the contract consumed by
external apps such as `slack-food-bot`; it is not a Slack integration API.

The public protocol is versioned REST at `/api/external/v1`, described by
[`packages/server/openapi/external-v1.yaml`](../packages/server/openapi/external-v1.yaml).
tRPC remains the internal first-party API and is not a public integration
contract.

## Client credentials and browser authorization

An authenticated Dofek user registers and manages their own client from
[Developer integrations](/developer-integrations). The creation response
contains a client ID and client secret exactly once. Dofek stores only a
SHA-256 hash of the secret; logs and database rows never contain the raw value.
Owners can update callback URIs, rotate the secret, or revoke the client;
revocation immediately revokes all grants for that client. Clients send
`Authorization: Bearer <clientId>.<clientSecret>`.

The owner registers one or more complete HTTPS callback URIs. Dofek
canonicalizes each URI during registration. `link/start` then requires the
submitted `redirectUri` to be exactly equal to one stored canonical URI; it
does not apply wildcard, prefix, or request-time normalization matching. Exact
redirect URI matching prevents authorization-code leakage and open redirects
as described by
[RFC 9700 section 4.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.1).

`link/start` stores an S256 PKCE challenge and returns a short-lived
authorization URL. The URL requires an existing Dofek browser session and
displays a consent form. Approval posts to `link/authorize`, which redirects
to that exact registered URI with `code`, `link_id`, and optional `state`. The
random code is hashed at rest, expires after 60 seconds, and is consumed once.
Exchange requires the original client credential, link ID, code, verifier, and
application-owned external subject. PKCE binds the code to the initiating
integration as specified by
[RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html).

The owner-management API under `/api/developer/clients` is an authenticated
first-party surface, not part of the public integration protocol. Its
executable request and response contract is the shared developer-client Zod
module rather than this OpenAPI document.

## Ownership boundary

External applications own their provider credentials, installations, pending
drafts, dedupe state, parsing, and user-facing workflows. A separately deployed
Slack Food Bot is a normal registered developer client and owns its Slack
tokens, PKCE verifier and state, Dofek grants, drafts, dedupe data, and specific
user-facing errors. Dofek receives only an authenticated external grant and
canonical write commands. Dofek must not receive Slack bot tokens or require
access to another app's database, Redis, or tRPC internals.

The external identity supplied during linking is an application namespace plus
an application-owned subject, for example `(slack, team_id, user_id)`. Dofek
returns an opaque `externalSubject`; it never returns or accepts a Dofek user
ID as an authority claim.

## Explicit relinking

Existing Slack links in `fitness.auth_account` and
`fitness.slack_team_membership` are not migrated automatically. After the
Slack extraction, a user must complete the new linking flow explicitly. A
subject already linked to another Dofek account returns
`EXTERNAL_IDENTITY_ALREADY_LINKED`; it is never silently reassigned.

The link flow is one-time and PKCE-bound:

1. `POST /api/external/v1/link/start` creates a short-lived authorization transaction.
2. The user authenticates and approves the requested write scope. The consent form carries a single-use token bound to that browser session to prevent cross-site request forgery.
3. The app exchanges the one-time code at `POST /api/external/v1/link/exchange`.
4. Dofek returns an opaque subject, grant ID, and short-lived access token.

Access tokens are opaque bearer tokens with a 15-minute lifetime. Bearer
tokens require HTTPS and must not be placed in URLs or cookies; see
[RFC 6750](https://www.rfc-editor.org/rfc/rfc6750/). Token revocation follows
the immediate invalidation semantics described by
[RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html).

When that token expires, the separately deployed app can call
`POST /api/external/v1/link/reissue` with the original client credential and
the same `{namespace, subject}` external identity. Dofek reissues only the
latest non-revoked grant owned by that exact client and subject; an expired
access token does not by itself revoke the grant. The response has the same
shape as link exchange, keeps the same `grantId` and grant-scoped idempotency
receipts, and returns a fresh 15-minute token. Rotation is atomic: the prior
token stops working as soon as the replacement is committed. Missing,
non-owned, or revoked grants return the privacy-preserving `404 NOT_FOUND`
problem, while invalid client credentials return `401 INVALID_CREDENTIALS`.
An active account-erasure fence returns `423 ACCOUNT_ERASURE_ACTIVE`.

DPoP is not required for the first release. It remains a future sender-
constraining option if threat modeling requires it; it adds proof-key storage,
clock/replay handling, and client complexity
([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html)).

## Confirmed nutrition write

`POST /api/external/v1/nutrition/entries` accepts only confirmed entries. The
request requires an `Idempotency-Key` and contains a date, optional meal,
food name/description/category, units, application external ID, and a map of
canonical nutrient IDs to amounts.

Nutrients are stored only through the existing canonical row path:
`fitness.food_entry` plus `fitness.food_entry_nutrient`, with definitions in
`fitness.nutrient`. No client-specific columns or wide nutrient table may be
added. The existing schema is in
[`src/db/schema/nutrition.ts`](../src/db/schema/nutrition.ts).

The response returns created entry IDs and a server-computed daily intake
projection. The projection is either `available` with display-ready totals and
meal calories, or `unavailable` with the existing conflict/resolution message.
The write itself is not rejected merely because a derived summary is
ambiguous.

The implementation should share the domain command used by
`foodRouter.create` and `FoodRepository.create`, then call
`FoodRepository.nutritionByDate` for the response. The external handler must
not invoke a tRPC procedure directly.

## Idempotency

The server scopes an idempotency receipt by grant, method, normalized path, and
key. It stores the request-body hash and response metadata, not the raw health
payload.

- Same key and same body: return the original response.
- Same key and different body: `409 IDEMPOTENCY_KEY_REUSED`.
- A duplicate application external ID: `409 EXTERNAL_ID_ALREADY_EXISTS`.
- An in-flight receipt: `409 REQUEST_IN_PROGRESS`.
- A successful receipt remains replayable for seven days; completed receipt metadata is then purged opportunistically by accepted nutrition writes.

The application external ID is a domain provenance/idempotency input; it does
not authorize access to an existing row.

## Account-erasure fences

Every external write runs under the existing user write fence and transaction.
The server-side primitives are `withAccountErasureUserWriteFence`,
`lockAndAssertAccountErasureIdentityWriteFence`,
`AccountErasureUserFencedError`, and `AccountErasureIdentityFencedError` in
[`src/db/account-erasure.ts`](../src/db/account-erasure.ts). Database triggers
also enforce the fence in migration
[`drizzle/0062_account_erasure.sql`](../drizzle/0062_account_erasure.sql).

When a link or write is fenced, the public response is `423 Locked`:

```json
{
  "code": "ACCOUNT_ERASURE_ACTIVE",
  "message": "This Dofek account is being deleted. New writes are temporarily unavailable.",
  "retryable": false,
  "requestId": "opaque-request-id"
}
```

Responses and logs must not expose Dofek user IDs, erasure request IDs, fence
hashes, Slack identifiers, tokens, or raw health payloads.

## Bot-owned erasure coordination

The external app registers an erasure callback during link exchange. Dofek
sends a generic signed `account.erasure.started` event containing only the
opaque external subject, event ID, timestamp, and bounded cleanup deadline.

The external app deletes pending drafts and dedupe state for that subject,
revokes its Dofek tokens, and acknowledges the event. Dofek never receives the
app's Slack tokens and never deletes the app's Redis keys.

For a shared Slack installation, the bot removes only the erased user's link
and user-owned pending state. If that user was the sole linked user, the bot
may revoke/uninstall the Slack installation. This distinction is entirely
owned by the bot and is not represented in Dofek's core food schema.

The callback delivery and acknowledgment are idempotent by event ID. The
callback uses an HMAC over timestamp, method, path, and raw body; stale or
replayed events are rejected. This follows the raw-body and timestamp replay
protection pattern documented by
[Slack](https://api.slack.com/docs/verifying-requests-from-slack), without
making Slack a Dofek API dependency.

The first implementation deliberately defers callback delivery and callback
registration. The contract does not yet define callback URL registration,
secret provisioning and rotation, retry policy, delivery status, or whether a
callback may be delivered after every grant is revoked. The implemented
`erasure/ack` route remains available for a separately delivered event, but no
server-side callback worker or ungrounded delivery route is added until those
semantics are specified.

## Error envelope

All external errors use:

```json
{
  "type": "https://api.dofek.example/problems/validation-error",
  "title": "Request validation failed",
  "status": 422,
  "code": "VALIDATION_ERROR",
  "message": "The request is invalid.",
  "requestId": "opaque-request-id",
  "details": []
}
```

Use `401` for missing/invalid credentials, `403` for insufficient scope,
`404` for absent or non-owned resources, `409` for conflicts and idempotency
reuse, `422` for validation, `423` for an account-erasure fence, `429` for
rate limiting, and `503` for retryable infrastructure failures. These meanings
follow the HTTP status semantics in
[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html).

## Implementation references

- Food mutation: `foodRouter.create` in `packages/server/src/routers/food.ts`.
- Food persistence and daily resolution: `FoodRepository.create` and
  `FoodRepository.nutritionByDate` in `packages/server/src/repositories/food-repository.ts`.
- Canonical nutrients: `src/db/schema/nutrition.ts`.
- Existing erasure fence errors and helpers: `src/db/account-erasure.ts`.
- Erasure privacy coverage: `src/db/account-erasure.integration.test.ts`.
