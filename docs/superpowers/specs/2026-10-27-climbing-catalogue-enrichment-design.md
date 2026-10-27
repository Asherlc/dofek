# Climbing catalogue enrichment and attributed steepness

Status: proposed design; implementation approval pending.

## Intent and approved scope

Import theCrag steepness, including multiple categories and inherited Area
tags. Cross-reference Mountain Project, theCrag and KAYA climbs in both
directions, including catalogue lookups when the user has no tick in the other
service. Catalogue facts enrich the presentation and analysis of existing logs;
they must not become synthetic ticks or overwrite a provider's recorded facts.

These scope choices were approved in the task conversation. The storage,
matching, resolution and delivery rules below are proposals for approval.

## Existing behavior and evidence

- Climbs and Areas have user- and provider-scoped identities. Logs reference
  their source Climb and retain their original payload. Names alone do not
  establish identity. See the [schema](../../../src/db/schema/climbing.ts),
  [writer](../../../src/db/climbing-log-sync.ts) and
  [model guide](../../climbing-context.md).
- Analytics group some matching observations within an Activity, using a key
  that includes date, grade, location path, wall angle and outcome. That is
  occurrence consolidation, not a reusable cross-catalogue climb identity.
  See the [projection](../../../packages/server/src/repositories/climbing-canonical-observations.ts).
- Wall angle currently represents one numeric observation or one category;
  holds are already plural. See the
  [shared contract](../../../packages/training/src/climbing-experience.ts).
