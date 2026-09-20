# Ziva nutrition sync provider design

## Goal

Add `ziva` as a first-class, read-only nutrition provider. A user connects their
own Ziva account through Dofek's existing Data Sources flow, and the normal
provider scheduler imports saved diary records into Dofek's canonical
`food_entry` and `food_entry_nutrient` storage. The import path is deterministic
TypeScript and does not use an LLM, agent framework, copied bearer token, CSV
export, or second logging workflow.

Ziva publicly states that the product and MCP connection are free, with no paid
tiers or usage limits: [Ziva pricing](https://ziva.fit/pricing). The documented
MCP server is `https://connect.ziva.fit/mcp`: [Ziva MCP documentation](https://ziva.fit/mcp-docs).

## Verified external contract

Live unauthenticated discovery on 2026-09-20 established these facts:

- The MCP endpoint challenges unauthenticated requests with OAuth protected
  resource metadata at
  `https://connect.ziva.fit/.well-known/oauth-protected-resource/mcp`.
- The protected resource identifier is `https://connect.ziva.fit/mcp`, bearer
  tokens are sent in the request header, and no named scopes are advertised.
- Authorization-server metadata at
  `https://connect.ziva.fit/.well-known/oauth-authorization-server` advertises
  authorization-code and refresh-token grants, S256 PKCE, dynamic client
  registration, and `client_secret_post` token authentication.
- No revocation or introspection endpoint is advertised.
- The public tool reference names `get_meals_for_date`, but does not publish its
  input schema, result schema, range limits, pagination, identifiers, timezone
  semantics, nutrient units, completeness signal, or deletion behavior.

An authorized, read-only verification on 2026-09-20 then established the
production contract without creating, modifying, or deleting diary data:

- Ziva accepted dynamic client registration for Dofek's production callback
  and a temporary verification callback, returning the advertised client
  secret.
- Authorization required state, S256 PKCE, and the MCP `resource`. Code
  exchange succeeded without a scope. Access tokens were JWTs with issuer
  `https://connect.ziva.fit/`, audience `https://connect.ziva.fit/mcp`, a stable
  non-empty `sub`, and a 3,600-second lifetime.
- Refresh succeeded unattended. Both access and refresh tokens rotated, and the
  refreshed access token remained authorized for MCP.
- Authenticated `tools/list` returned `get_meals_for_date` with nullable
  `start_date` and `end_date` `YYYY-MM-DD` strings. Its annotations mark it
  read-only, non-destructive, and closed-world.
- A single-date populated read returned the same JSON in `structuredContent`
  and a text content block. A valid empty date returned `meals: []`; neither was
  confused with a tool error.
- A same-day `start_date`/`end_date` pair succeeded, but a range spanning two
  dates returned `isError: true`. Sync therefore makes one call per calendar
  date and does not claim working multi-date range support.

The one verified meal—the only thing the user had logged—contained a stable
`mealId`, `description`, `mealDate`, `mealType`, nullable `mealTime`, `createdAt`,
`itemCount`, an `items` display array, and meal-level `macros`. The one observed
item contained `food`, `portion`, nullable `gramWeight`, and `quantity`, but no
stable item, database-food, or portion identifier. Multi-item response behavior
therefore remains unverified. The user confirmed that the returned calories,
protein, carbohydrate, and fat were totals for the whole logged meal; Dofek
must not scale them again.

The diary response exposed no fiber, micronutrients, nutrient unit fields,
pagination/cursor, completeness marker, update timestamp, or deletion marker.
Its repeated `dailyTargets` are goals rather than intake and are ignored.
Returned `instructions` are also ignored as inert data. Sanitized observed and
clearly labeled synthetic fixtures form the deterministic test contract;
unobserved fields are not presented as supported.

## Authentication architecture

Dofek will be registered once as an independent OAuth client through Ziva's
advertised registration endpoint. Deployment configuration will contain only
the application-level `ZIVA_CLIENT_ID` and `ZIVA_CLIENT_SECRET`; user tokens and
user identity remain per-user encrypted database values. The registered
redirect URI is Dofek's existing `/callback` route.

The provider reuses Dofek's OAuth implementation:

1. The Data Sources action creates random state and an S256 PKCE
   verifier/challenge.
2. Authorization includes the Ziva MCP resource indicator and no fabricated
   scopes.
3. The callback validates state and exchanges the code with
   `client_secret_post` plus the PKCE verifier.
4. Access token, rotated refresh token, expiry, and stable provider account ID
   are persisted through the existing encrypted token repository.
5. Scheduled sync resolves and refreshes tokens through the shared OAuth token
   resolver. Refresh preserves the stored provider account ID and validates the
   refreshed JWT issuer, audience, and `sub` before saving either rotated token.
   A changed subject, malformed credential, or `invalid_grant` removes unusable
   credentials and produces the existing actionable reconnect state rather than
   an empty sync or retry loop.
6. Reconnect replaces the authorization for that Dofek user. Disconnect removes
   Dofek's stored connection and credentials while retaining previously imported
   source data, matching existing provider behavior.

The shared OAuth configuration gains a standards-based optional `resource`
field, sent during authorization, code exchange, and refresh. Existing
providers are unchanged when it is absent. Because Ziva does not advertise a
revocation endpoint, disconnect will not claim to revoke the server-side grant.
An active Ziva connection therefore blocks account-erasure confirmation with an
actionable instruction to disconnect Ziva first; this keeps account deletion
from entering the later remote-revocation phase with an impossible contract.

The verified access-token `sub` is the provider account subject. Dofek validates
the observed issuer and audience, stores `sub` as the encrypted
`providerAccountId`, and namespaces source record keys with an opaque
deterministic digest of it. Reconnecting one Dofek user to a different Ziva
account therefore cannot overwrite records from the former account. Account
identity is never shared across users or stored in raw external IDs as an email
address.

## MCP client boundary

The focused adapter uses the official `@modelcontextprotocol/sdk` package
already adopted by the repository, staying on the compatible v1 line rather
than introducing the separate v2 package. The official SDK repository documents
Streamable HTTP clients and OAuth support:
[Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

Each operation creates a user-bound `Client` and
`StreamableHTTPClientTransport`, initializes protocol negotiation through the
SDK, and closes both in `finally`. No transport, bearer token, or session is
cached across accounts. The adapter exposes only discovery and
`get_meals_for_date`; descriptions and meal text are treated as inert data and
can never cause another tool call.

Dofek's existing Data Sources OAuth flow remains the credential owner because
it already supplies state, PKCE, encrypted persistence, reconnect, and refresh.
The SDK transport receives the resolved bearer through its supported request
initialization hook; an SDK OAuth provider is not also configured, avoiding a
second token store or competing refresh loop.

The adapter:

- checks `tools/list` for the observed tool and compatible input schema;
- calls it with explicit runtime-validated arguments;
- accepts the verified `structuredContent` shape and, if observed live, an
  explicit JSON value in a text content block;
- never extracts records from arbitrary prose or follows returned links;
- distinguishes HTTP/authentication failure, MCP transport/protocol failure,
  a successful HTTP exchange containing `isError`, malformed data, and a valid
  empty result;
- uses the repository's provider HTTP boundary for its bounded request deadline,
  caller cancellation, rate-limit classification, and scheduler-level retry;
- performs at most one forced token refresh after an authenticated 401 and does
  not add a second network retry loop.

## Nutrition mapping

Ziva exposes a stable meal ID and meal-level macro totals, while its item display
array has no stable item IDs or per-item nutrients. Dofek therefore stores one
meal aggregate per stable `mealId`; it neither fabricates child identities nor
imports both item displays and the parent total. The implementation adds a
`meal_aggregate` nutrition-grain value and teaches canonical source selection to
prefer one itemized source, then one meal-aggregate source, then one daily
aggregate source. Analytics labels meal aggregates as meal totals rather than
itemized foods or provider daily totals. The generic nutrition display view
also exposes a meal aggregate once as a meal-total card, so normal food reads,
meal counts, user edits, and hiding continue to work without double counting
the parent and its display-only item array.

The generic food source model also gains an opaque `source_account_key`. Ziva
derives this deterministic key from the Dofek user and verified Ziva subject and
uses a separate account-and-meal digest as the external ID. Canonical source
resolution uses the account key before the display-oriented source name. Rows
from a former and a newly connected Ziva account therefore conflict safely on
an overlapping day instead of being silently summed, while reconnecting the
same account keeps stable record identity.

Each source record preserves the verified meal ID, diary date, description,
meal type, nullable meal time, creation timestamp, item display fields
(`food`, `portion`, `quantity`, and nullable `gramWeight`), source account
namespace, and original provider payload. For the exactly-one-item
shape that was observed, Dofek also maps quantity, portion text, and gram weight
to the existing serving columns. A multi-item response keeps those aggregate
serving columns null and retains the item display array only in raw provenance.
The read exposes no item, database-food, or portion IDs, so Dofek does not
invent or claim them.

The observed `macros` keys map to canonical `calories` (dietary kcal), `protein`
(g), `carbohydrate` (g), and `fat` (g). The response carries no unit fields; this
mapping follows Ziva's documented calories/macros contract and the observed
dashboard values, and performs no unit conversion or rescaling. All four keys
are required before a meal is treated as a complete authoritative record.
Explicit numeric zero is retained, while a missing, null, negative, or malformed
macro rejects the date without changing the prior record or advancing its
checkpoint. The values are already whole-meal totals and are stored directly,
exactly once. Calories are not inferred from macros. Fiber, micronutrients, and
per-item nutrition are unavailable from the verified read and remain absent
rather than synthetic zeros. Unmodeled source fields—including a future
unverified `fiber: 0`—stay in raw provenance and are listed as limitations.

Date-only diary values and explicit backfill bounds are persisted and requested
as their literal `YYYY-MM-DD` calendar dates without conversion through a user
timezone or UTC. Actual RFC 3339 timestamps retain their provided offset/zone;
a timezone-less timestamp is raw provenance only. Dofek does not invent a time
for a date-only record or infer that a populated day is a complete diary.

## Identity, updates, and local edits

The durable external key consists only of the stable Ziva account namespace,
record kind, and stable source ID. Mutable names, quantities, nutrient values,
dates, and array positions are never part of identity.

Every record update runs in a database transaction:

1. Upsert the source food entry by `(Dofek user, ziva, external ID)`.
2. For a source record verified to be complete, replace its canonical nutrient
   set inside the same transaction: upsert current nutrients and remove source
   nutrients no longer present.
3. Commit only after both the parent and nutrient set succeed.

This makes repeated reads idempotent and allows portion, description, meal, and
date edits to update the same logical record. Existing human overrides and
hidden/deleted decisions continue to apply through Dofek's effective-food views
because the source key remains stable. Ziva entries are not fuzzy-deduplicated
against FatSecret or manual foods.

## Synchronization policy

`ZivaProvider` implements the current `sync(run: SyncRun)` contract and uses the
existing worker, queue, progress, sync-log, and continuation mechanisms.

- Initial sync is bounded to two years, matching the existing nutrition-provider
  history bound. Work is split into bounded date slices and continuation jobs so
  one job cannot issue an unbounded number of requests.
- Scheduled sync uses an overlapping recent window so late logs and edits are
  revisited.
- Explicit backfills honor the requested `since` and `until` dates and use the
  same bounded date-slicing path.
- A date checkpoint advances only after all results validate and all
  transactions for that unit commit. A timeout, cancellation, tool error,
  malformed item, or failed date may leave idempotent partial
  writes but cannot advance completion or trigger absence reconciliation.
- Rate limits and retryable database/Redis failures stay in the existing queue
  retry path with their saved failed-date checkpoint. Terminal provider,
  protocol, schema, authentication, timeout, or cancellation failures return an
  error result with the cumulative committed count, so cache invalidation,
  sync-status, and record-count reporting remain accurate without claiming full
  success. A later manual retry replays its requested window idempotently.
- Ziva continuation jobs participate in the existing in-flight step-chain guard
  so a scheduled sync cannot overlap a still-running history chain.

No source-side absence is treated as deletion. The authenticated response has no
pagination, completeness, or deletion marker, so even a successful empty date is
not sufficient evidence to hide a previously imported meal. Ziva-owned entries
are retained unless a future documented contract adds authoritative deletion
semantics. This is safer than hiding data after an empty, truncated, or
malformed response and is documented as a provider limitation.

## Application wiring and operations

`ziva` is registered in both worker and API-server registries, the provider
queue map, root package exports, shared provider metadata, provider onboarding,
environment examples, deployment environment allowlists, account-erasure
prerequisites, and auth-policy tests. Shared metadata supplies the standard
provider card to both web and mobile; no Ziva-specific client UI or client-side
nutrition computation is added.

The provider is discoverable only when application OAuth credentials are
configured and the authenticated contract has been implemented. Imported rows
flow through existing nutrition queries, summaries, provenance displays, and
Dofek MCP tools.

A TypeScript smoke command will perform OAuth-backed, read-only discovery and
meal retrieval with private values redacted. Dry-run mode does not write to
Dofek. It will never call Ziva's meal-write or delete tools.

## Tests and verification

Tests are written before implementation and include:

- protocol-level fake Streamable HTTP MCP coverage for initialization,
  `tools/list`, calls, JSON result modes, MCP `isError`, 401 refresh, timeout,
  cancellation, rate limiting, close behavior, and malformed data;
- parser coverage using clearly labeled sanitized observed and synthetic
  fixtures, including valid empty results, source value basis, the explicit
  no-conversion unit boundary, absent versus explicit-zero unverified fiber,
  unsupported nutrient preservation, requested-date/unique-ID validation, and
  item versus meal granularity;
- database integration coverage for transactional entry/nutrient replacement,
  idempotency, portion/date edits, removed nutrients, rollback, tenant/account
  isolation, and preservation of local overlays;
- sync coverage for windows, boundaries, continuation/checkpoints, failed dates,
  historical backfills, partial results, and no deletion/checkpoint advancement
  after incomplete reads;
- OAuth coverage for resource indicators, PKCE, token rotation, expiry,
  revoked access, account replacement, and actionable reconnect behavior;
- worker/server registration, queue, provider-auth-policy, metadata/onboarding,
  deployment-environment, account-erasure prerequisite, and existing
  nutrition-read regression coverage.

Relevant unit and integration tests, auth-policy tests, typechecks, lint, and
builds run through the repository's `pnpm` scripts. Live authorization and meal
readback are reported separately from deterministic local tests.

## Non-goals

- Writing, editing, or deleting Ziva meals.
- Calling Ziva through an LLM or general-purpose MCP agent.
- Scraping browser storage or accepting copied/shared user tokens.
- Migrating Dofek's existing MCP server or building a generic MCP framework.
- Replacing source diary values with USDA or AI estimates.
- Guessing pagination, deletion, completeness, nutrients, units, or identifiers
  that the authenticated Ziva contract does not establish.
