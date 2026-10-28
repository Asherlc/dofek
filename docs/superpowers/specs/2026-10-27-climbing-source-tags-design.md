# All source-supplied climbing tags

Status: approved on 2026-10-28. Recorded tags feed strengths; catalogue tags
remain reference information.

## Intent

Expose the tags our climbing sources actually provide, beyond the existing
wall-angle and grip breakdowns, in climb details and climbing strengths on both
web and mobile. Preserve source terminology instead of inventing unsupported
style classifications.

## Approach

Project typed, attributed tags on the server from retained provider payloads.
KAYA already requests full tag objects in both logbook feeds; its other tag
categories remain raw today. The existing strengths query and detail readers
already load those payloads. See the [client selection](../../../packages/kaya-client/src/client.ts),
[strengths repository](../../../packages/server/src/repositories/climbing-strengths-repository.ts)
and [source audit](../../climbing-trait-coverage.md#hold-and-angle-interpretation).

A second stored tag collection would duplicate retained source information and
require migration/backfill work without supplying additional facts. A
server-side projection is the proposed approach; provider-specific decoding
stays at the source boundary and analytics consumes generic tags.

## Proposed behavior

- Retain every supplied tag's source identity, literal label and category;
  preserve unfamiliar categories and custom labels.
- Show grouped tags in climb details, with each fact stated once.
- Extend the existing strengths breakdown to observed tag categories, reusing
  the current grade-adjusted calculations, limited-sample states, Styles view,
  Progress view and source-climb drilldown. Empty tags remain unknown.
- Keep sources and categories distinct when identical labels do not establish
  equivalent meanings. Repeated logs do not multiply a climb's tag membership.
- Preserve tags from all contributing records during existing log consolidation.
- Fetch KAYA native catalogue tags where the existing authenticated detail
  contract supports them. Public WebClimb search rejects that field; the
  [source audit](../../climbing-trait-coverage.md#informational-catalogue-cache)
  records that type distinction.
- Keep direct route tags distinct from inherited Area tags in catalogue details,
  following [theCrag's tag inheritance](https://www.thecrag.com/en/article/tagging).
- Apply the same shared server contract to web, mobile and MCP, respecting the
  existing [response-version policy](../../climbing-context.md#response-versions-and-independent-releases).

## Scope decision

The recommended scope uses recorded source tags in strengths and preserves
catalogue enrichment as attributed reference information. This follows the
existing [catalogue boundary](2026-10-27-climbing-catalogue-enrichment-design.md#intent-and-boundaries).

Alternatively, verified direct catalogue tags could also affect strengths.
That would change the existing reference-only boundary and needs an explicit
decision about source agreement, cache expiry and inherited tags before work.

No new provider, external service, dependency, inferred text/video labels or
database migration is proposed.

## Verification

Use failing tests first for tag decoding and attribution, consolidation,
category breakdowns and unknown/conflicting data. Add paired web/mobile tests
and stories for category selection and grouped details. Verify the changed
response contracts, relevant provider/catalogue tests, lint and typechecks.
