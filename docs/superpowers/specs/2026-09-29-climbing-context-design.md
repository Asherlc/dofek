# Climbing context and result metadata

Date: 2026-09-29. Status: approved by the user on 2026-09-30.

## Intended outcome

Preserve and display where a climb was, its board and reported wall angle,
how it was climbed, and its recorded result. Cover Kaya, Mountain Project,
and OpenBeta through the shared climbing model, with equivalent activity and
tick displays on web and mobile.

The approved direction is a full location hierarchy with provider IDs where
supplied, plus optional board and angle metadata. The additional requirement
is complete Mountain Project climbing-method and result coverage, including
lead, top-rope, and falls/hangs. Missing metadata remains unknown.

## Provider evidence

The [Kaya audit](../../kaya.md#observed-location-and-angle-values) verified
destination, area, subarea, board, and a signed integer angle. Kaya's reviewed
[application fragment](https://kaya-app.kayaclimb.com/static/js/main.5bd87165.chunk.js)
does not document the angle's units or reference direction. Preserve its
reported value with an unknown unit.

[Mountain Project](../../mountain-project.md) exports a full location path
as names, a climbing `Style`, and a `Lead Style` result qualifier. It does not
provide area IDs, angle, board, or an explicit total-attempt count in the
checked CSV. Use that export for this feature.

[OpenBeta](../../openbeta.md#location-angle-and-board-coverage) can return
hierarchy names and area UUIDs through `userTicks.climb`. Its
[tick schema](https://github.com/OpenBeta/openbeta-graphql/blob/f1508b2479cc7658ac4341d59ec817836190d6d8/src/graphql/schema/Tick.gql)
also supplies climbing style and attempt type, permits a null catalogue climb,
and has no explicit total-attempt count. The checked climb/area schemas have
no dedicated angle or board fields.

## Storage choice

Use structured metadata on each source-attributed climbing entry. This keeps
the observed location snapshot with its logged climb and supports the
different hierarchy depths supplied by the three providers.

| Approach | Trade-off |
| --- | --- |
| Ordered location nodes on the climbing entry — recommended | Preserves full paths and source IDs within the existing import and display flow. |
| Separate destination, area, and subarea columns | Gives fixed roles, but requires assigning deeper regional levels to those roles. |
| Shared location catalogue with parent relationships | Supports independently managed places, but adds catalogue reconciliation and joins for an entry-display feature. |

Store the following canonical raw or structural facts:

| Field | Shape |
| --- | --- |
| `location_path` | Ordered JSONB array, broadest to nearest location. Each node has a nonempty `name`, nullable `externalId`, and nullable `kind` (`destination`, `area`, `subarea`, or `gym`). Empty array means no supplied path. |
| `board` | Nullable JSONB reference with nonempty `name` and nullable `externalId`. |
| `wall_angle` | Nullable JSONB object with finite numeric `value` and `unit: "degrees"` or `null`. Known degree values retain the existing −90 to 90 constraint. |
| `climb_style` | Nullable normalized climbing method: lead, top-rope, follow, solo, or aid. Boulder discipline remains in `climb_type`. |
| `result_style` | Nullable recorded result label, such as Onsight, Flash, Send, Attempt, or Fell/Hung. Unrecognized supplied labels remain available and have an unknown interpreted send status. |

Source IDs are scoped by the entry's provider. Board names can identify either
a layout/model or a particular physical board. JSONB documents have a fixed
validated shape, following PostgreSQL's
[JSON document guidance](https://www.postgresql.org/docs/current/datatype-json.html#JSON-DESIGN).
Retain upstream response objects in `raw` for provenance.

## Interpretation and serving

Expose a permanent PostgreSQL projection for climbing reads. It derives the
existing location label, lead flag, sent flag, and degree-angle value from
the canonical facts above. A PostgreSQL
[view](https://www.postgresql.org/docs/current/sql-createview.html) computes
these projections when queried rather than storing a second copy. Providers
write the base table; repositories use the projection for activity details,
summaries, progression, and performance comparisons.

Lead maps to `lead = true`, top-rope to `false`, and follow/solo/aid to an
unknown lead flag. A climbing method alone does not imply a send. Onsight,
Flash, Redpoint, Pinkpoint, Repeat, and Send represent known successful
results; Attempt, Not sent, and Fell/Hung represent known unsuccessful
results. Other result labels remain unclassified. French-free is displayed
as recorded and does not establish an unassisted send.

Only mark an imported angle as degrees when its documented unit and orientation
match the existing degree-angle contract. Degree-based analytics consume only
angles whose unit is known to be degrees.
Detailed attempt records continue to determine recorded outcomes/counts when
present. An exported tick or Fell/Hung label does not establish a total number
of tries, falls, or hangs. Mountain Project and OpenBeta imports use unknown
attempt totals when the source supplies no count.

The detail API supplies structured context and server-derived scalar values.
After query-time deduplication, metadata retains the selected source's provider
identity so its location and board IDs cannot be attributed to another source.
The existing activity association and per-source record identities remain the
basis for sync and attachment.

## Provider mapping

- Kaya requests the five verified climb fields for ascents and attempted
  climbs. Copy explicit outdoor nodes in destination/area/subarea order;
  gym records use their supplied gym reference. Existing ascent/session gym
  context may supply a gym when the climb lacks one. Board comes from the
  climb reference. Copy the raw angle with unknown units. Route `lead` maps
  to lead/top-rope; boulders have no rope-style inference. Ascents retain
  their ascent-type labels; the attempted-climb feed records Attempt.
- Mountain Project splits its exported location delimiter into ordered names
  with unknown IDs/roles. Map Lead, TR, Follow, and Solo to climbing methods.
  Route results come from Lead Style; boulder results come from Style.
  Preserve Fell/Hung as one combined result rather than choosing a failure
  reason or manufacturing individual tries.
- OpenBeta requests hierarchy names, ancestor UUIDs, and parent UUID/name in
  the existing tick query. Match supplied names and IDs only when their array
  alignment is valid; inconsistent arrays raise an actionable sync error.
  A missing full path uses the supplied parent reference; a null climb has
  no fabricated location. Copy style and attempt-type metadata independently.

## Migration and existing data

Migrate existing location text, degree angles, lead flags, and sent flags to
their canonical replacements, then remove the old stored columns and update
every writer/reader. Keep stable entry IDs, associations, raw payloads, grades,
and explicit individual attempts. Existing Mountain Project paths can be
split; other legacy location labels remain a single known node until re-sync
supplies more detail. Extract existing result/style labels from retained
provider payloads where available; generic known send flags map to Send or
Not sent. Existing degree values retain their known unit.

Replace previously inferred Mountain Project/OpenBeta total-attempt counts
with null when their source records lack an explicit count. Preserve actual
Kaya counts and individual attempt records. Validate the transactional
conversion against real PostgreSQL fixtures and recheck table size before
release. Provider re-sync populates metadata that was never requested.

Removing columns used by the running application requires a coordinated
cutover. Stage and verify the new release image, quiesce the old web/worker
processes, apply the migration, then start and health-check the matching new
image. This entails a maintenance window and belongs in release approval.
Retain a verified database backup; reverting only the application image after
the schema conversion would not restore the old contract.

## Display and validation

Both clients show the full location hierarchy, board name, climbing method,
and recorded result with the climb. Expand TR to Top rope and Fell/Hung to
Fell or hung. Show known degree angles with °; show unverified values as
`Wall angle: −20 (units unknown)`. Missing result or count stays explicitly
unknown. Keep metadata readable for both attached climbs and unattached tick
suggestions, with equivalent web/mobile stories.

Before implementation, review the canonical storage and interpretation rules.
During implementation, require failing provider regressions first, real
PostgreSQL migration/projection tests, repeat-sync and rejected-replacement
preservation tests, and both clients' rendering tests. Cover deep paths,
nullable IDs, source attribution after deduplication, unknown angle units,
top-rope with unknown result, and Fell/Hung without an invented failure count.
Re-run progression/performance comparisons against known-degree fixtures and
check types, lint, schema diagrams, and provider documentation before release.
