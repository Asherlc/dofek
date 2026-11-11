# theCrag

Dofek's [provider](../src/providers/thecrag/provider.ts) imports the connected
user's climbing logbook through the official
[personal Logbook Read API](https://www.thecrag.com/en/article/logbookreadapi).
It requires an active theCrag supporter subscription and a personal API key.
The API is account-scoped and read-only, includes public and private ascent
notes, and is intended for third-party dashboards without a separate commercial
agreement, according to that reference.

This official personal API remains the only theCrag source used for climbing
data. Automated public-page catalogue enrichment has been removed: the site
policy prohibits screen scraping for programmatic access, the general API guide
requires a legal agreement, and the personal logbook API is scoped to its owner's
ascents rather than general catalogue discovery. See the [usage policy](https://www.thecrag.com/en/terms),
[API integration guide](https://www.thecrag.com/en/article/extend), and
[personal logbook API](https://www.thecrag.com/en/article/logbookreadapi).

## Connect and reconnect

In Data Sources, choose **theCrag**, open the linked instructions, create a key
in theCrag **Settings > API Keys**, and paste it into **Personal API key**.
Both web and mobile conceal the input and explain private-data access before
connection. The [connection flow](../src/providers/thecrag/provider.ts) verifies
page one, derives the remote account ID, and stores the key in the existing
[encrypted per-user credential repository](../src/db/tokens.ts).

Existing username/public-profile connections must reconnect with a key. The
provider checks the saved credential classification before sending a request;
a public username is never used as an API key. Reconnection creates a new
connection identity and starts a full official import, preserving existing
records and user-selected workout attachments. See the
[database tests](../src/providers/thecrag-sync.integration.test.ts).

Keys have upstream expiry and a weekly usage budget; the official guide does
not disclose the budget or an exact key lifetime. Check theCrag's API Keys page
for status and usage. Dofek reports access errors with those checks rather than
assuming a particular cause. See the [official limits and key management](https://www.thecrag.com/en/article/logbookreadapi).

### Account-status API investigation — 2026-11-11

A read-only production probe using the connected account's saved key returned
HTTP 400 from the official logbook endpoint at 15:57:07 UTC, requiring minimum
access level `logbook`. The JSON contained error/request fields only; neither
the body nor response headers supplied supporter status, key expiry or weekly
budget. No raw response or key was retained in this record.

The [general API guide](https://www.thecrag.com/en/article/api) documents
`GET /api/climber/id/{accountID}/subscriptions/thecrag`, and the
[endpoint reference](https://www.thecrag.com/api-wadl.xml) includes subscription
reads. Native requests to that endpoint and the account endpoint returned HTML
403 blocks. A comparison using the existing Impit Chrome transport reached
both APIs at 15:59:04–05 UTC, but both returned JSON HTTP 400 access denials
with the same saved key and no account-status metadata. This comparison did
not change the logbook sync transport.

The public guide links to `/settings/apikey/`; a logged-out read redirects to
sign-in. The guide and endpoint reference inspected here did not document a
personal-key status/budget endpoint. Adding Dofek API or MCP fields alone
cannot recover these missing values: a readable upstream source must first
be verified. An access denial does not establish an expired subscription or
exhausted budget. See the [personal-key guide](https://www.thecrag.com/en/article/logbookreadapi).

## Sync behavior

The [client](../src/providers/thecrag/client.ts) uses native fetch through the
shared provider rate-limit, request deadline and diagnostic boundary. It sends
`GET https://www.thecrag.com/api/logbook/ascents` with
`X-CData-Key: key=<key>` in the header, never the URL, and rejects redirects.
The endpoint, header, `page`/`since` parameters and response pagination fields
are specified in the [personal API reference](https://www.thecrag.com/en/article/logbookreadapi).

The first sync reads all pages. Later bounded syncs use the highest successfully
imported source `epoch`, replaying the boundary second to retain equal-timestamp
edits. Explicit full-history requests bypass that cursor. The
[progress store](../src/providers/thecrag/progress.ts) uses existing per-user
settings, scoped to remote account and connection identity. Empty deltas keep
existing progress; a page, parse or write failure never advances it. If saving
progress fails after records commit, the next run safely replays those records.
No new schema, deployment secret or retry setting is required.

The provider checks account ownership, page numbers, totals, page sizes and
ascent identity uniqueness before writing. Partial and failed responses do not
retire existing entries. Incremental responses are not authoritative snapshots,
and the official API guide does not specify a deletion feed; imports therefore
remain additive. See the [provider](../src/providers/thecrag/provider.ts) and
[canonical writer](../src/db/climbing-log-sync.ts).

## Stored records

The [mapper](../src/providers/thecrag/mapping.ts) retains stable
`thecrag:<ascent-id>` identities, original route IDs, recorded climb dates,
private/public notes, published grades, explicit gear methods and tick results.
Shared ancestor IDs and names form the supplied area hierarchy. Raw source
fields remain in `raw.ascent`, including opaque pitch/tag data whose detailed
schema is not documented by the personal API reference. Unsupported details
are not converted into inferred canonical facts.

Sport/trad protection does not prove a lead. Missing methods, attempt totals,
ascent grade overrides and private facts are not invented; previously supplied
facts remain under the [canonical merge contract](../src/db/climbing-log-sync.ts).
The API's derived CPR performance scores are retained only as opaque source
provenance. No synthetic workouts are created. See the
[mapping tests](../src/providers/thecrag/mapping.test.ts) and
[real database coverage](../src/providers/thecrag-sync.integration.test.ts).

Unexpected database errors pass through the
[sanitized persistence boundary](../src/providers/thecrag/persistence.ts).
JSON/schema failures omit raw bodies, parser error causes, API keys and private
notes from user-facing errors and telemetry. HTTP access errors distinguish
observed status from an unconfirmed cause; an access denial alone does not prove
that supporter status expired.

When the official API explicitly reports the recognized minimum-`logbook`
access denial, the [client](../src/providers/thecrag/client.ts) returns
“theCrag requires logbook access for this key” with the observed HTTP status
and a Settings > API Keys instruction. Other access denials retain the generic
access message. The fixed message flows through the existing sync error used
by the [MCP provider-status response](../packages/server/src/mcp/provider-status.ts);
no new endpoint or account-status fields are required. The
[client tests](../src/providers/thecrag/client.test.ts) cover recognized and
unrecognized denials, response privacy, malformed JSON and cancellation.

## Disconnect and account deletion

Revoke the personal key in theCrag **Settings > API Keys** before disconnecting
Dofek. The official guide documents owner-managed revocation, not a remote
revocation endpoint. Disconnecting removes Dofek's saved key and stops future
syncs while preserving imports; it does not revoke the upstream key or remove
already imported data. The upstream distinction is documented in
[Third-Party Data Retention](https://www.thecrag.com/en/article/logbookreadapi).

The [account-erasure prerequisite](../src/account-erasure/remote-snapshot.ts)
requires personal-key connections to be disconnected before deleting the Dofek
account, with an instruction to revoke the key upstream. Historical public-only
connections still have no remote authorization to revoke. Dofek does not claim
to verify an owner-managed upstream revocation.

## Informational catalogue

Automated public-page catalogue enrichment has been removed. Historical
observations about route tags and the old reader are retained in the
[trait coverage inventory](climbing-trait-coverage.md), but they do not describe
current imported catalogue context. The supported scope and access references
are summarized above.

## Public read path

This section records the retired integration and is not the current sync path.
The previous public-feed/ascent-page integration failed from production while
workstation browser and HTTP probes succeeded. Both ascent URL variants
redirected to the processing host, whose destination returned 403. See the
[October 29 incident](production-incident-baseline.md#2026-10-29--thecrag-ascent-requests-redirected-to-a-forbidden-host)
and [October 30 comparison](production-incident-baseline.md#2026-10-30--thecrag-connection-warning-recurrence).
The official endpoint was reachable from production without a key (HTTP 400
JSON, no redirect); this is reachability evidence, not authenticated sync
recovery. Live recovery requires deployment and a valid key connected in Dofek.

## Transport evidence — 2026-10-26

Fresh logged-out Chrome retrieved a public account's feed, one ascent, its empty
next page and public details. Native Node fetch and curl returned Cloudflare
403 block pages from both the workstation and production; changing only the
User-Agent did not resolve those blocks. The upstream blocking rule was not
identified, so these responses did not establish an authentication requirement.

Impit 0.14.7's default `chrome` profile subsequently retrieved the feed, the
exact next link and ascent details with HTTP 200, no cookies or credentials,
on macOS ARM64 Node 26.7.0 and in a separate container on the production OCI
network using the deployed ARM64 Alpine Node 26.12.1 image. The container ran
as UID 1000 with a 128 MiB memory limit, no application secrets and no browser
process. Production services and deployment configuration were unchanged.
These observations verify that account and network at the time of testing;
they do not establish future availability or historical completeness.
