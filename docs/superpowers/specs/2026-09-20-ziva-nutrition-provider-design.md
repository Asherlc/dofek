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

## Verified external contract and verification gate

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

OAuth metadata is discovery information rather than proof that a full
authorization succeeds. Before production parsing is implemented or the
provider is represented as working, an authorized user must complete the normal
consent flow. Dofek will then make read-only calls to initialize MCP, run
`tools/list`, and call `get_meals_for_date` for a known populated date, an empty
date, and a small range. Sanitized request and result fixtures will become the
test contract. No test meal will be created, modified, or deleted.

If that authorized read cannot establish a stable account identity, stable
record identity, nutrient value basis, or a supported historical read, the
provider will remain unavailable and the exact external blocker will be
documented. Dofek will not invent fields from tool descriptions or synthetic
fixtures.

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
   resolver. An `invalid_grant` removes unusable credentials and produces the
   existing actionable reconnect state rather than an empty sync or retry loop.
6. Reconnect replaces the authorization for that Dofek user. Disconnect removes
   Dofek's stored connection and credentials while retaining previously imported
   source data, matching existing provider behavior.

The shared OAuth configuration gains a standards-based optional `resource`
field, sent during authorization, code exchange, and refresh. Existing
providers are unchanged when it is absent. Because Ziva does not advertise a
revocation endpoint, disconnect will not claim to revoke the server-side grant.

The authenticated contract must provide or permit derivation of a stable
provider account subject. Dofek stores it as the encrypted
`providerAccountId`. Source record keys are namespaced with a non-reversible
digest of that subject so reconnecting one Dofek user to a different Ziva
account cannot overwrite records from the former account. Account identity is
never shared across users or stored in raw external IDs as an email address.

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

Authenticated fixtures determine whether Ziva exposes stable individual food
items or only stable meal-level records.

- When stable item IDs exist, Dofek stores one `itemized` food entry per item and
  does not also import the parent meal's nutrient totals.
- If only stable meal records exist, Dofek stores one honest meal aggregate per
  stable meal ID. It will not fabricate child identities or label a meal total
  as itemized. If the current nutrition-grain enum cannot represent the observed
  response honestly, the implementation will add a narrowly scoped
  `meal_aggregate` value and update canonical source-selection logic in the same
  migration.
- If neither level has stable identity, first-class synchronization is blocked.

Each source record preserves, when the verified result provides it: stable meal
and item IDs, diary date, timestamp and timezone, meal type, food name and
description, quantity and serving unit, gram weight, provider food/portion IDs,
source account namespace, and the sanitized original provider payload.

Nutrient mapping is generated only from observed keys and units. Canonical
nutrient rows retain explicit numeric zero but omit absent or unknown values.
Values are scaled exactly once according to the verified source basis: logged
totals are stored directly, while per-serving or per-100-gram values are scaled
only when the response supplies the quantity needed to do so. Unit conversion
is explicit for energy and mass units; calories are never inferred from macros
when Ziva supplies energy. Supported nutrients map to the existing nutrient
catalog, while unmodeled source fields remain in raw provenance and are listed
as limitations.

Date-only diary values are persisted as calendar dates without conversion
through UTC. Actual timestamps retain their provided offset/zone. Dofek does
not invent a time for a date-only record or infer that a populated day is a
complete diary.

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
  same bounded slicing/pagination path.
- A date/page checkpoint advances only after all results validate and all
  transactions for that unit commit. A timeout, cancellation, tool error,
  malformed item, or incomplete page sequence may leave idempotent partial
  writes but cannot advance completion or trigger absence reconciliation.
- Sync counts report committed logical entries. Failures remain visible through
  the existing sync-status and error pipeline.

No source-side absence is treated as deletion unless the authenticated contract
explicitly establishes that a completed response is authoritative for a precise
account/window or returns deletion records. Public documentation does not
currently establish that condition, so the initial behavior retains absent
Ziva-owned entries. This is safer than hiding data after an empty, truncated, or
malformed response and will be documented as a provider limitation.

## Application wiring and operations

`ziva` is registered in both worker and API-server registries, the provider
queue map, root package exports, shared provider metadata, provider onboarding,
environment examples, and auth-policy tests. Shared metadata supplies the
standard provider card to both web and mobile; no Ziva-specific client UI or
client-side nutrition computation is added.

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
  fixtures, including valid empty results, source value basis, unit conversion,
  absent versus zero fiber, unsupported nutrient preservation, and item versus
  meal granularity;
- database integration coverage for transactional entry/nutrient replacement,
  idempotency, portion/date edits, removed nutrients, rollback, tenant/account
  isolation, and preservation of local overlays;
- sync coverage for windows, boundaries, continuation/checkpoints, failed pages,
  historical backfills, partial results, and no deletion/checkpoint advancement
  after incomplete reads;
- OAuth coverage for resource indicators, PKCE, token rotation, expiry,
  revoked access, account replacement, and actionable reconnect behavior;
- worker/server registration, queue, provider-auth-policy, metadata/onboarding,
  and existing nutrition-read regression coverage.

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
