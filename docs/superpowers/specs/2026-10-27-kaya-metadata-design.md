# KAYA metadata coverage

The operator approved extending the KAYA import, verifying hold/angle metadata,
and syncing existing climbs, then requested a systematic inventory to avoid
repeatedly discovering omissions. Mountain Project and theCrag coverage are
part of that source audit; changing their import strategies is outside this change.

## Source evidence and approach

KAYA's [Tag fragment](https://set.plastick.rocks/tag-11950.js.map) supplies
`id name color icon tag_type_id`; its [definitions](https://set.plastick.rocks/index-11950.js.map)
identify category 3 as grip. The [outdoor editor](https://set.plastick.rocks/GuidebookView-11950.js.map)
maps Slab, Vertical, Overhang, Roof to -20, 0, 20, 50. These are categories,
not measured degree values. Authenticated reads verified these fields on
2026-10-27; no grip tags were supplied on the connected account's current logs.

Import source metadata through the existing typed client and canonical writer.
Preserve all selected useful source facts in raw provenance; normalize explicit
grip tags and outdoor angle categories for shared analytics. A numeric-only
mapping would misrepresent outdoor categories, and a single hold value cannot
faithfully represent KAYA's tag list. Replacing the canonical scalar hold with
a nullable collection avoids choosing an arbitrary predominant hold. No new
dependency, parallel storage path, or provider-specific server calculation is needed.

## Contract

- `ClimbingWallAngle` additionally accepts `{ category: "slab" | "vertical" | "overhang" | "roof" }`.
  Existing numeric values and unknown units retain their meaning. KAYA maps
  only evidenced outdoor category codes; board or unrecognized values retain
  unknown units until their source convention is independently verified.
- Replace `holdType` with nullable nonempty `holdTypes` throughout storage,
  contracts, server analytics, fixtures, and both clients. Preserve existing
  scalar values in a forward migration. The collection supports crimp, sloper,
  pinch, pocket, jug, volume, jam, and no_grips, matching verified grip tags.
  Other tags stay raw; names from other tag categories do not establish grips.
- Distinct climbs may contribute to each explicitly recorded hold category;
  each category counts the climb once. Overall grade baselines still count
  distinct climbs once. Contradictory source hold sets remain unknown, while
  missing source metadata does not erase a known set.
- Request tags on both climb feeds, ascent grades and videos, and other
  verified useful climb/location metadata. Map ascent grades to reported
  grades. Keep catalogue grades distinct. Descriptions/media metadata remain
  source provenance where there is no current canonical consumer.
- Document the complete observed field inventory with source, validation,
  current handling, intentional exclusions, and limits. Do not claim an
  exhaustive upstream schema because introspection is disabled.

## Verification and operations

Use failing unit and real PostgreSQL regressions before implementation, then
focused provider/server/web/mobile checks and package typechecks. Preserve
identities, activity links, and recorded attempts across refreshes. Review the
whole diff before committing and push commits to the existing branch. Use the
normal release/sync path for production; no runtime hot-patches or inferred
hold facts. Record live source coverage after the eventual sync.

## Approved response versioning follow-up

The operator approved durable versioned API responses after an executable
old-client formatter replay rendered a categorical angle as undefined. The
existing OTA and API release workflows can complete independently, so keep the
three existing tRPC paths and negotiate `responseVersion: 1 | 2`, defaulting to
V1. MCP's three affected tools use `response_version` with the same default.

V1 is a read-only projection: exactly one distinct original grip becomes the
old `holdType`; multiple grips and the newer grip categories become null.
Categorical angles become null, while recorded numeric angles retain their
units. Omit `holdTypes` from V1. V2 serves the canonical collection and angle
union. Storage and repository results remain canonical.

Updated web/mobile clients request V2 and strictly decode either supported
response into their canonical rendering model. An old server's existing
[`z.object` input](https://zod.dev/api#objects) strips the added version field
and returns V1, allowing either deployment order. This decodes response facts;
it does not infer missing traits, compute metrics, retry requests, or swallow
invalid responses. Both version inputs participate in existing cache keys;
server key versions change to exclude pre-negotiation payloads. See tRPC's
[input/output validation](https://trpc.io/docs/server/validators).

Acceptance covers old/no-version callers on the new server, new clients
reading the old response, V2 traits, malformed or mixed contracts, provider
record details, and MCP text/structured output agreement. On 2026-10-27 the
operator also approved only three statement-scoped Squawk exceptions for the
maintenance view replacement, column type conversion and column rename.