- The 2026-10-27 source audit observed multiple and inherited steepness tags on
  theCrag route pages, while the importer fetches ascent pages only. Steepness
  keys and climbing-style keys must remain distinct. See the
  [source inventory](../../climbing-trait-coverage.md#other-climbing-providers),
  [tag taxonomy](https://www.thecrag.com/en/article/tagging) and
  [existing parser](../../../src/providers/thecrag/public-parsing.ts).
- Known-ID route reads and personal logbook reads are implemented; catalogue
  discovery still needs authenticated/live contract verification. KAYA's
  [user guide](https://kayaclimb.com/support-articles/logging-your-climbs-on-kaya)
  describes location-scoped climb discovery, but does not document a search
  API. Mountain Project's [search page](https://www.mountainproject.com/search)
  likewise does not establish a callable search contract. See the existing
  [KAYA client](../../../packages/kaya-client/src/client.ts) and
  [Mountain Project client](../../../packages/mountain-project-client/src/client.ts).

## Approaches

1. **Retain source catalogue observations and resolve linked metadata on read
   (recommended).** Each fact has one source-owned storage location. Verified
   identity links let enrichment work in either direction without changing
   tick ownership. This requires a catalogue observation model and a shared
   server resolver, but directly satisfies the requested source separation.
2. **Copy another provider's facts onto each tick.** Simpler initial reads, but
   duplicates facts, obscures provenance and makes updates disagree. Excluded
   by the requested storage behavior and the repository's
   [canonical-storage policy](../../schema.md).
3. **Only join existing ticks at request time.** Avoids catalogue observation
   storage, but cannot enrich from a service where the user has no tick. This
   is narrower than the approved lookup scope.

## Data ownership and identity

Introduce a provider-agnostic, user-owned catalogue layer for source objects
and their trait observations, plus evidence-backed identity links. A catalogue
object is identified by provider and external ID, independently of whether it
has a log. Existing source Climbs reference that object. A lookup creates only
the catalogue object and its observations, never a ClimbingLogEntry or Attempt.

Store catalogue facts once per source object, not as enrichment copies on
every linked climb or tick. Preserve source URL, external IDs, fetch time and
the evidence needed to interpret each fact. Existing tick payloads remain
historical source evidence; catalogue refreshes do not rewrite them. During
implementation, determine which existing Climb/Area-owned catalogue fields
move into this layer and migrate every reader/writer of those fields rather
than retaining duplicate current catalogue storage. Log-owned experience facts
remain log-owned. No materialized resolved winner is stored.

The initial enrichment allowlist is steepness, explicit grip types, published
grades, setting, and native route/Area location. Personal grades, tick dates,
methods, attempts, outcomes, notes and ascent media are not transferable
catalogue facts. Source descriptions may support inspection but are not parsed
into invented grip or steepness classifications.

Auto-link only independently verified source references, or one unique
candidate with the same normalized climb name and kind plus established
location identity. Uniqueness requires a complete paginated candidate set in
the relevant location; truncated or failed searches cannot prove a match.
Establish location identity through verified cross-references, or a uniquely
corroborated hierarchy and native coordinates; matching Area names or paths
alone do not establish it. For indoor climbs, identity must additionally establish the
same gym and set/board problem; repeated names or colors do not suffice.
Grades can support a match but cannot establish it or require exact equality.
Area coordinates are not route coordinates. Ambiguous candidates remain
unlinked and are counted in enrichment status. Retain the evidence for every
accepted link, revalidate it when identity-bearing fields change, and reject
transitive matches that introduce contradictions. No fuzzy-name-only or
LLM-guessed automatic matches, and no new manual matching UI in this scope.

## Traits and server resolution

Expand the shared model to retain a collection of attributed steepness
observations independently of numeric wall-angle measurements. Each observation
retains the original source tag/key, a recognized category when available,
source object and URL, and direct versus inherited scope. Inherited observations
identify the supplying Area when upstream evidence provides it; never infer a
missing ancestor ID from a display name. Unknown tags remain source evidence.
Categories do not imply measured degrees. Tufa or climbing-style tags are not
forced into the existing slab/vertical/overhang/roof enum.

Store an inherited fact on its supplying source Area and reference it from the
route, rather than copying it onto each descendant. If upstream supplies an
inherited tag without an identifiable Area, retain that provenance as a
route-response observation with unknown ancestor identity. Migrate existing
categorical wall-angle facts into the attributed trait storage and remove the
old categorical storage after all writers/readers move; numeric angle facts
retain their original values and units. Existing API versions remain projections,
not duplicate storage paths.

The server resolves metadata for the selected source climb from its own facts
and verified linked catalogue observations. Explicit log-owned observations
take precedence for that log. Direct climb catalogue traits are distinguished
from inherited Area context; inherited traits never become asserted direct
route measurements. Multiple explicit categories from one source can describe
a varied climb and are not automatically a conflict. Disagreements between
sources stay attributed and visible instead of selecting a provider arbitrarily.

Strength analysis uses resolved direct climb traits and counts a climb once
within each applicable category. Totals are not computed by summing overlapping
categories. Inherited Area traits are available as context in details, with an
explicit inherited label, and do not enter route-specific strengths buckets.
All metric computation stays on the server. Enrichment must not change tick
identity, occurrence counts or Activity attachments; remove catalogue traits
from any occurrence grouping dependency where necessary to preserve that rule.

## Fetching and lifecycle

Use provider-local adapters behind a small shared catalogue lookup contract;
providers do not import one another. Reuse existing HTTP, rate limiting,
per-user credentials and worker infrastructure. Search only for climbs rooted
in the user's existing logs, scoped to evidenced locations, and fetch each
source catalogue object once per enrichment run. Do not crawl whole catalogues
or make upstream requests while serving an activity/detail page.

Verify search/detail contracts separately for KAYA, Mountain Project and
theCrag, recording request shapes, access requirements, pagination and real
response fixtures. Public documentation or a search page is a lead, not proof
that an API works. If an adapter cannot discover candidates, report that
explicit limitation and request direction rather than claiming three-provider
completion or silently substituting another strategy.

Refresh through normal sync/post-sync processing. Existing history is enriched
through a bounded, resumable TypeScript operator command, not a deploy migration
or an unbounded job. Successful empty metadata, no match, ambiguity, unavailable
access and fetch failure remain distinct. An unsuccessful refresh retains prior
observations with visible freshness/error state, reports unexpected errors to
Sentry, and never reports successful enrichment. Ownership checks, account
erasure and disconnect behavior must include catalogue records and links.
Successful authoritative catalogue refreshes replace that source object's
current observations, including removing tags that disappeared; partial or
failed fetches cannot remove them. Invalidated identity links stop contributing
to resolved results immediately, even when the old source observation is retained.

## API, web and mobile

Publish the expanded attributed-trait response as a new explicit response
version, preserving existing versions' declared meaning. Old responses project
only faithfully representable facts; they never choose an arbitrary category
or turn an inherited tag into a direct observation. This is a durable versioned
API contract, following the existing
[response-version policy](../../climbing-context.md#response-versions-and-independent-releases).

Update web and mobile together. Cards stay concise; details expose source
links, inherited context and conflicts through existing disclosure patterns.
Strengths, provider details, activity details and MCP readers use the same
server resolution rules. Cache keys and strict decoders distinguish versions.
Source record views still expose original provider facts alongside enrichment.

## Verification and delivery checkpoints

1. Verify live catalogue discovery/detail contracts and fixture provenance
   before implementing adapters. Report provider limitations explicitly.
2. Write failing parser/matcher/resolver tests, then implement. Cover duplicate
   names, different areas, indoor resets, grade disagreements, multiple and
   inherited tags, and changes that invalidate a prior match.
3. Run executable PostgreSQL integration tests for source ownership, singular
   catalogue storage, linked resolution, conflicts, refresh, erasure and
   unchanged occurrence counts. No SQL-string-only substitute.
4. Verify old/new API combinations, MCP output, web/mobile details and strengths
   interactions, including missing, conflicting, stale and inherited states.
5. Run the repository's required checks, then demonstrate a read-only report of
   matched/unmatched/ambiguous catalogue candidates and resulting traits for
   existing climbs. Historical writes and production deployment are separate
   operator actions from design approval.

No new dependency, service, secret or matching framework is proposed. Exact
table names, migration ordering and adapter request contracts remain builder
details to establish from the verified source shapes. If they require a
different storage or matching strategy, return for approval before changing it.
