# Primary activity from recording provenance

Status: approved by the user on 2026-10-20; implementation planning in progress.

## Intent and constraints

The primary activity is the record Dofek actually holds that is closest to the
original user-initiated recording. Assume one original user-initiated recording
per existing activity group. Other records may be transferred copies or passive
observations. Independently started duplicate recordings are out of scope.

Origin selection uses provenance only. Provider, device, field, and sensor
priorities do not participate. Import time, sensor count, elevation coverage,
activity-type specificity, and record ID do not establish origin.

Individual activity fields and sensor values retain their existing selection
rules. Activity group identity and grouping behavior remain unchanged. The card
shows the actual provider of the selected available record, never an unavailable
upstream provider inferred from its device or app name.

For a known Garmin → Strava → Apple Health transfer chain:

| Records Dofek holds | Primary record | Logo |
| --- | --- | --- |
| Garmin, Strava, Apple Health | Garmin | Garmin |
| Strava, Apple Health | Strava | Strava |
| Apple Health | Apple Health | Apple Health |

## Current implementation evidence

- The [dbt activity selector](../../../analytics/models/read_models/deduped_activities.sql)
  chooses `best` using sensor contribution, elevation, type specificity, source
  priority, and member ID. That member supplies both `primary_activity_id` and
  several merged fields, including canonical type and modality. Name, notes,
  and local time have additional selection paths.
- The [ClickHouse view builder](../../../src/db/clickhouse-read-models.ts) has a
  separate representative selection path. Its field behavior must also be
  preserved while primary attribution is separated.
- [Strava ingestion](../../../src/providers/strava.ts) retains the detailed
  recording-device name as `source_name`. Its ordinary sync stores the summary
  payload in `raw`, so detailed-response fields cannot all be assumed present.
- The [native HealthKit upload](../../../packages/mobile/modules/health-kit/ios/HealthKitModule.swift)
  supplies `sourceName` and `sourceBundle`. The
  [server schema](../../../packages/server/src/routers/health-kit-sync-schemas.ts)
  accepts both, but the
  [workout writer](../../../packages/server/src/routers/health-kit-sync-processors.ts)
  currently persists only `sourceName` in activity raw provenance.
- [Source explanation code](../../../packages/server/src/models/activity-source-decision.ts)
  currently describes primary selection as source priority. That explanation
  must change alongside primary semantics.

## Resolution model

Interpret raw source metadata using explicit provider-specific rules. Each rule
must identify its supporting raw field and report only the relationship the
field establishes. A source-app identifier may establish that an Apple Health
record was written by Strava. A recognized recording-device name may support
that a Strava recording originated with a corresponding available recorder.
Neither a generic device label nor a heart-rate sensor manufacturer establishes
the app that initiated an activity.

Build relationships only among members of the existing group. Model an edge
from an available upstream record to its downstream copy. Preserve evidence
for each edge. Missing upstream records are not synthesized. Provider families
are presentation metadata, not proof of a transfer relationship.

Select a primary when provenance establishes one available member upstream of
every other candidate. A single available record is primary without claiming
that it is the original. Interpret recorded initiation/detection metadata when
available; do not label an entire provider as passive or direct by brand alone.

If evidence leaves incomparable candidates, or contains a cycle or conflicting
claims, return unresolved attribution with the candidate member IDs. Do not use
field priority, ingestion time, or a deterministic ID tie-break to declare a
primary. Stable IDs may order the returned candidate list for reproducibility.

Initial provenance rules cover explicit Apple Health source apps and recognized
Strava recording-device metadata. Exact app/device mappings must be backed by
provider fixtures and retained raw values. Unsupported labels remain unresolved;
there is no blanket Garmin > Strava > Apple Health ranking. The first release
does not claim to reconstruct every provider's transfer history.

## Storage and computation

Retain source-app bundle identifiers in the existing Apple Health workout raw
payload. Do not create a second source-of-truth table for derived provenance.
Previously ingested source names remain usable; missing historic bundle IDs
remain missing until an ordinary re-sync supplies them.

Compute primary attribution in dbt from current group members and their raw
provenance. Keep expensive group processing outside request paths, following
the [analytics boundary](../../../analytics/README.md). Reconcile changes
incrementally, including source updates, late-arriving upstream members,
membership changes, and source removal.

Separate the former field representative from the provenance-selected primary.
Use accurate names for these distinct concepts. Preserve the old representative
selection solely where needed to retain existing field behavior. Migrate serving
schemas and consumers together so a nullable unresolved primary cannot be
mistaken for a missing group or an instruction to drop fields. Both existing
selection paths must agree on primary attribution.

## API and UI

Expose a resolved primary as its actual member ID and provider ID. Expose
unresolved attribution explicitly, with no invented primary member. Preserve
existing source links for every contributing record.

Use a 20 px provider logo in the card header on web and mobile. Its accessible
label names the actual primary provider. Use existing logo assets and their
established letter fallback. For unresolved attribution, omit the primary logo;
the source details still list the available records. Do not add uncertainty
explanations to every list card.

Replace existing text claiming that the primary was selected by source priority
with evidence-based origin attribution. Explain field-source priorities
separately where the existing details UI needs that information.

## Verification and acceptance

- Execute the three availability cases above with explicit provenance.
- Prove a directly recorded Strava activity is not demoted merely because a
  Garmin member exists without a supported upstream relationship.
- Cover missing source metadata, an unknown source app, contradictory evidence,
  ambiguous same-provider members, and a single available downstream record.
- Verify that newly arriving upstream evidence changes primary attribution
  without changing the group ID; source removal must re-resolve attribution.
- Independently vary provider/field priorities and sensor coverage. These may
  change selected fields under existing rules, but must not change origin.
- Conversely, change provenance alone and assert that all merged activity
  fields, sensor values, location selection, and group identity stay unchanged.
- Exercise both database selection paths with executable integration tests;
  static SQL string assertions do not establish database behavior.
- Update web/mobile card tests and Storybook stories for resolved, unresolved,
  single-source, and missing-logo cases, plus Apple Health provenance ingestion
  tests for preserving `sourceBundle`.

## Scope and release

This change includes provenance preservation, primary resolution, separation
from field selection, serving contracts, source explanations, and card logos
on both clients. New grouping algorithms, manual origin overrides, generalized
provider dependency infrastructure, and changing field priorities are excluded.

Use schema migrations for serving-contract changes. Refresh existing activity
results through the established bounded read-model refresh procedure; do not
start a production backfill or deploy as part of implementing this design.

External API semantics require primary-source verification before adding new
provider mappings. The current environment could not reach the Strava reference
through its configured proxy; code observations above establish what Dofek
stores, not a broader API contract.
