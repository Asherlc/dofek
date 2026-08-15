# Kaya credential sync provider design

## Goal

Add a credential-based `kaya` provider that imports a connected user's climbing
sessions and individual ascents from Kaya's authenticated application API. Keep
the existing `kaya-export` CSV import provider unchanged.

Kaya does not publish a developer API. This integration documents and consumes
the API used by Kaya's own application, with the application as the primary
source for the observed contract: [Kaya web app](https://kaya-app.kayaclimb.com/).

## Scope

- Provide the standard web and mobile credential-connect experience using the
  shared provider metadata and automated-login contract.
- Authenticate with each user's Kaya email and password, storing only the
  resulting per-user credentials in the existing encrypted token store.
- Read the authenticated user's identity, climbing sessions, and ascents.
- Store each Kaya session as one canonical `rock_climbing` activity and each
  ascent as one canonical climbing entry, keyed by Kaya's stable IDs.
- Preserve vendor-native values in raw JSON, including unmodeled fields.
- Document the observed login and GraphQL operations in an OpenAPI 3.1 contract
  alongside the existing WHOOP contract.

The initial mapping includes boulder versus route, grade, send status,
attempt count, names, locations, session timing, and Kaya's route-level
`lead` boolean. `ascent_type` represents send style (for example, flash or
redpoint), not lead versus top-rope. For routes, `lead: true` means lead and
`lead: false` means top-rope. Boulders retain `null` because Kaya also returns
`false` for them and they have no rope style.

## Architecture

`packages/kaya-client` is the sole boundary for Kaya's reverse-engineered API.
It owns request headers, credential login, GraphQL request execution, Zod
schemas, and response-to-client-domain conversion. It exposes typed operations
for authentication, current-user lookup, session listing, and ascent listing.

`src/providers/kaya-sync.ts` owns Dofek-specific work only: loading a user's
stored token, constructing the client, mapping Kaya data to the canonical
activity tables, and reporting sync progress/errors. It does not embed GraphQL
documents or vendor response schemas.

The new provider has ID `kaya`; `kaya-export` continues to identify CSV data.
The two sources intentionally remain separate because the export has no stable
Kaya session/ascent IDs and should not be conflated with API-origin records.

## Data flow

1. A user connects Kaya using email and password in the shared credential UI.
2. Automated login exchanges those credentials for the API bearer token and
   records the authenticated Kaya user identity with the token metadata.
3. Sync loads the encrypted token for `kaya`, discovers/uses the stored Kaya
   identity, then pages through the requested session and ascent window.
4. Each session is upserted with the Kaya session ID. Its ascents are replaced
   transactionally from the authoritative API response, using Kaya ascent IDs.
   The canonical climbing entry stores the nullable route-level `lead` value.
5. When the full activity list for a sync window completes, normal provider
   activity reconciliation applies absence tombstones. No reconciliation occurs
   after a partial or failed fetch.

The first connected sync requests available history; later syncs use the
provider's normal lookback window and `since` boundary. This is an incremental
sync policy, not a first-sync-only data model.

## API contract documentation

`docs/kaya-api.openapi.yaml` will be an OpenAPI 3.1 document for the observed
REST authentication and GraphQL operations. It will identify the contract as
reverse-engineered, include authentication requirements, request variables,
response schemas, and operation IDs, and distinguish confirmed fields from
unverified candidates. GraphQL is modeled through its single endpoint with
named operation payloads, rather than inventing REST resources.

## Error handling

Missing credentials return the existing actionable reconnect error. Login and
HTTP/GraphQL failures include Kaya's actionable response where safe to expose,
are reported to Sentry through the existing sync error path, and do not
reconcile activity absence. Malformed individual records become sync errors
keyed by external ID while other records continue.

## Tests and verification

- Client tests cover credential login, auth headers, GraphQL variables,
  pagination, and Zod rejection of malformed responses.
- Provider unit tests cover token handling and the mapping of a complete
  session with boulder and route ascents, including send status, attempts, and
  `lead` / top-rope differentiation.
- A database integration test verifies stable-ID upserts, authoritative ascent
  replacement, and activity reconciliation semantics against Postgres.
- Contract tests confirm the provider has the `kaya` identity and a per-user
  credential auth path; registration tests cover worker and server registries.
- Metadata tests cover the shared web/mobile provider card.

## Non-goals

- Removing, merging, or changing `kaya-export`.
- Inferring top-rope or lead from grade or send status; the provider uses only
  Kaya's explicit `lead` boolean.
- Writing provider-estimated calorie expenditure.
- Adding a custom provider-connect UI or application-level environment secrets.
