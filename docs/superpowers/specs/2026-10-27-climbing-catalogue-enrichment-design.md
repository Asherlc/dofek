# Informational climbing catalogue cache

Status: implementation authorized; revised to reflect the user's explicit
cache-only clarification. Dofek is a personal training log, not a climb database.

## Intent and boundaries

Show informative catalogue metadata for climbs logged in KAYA, Mountain Project
and theCrag, using cross-references in either direction. Look up catalogue climbs
even when the user has no tick in the other service. Preserve multiple steepness
categories and distinguish direct route tags from inherited Area context.

All fetched enrichment and inferred matches are disposable, expiring cache
entries. Do not add catalogue tables, durable identity links, canonical climb
merges, synthetic ticks, or writes of enrichment into existing records. Clearing
the cache loses only informative context. Recorded ticks, imported source facts,
attempts, outcomes, grades and Activity attachments remain authoritative.
Informative catalogue facts do not change training metrics or deduplication.

## Existing contracts

The [source schema](../../../src/db/schema/climbing.ts) and
[writer](../../../src/db/climbing-log-sync.ts) own imported records. The
[analytics projection](../../../packages/server/src/repositories/climbing-canonical-observations.ts)
consolidates some tick occurrences, not cross-catalogue identities. Neither is
modified to persist enrichment. The
[existing cache](../../../src/lib/cache.ts) already supports expiring values and
per-user invalidation. Reuse that infrastructure without a new service.

The [source inventory](../../climbing-trait-coverage.md) records verified
theCrag route-page tags and KAYA's angle/tag interpretation. theCrag's
[taxonomy](https://www.thecrag.com/en/article/tagging) distinguishes steepness
from other styles. Multiple tags and inherited tags must retain their scope;
an Area tag does not establish a measured route angle.

## Approach

Use small provider-local catalogue adapters plus a shared server-side matching
and caching service. Reject durable catalogue storage (contrary to the user's
clarification) and scraping during existing log queries (would make ordinary
pages depend on external catalogue response times).

Expose enrichment through a separate, owned-log query and explicit refresh
action. Initial queries read only the cache; refresh runs bounded lookups
through existing worker infrastructure. Both web and mobile show the result
in climb details, with concise source links and a refresh disclosure. Existing
record APIs keep their contracts; a separate shared enrichment schema avoids
changing the recorded wall-angle shape or requiring a new log response version.
MCP exposes the same informational context separately from recorded facts.

## Cached data and matching

Cache entries are user-scoped and keyed by source identity plus a fingerprint
of matching-relevant input (provider/external ID, name, kind, location and set
context). Store source IDs/URLs, fetch/expiry times, matching evidence, and parsed
traits. Use a seven-day TTL for successful observations/matches and a one-day
TTL for verified no-match/ambiguous results; failures are errors, not negative
matches. These TTLs are implementation choices, not upstream guarantees.

Discover candidates using verified upstream search contracts. Prefer explicit
cross-references; otherwise require one unique candidate with matching normalized
name/kind and independently corroborated location. Uniqueness must hold across
complete paginated results, not just the first page. Matching Area names alone
cannot establish identity; native coordinates retain their route/Area scope.
Indoor matching additionally requires the same gym and set/board problem, so
recycled names/colors cannot match automatically. Uncertain matches stay
suggestions, visibly distinct from verified references.

Return attributed source observations, not a selected canonical winner. Keep
original tag/key, supported normalized category, source URL, and direct versus
inherited scope, including ancestor identity/name only when supplied. Numeric
angle values keep their units separately. Keep unsupported tags raw rather than
inventing category mappings. Multiple categories can describe one varied climb;
differing sources remain independently inspectable. No free-text or LLM
classification. Published grades and native location can appear as reference
information without replacing log facts.

## Retrieval, errors and lifecycle

Verify KAYA, Mountain Project and theCrag search/detail contracts with live
read-only requests and record exact asset URLs, access conditions, pagination
and source fixtures before implementing an adapter. A
[KAYA user guide](https://kayaclimb.com/support-articles/logging-your-climbs-on-kaya)
or [Mountain Project search page](https://www.mountainproject.com/search) is
evidence of a discovery surface, not proof of a callable API. Reuse existing
provider HTTP/rate-limit/credentials code; providers do not import each other.

Refresh only requested, owned climbs and deduplicate source detail fetches per
job. No whole-catalogue crawling, historical database backfill, schema migration
or new secret. Complete successful refreshes replace cached responses so removed
tags disappear. Failed refreshes report actionable errors and unexpected errors
to Sentry; unexpired cached information may remain visible with its fetch time
and refresh error. Expired information is unavailable. User-prefix invalidation
and account erasure cover these entries. Re-read source records before serving
cached data, so deletion or changed matching input cannot expose an obsolete
entry. All enrichment can be rebuilt without loss of recorded history.

## Verification and delivery

Use TDD for parsers, pagination, matching, cache expiry/invalidation, refresh and
API ownership. Cover multiple/inherited tags, same-name routes in different
areas, incomplete candidate sets, indoor resets, uncertain matches, failed
refreshes and successful removal of tags. Integration tests use real Postgres
for owned-log access and network-level mocks for catalogue requests. Verify
web/mobile disclosures, attribution, loading/error states and MCP output against
the same response schema. No catalogue writes or analytics changes are part of
this feature.

If a provider's discovery surface cannot be verified, report exact evidence and
ask for direction before substituting a different discovery strategy. A partial
adapter is not completion of the three-provider feature.
