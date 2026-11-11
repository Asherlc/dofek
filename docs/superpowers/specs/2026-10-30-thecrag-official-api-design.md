# theCrag official logbook API migration

## Intent and approved direction

Replace the failing public-profile logbook sync with the official personal
Logbook Read API. The user selected the official API after production ascent
requests repeatedly redirected to a forbidden processing host. Preserve existing
imports and workout attachments. See the [incident evidence](../../production-incident-baseline.md#2026-10-30--thecrag-connection-warning-recurrence).

## Approaches

The selected direction is one canonical personal-key integration. The
[official personal API](https://www.thecrag.com/en/article/logbookreadapi)
explicitly supports third-party dashboards without a commercial agreement,
requires active supporter status, and provides account-scoped read-only data.
Its key must be supplied by each user. The older general partner API is a
different access program and is not needed for this logbook integration.

Continuing public-page sync leaves the observed production failure unresolved.
Keeping public scraping as a fallback adds a second ingestion contract and
cannot import the same private data as the personal API. Neither is proposed.
The separate informational catalogue adapter remains outside this migration:
the personal API is documented for the key owner's logbook, not general route
search. See the [existing catalogue responsibilities](../../../src/providers/thecrag/README.md).

## Connection and existing users

- Use the existing encrypted per-user token repository and shared manual-token
  form, classified as an access token. Both web and mobile show a concealed
  personal-key input and a link to the official setup instructions.
- Explain active supporter status and that the key grants access to private
  ascent notes as well as public logbook data, as documented by the official
  API. Never put keys, response bodies or notes in diagnostics.
- Validate the key against the logbook endpoint and derive the remote account
  identity from its response. Require a new, explicit credential classification
  so stored public usernames are never sent as API keys.
- Existing public-profile connections receive an actionable reconnect message.
  Keep their records and attachments. Retain identification of old public
  connections where needed for account-erasure semantics; this is historical
  credential classification, not an alternative sync path.
- Reconnection starts a full official import even when the account previously
  imported public records. Scope incremental state to the connected remote
  account, and reset it when a new connection replaces that account.

## Requests, pagination and incremental sync

Use native fetch through the shared provider HTTP/rate-limit/diagnostic boundary.
The official endpoint is `GET /api/logbook/ascents`, authenticated with
`X-CData-Key: key=<key>`. Paginate using its documented `page`, `perPage` and
`numberAscents` response values; reject malformed or incomplete responses before
advancing progress. These fields and the `since` query parameter are specified
in the [personal API reference](https://www.thecrag.com/en/article/logbookreadapi).

The first import reads all pages. Later automatic imports use the highest
successfully imported upstream ascent `epoch` as the `since` cursor, following
the official incremental guidance. Reuse the existing per-user settings pattern
used by [RideWithGPS](../../../src/providers/ride-with-gps.ts) for operational
cursor state; do not add a parallel raw-data store. Only advance the cursor
after every fetched page validates and all records are saved. An empty delta
does not erase entries or invent a newer source epoch. Preserve safe replay at
equal epoch boundaries and fail without cursor advancement on any page/write
error. A full-history request explicitly bypasses the cursor.

Report observed authentication, supporter/budget, transport and malformed-data
failures through existing error/Sentry mechanisms. Do not infer supporter expiry
from a generic access error. Do not add retries, fallback transports or waits.

## Mapping and storage

Use the existing canonical climbing log writer and stable
`thecrag:<ascent-id>` identities so official imports update existing ascents.
Map only supplied raw facts: account/ascent/route identity, climb date, gear
style, tick, grades, notes, reported attempts and available pitch data. Keep
source values in raw provenance. Preserve unknown or absent information rather
than inventing attempts, rope methods or grade systems. Private notes returned
by the authenticated API are imported into the user's own logbook and remain
subject to the same application access controls as existing notes. Do not ingest
the vendor's derived performance scores as canonical health metrics.

Retain additive persistence. Neither an incremental delta nor the documented
API contract establishes a deletion feed, so missing records are not evidence
of upstream deletion. Do not create synthetic workouts. Parsing/validation and
source-field details are implementation decisions constrained by the published
response contract and executable fixtures.

## Disconnect and account deletion

The official guide documents owner-managed key revocation in theCrag Settings
> API Keys and does not document a remote revocation endpoint. Display that
instruction and follow the existing account-erasure prerequisite for providers
with owner-managed credentials: disconnect the key in Dofek before account
deletion, with a specific instruction to revoke it at theCrag. Do not claim
Dofek has remotely revoked a key. Old public-only connections still have no
remote authorization to revoke. Update the obsolete instruction that currently
asks personal-key users to reconnect with a public profile.

## Validation and rollout

Write failing tests before behavior changes. Cover key validation, concealed
web/mobile connection forms, legacy reconnect behavior, paginated full imports,
incremental boundaries, empty deltas, account changes, malformed/error pages,
and cursor preservation on failure. Real Postgres integration tests with MSW
must verify stable upserts, preservation of existing attachments, incremental
state and account-erasure prerequisites. Use current final schema fixtures and
the repository's integration wrapper.

Update current provider/connection documentation and remove obsolete sync-only
public parsers/tests. Keep public transport code still consumed by catalogue
lookups. Run focused tests, relevant type/lint checks and existing integration
checks. Push commits on the current branch. No deploy, secret provisioning or
new deployment environment variable is required to implement this migration.

The production endpoint was reachable using native fetch without credentials
and returned HTTP 400 JSON with no redirect on October 30; this verifies route
reachability only. Successful authenticated production sync requires the owner
to connect a valid supporter key in Dofek after deployment. Never request a key
in chat or claim end-to-end recovery from an unauthenticated probe.

## Scope and review boundary

This is a provider/connection migration across server, web and mobile, with no
new product screens or general integration framework. The builder chooses
module boundaries, exact source mapping and test fixtures within the contracts
above. Before implementation, review this design, especially private-note
import and the reconnection requirement. No production behavior changes have
been made at this design stage.
