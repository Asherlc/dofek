# Climbing parent-area enrichment

The user approved extending catalogue enrichment with higher-level metadata
after comparing all five providers. Preserve it as attributed parent context,
separate from route facts and from recorded climbing history.

## Design

Extend an area-scoped catalogue location with optional `context`:

- `url`: provider-owned area source link.
- `type`: literal source area type when available, otherwise null.
- `sections`: `{ sourceKey, label, text, inheritedFrom }` descriptions, approach, access and
  supported closure/sensitivity notes, converted from source HTML to plain text.
- `tags`: existing attributed tag shape plus nullable `count`. These tags belong
  to this area; explicit upstream inherited provenance remains explicit.
- `statistics`: `{ sourceKey, label, value }` clearly identified upstream counts
  and ratings. Preserve values; do not calculate route attributes from them.

Location identity, ancestry order and area coordinates remain in the existing
location fields. Context is not allowed on route-point locations. All context
links must match the candidate provider's origin. Native route facts, grades,
angles, matching thresholds and logged records retain their existing meaning.

Fetch supported parent records using source-proven identifiers. Deduplicate
parent requests within each search call; do not retain rejected promises or
user-authenticated data across searches. Preserve source-defined scope and
qualifiers. Unknown fields stay absent/null; public and authenticated field
surfaces stay distinct. An upstream failure remains an actionable lookup error.

Both clients display area context behind an accessible disclosure within the
existing catalogue information panel. Show the area source link, literal tags,
plain descriptions/access sections and source statistics. Source counts are not
labelled as votes or route counts unless the upstream field establishes that.

## Approved training presentation (2026-11-02)

The user approved the “Beside the chart” mock: keep the existing training
analysis, place contributing climbs beside it on wide screens and below on
mobile, and expose an “Include area metadata” control (enabled initially).
Do not show a classification summary line or introduce separate provider/area
analysis tabs. Expanded examples show a compact source tree with the trait
on its owning route or area and an indented inheritance arrow to the climb.

Training consumes cached catalogue observations, with missing lookups queued
through the existing worker. Recorded route traits take precedence over
catalogue route traits; area tags supplement only missing dimensions. Disabling
area metadata changes server calculations, including progress and examples.
Only identity-backed catalogue routes and independently corroborated areas can
contribute; possible route suggestions never become route facts. Literal tagged
traits are mapped explicitly; descriptions, access text and geography remain
available context without inventing numeric slopes or hold observations.
No calculated matches or metrics are persisted in Postgres.

The reference mock is hosted at
[Climbing training mock](https://dofek-climbing-training-mock.asherlc779587.chatgpt.site).

## Approach

The approved approach adds a common parent-context contract, provider-specific
readers and paired rendering. Copying area traits onto each route would erase
scope. Keeping everything as untyped raw JSON would make provenance, validation
and rendering inconsistent. Neither alternative is used.

## Sources

- Vertical-Life [crag](https://vlcapi.vertical-life.info/outdoor/v1/web/crags/sportclimbing/united-states/auburn-quarry)
  and [area](https://vlcapi.vertical-life.info/collection/v1/web/areas/united-states/yosemite-ca).
- Mountain Project [area JSON](https://www.mountainproject.com/api/v2/areas/105733893).
- KAYA [consumer client](https://kaya-app.kayaclimb.com/static/js/main.9113009d.chunk.js)
  and [location client](https://set.plastick.rocks/location-11950.js.map).
- theCrag [tag inheritance](https://www.thecrag.com/article/Tagging/Closed)
  and [area documentation](https://www.thecrag.com/en/article/documentingacrag).
- OpenBeta [Area schema](https://github.com/OpenBeta/openbeta-graphql/blob/develop/src/graphql/schema/Area.gql).
- Disclosure accessibility follows the [WAI disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/).
