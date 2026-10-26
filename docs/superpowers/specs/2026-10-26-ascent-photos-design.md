# Ascent photo imports

Status: proposed; approach approved, design awaiting approval.

## Intent and scope

Import photographs explicitly attached to the connected user's logged ascents.
Preserve the source association and original bytes, support standalone climbing
logs, collect new photos during sync, and provide a bounded historical import.
Expose the same photos and acquisition state on web and mobile.

The user selected ascent photos and approved extending the existing private
photo pipeline. Route catalogue galleries, other users' photos, video downloads,
generated video thumbnails, manual photo uploads, and guessed associations based
on climb names or dates are outside this change.

## Approaches

The selected approach extends the current image associations, acquisition work,
R2 storage, coverage, and galleries to support climbing log owners. This avoids
a second media service and preserves existing activity photo behavior.

A separate climbing photo pipeline would isolate the new source type but
duplicate storage, download security, retry, retention, and erasure logic.
Associating every ascent photo with an Activity would be smaller initially but
cannot represent standalone logs and would lose the ascent relationship. These
alternatives do not fit the approved requirements.

## Provider evidence and limits

Investigated on 2026-10-26 using repository adapters, upstream source, and the
current public application bundle. No authenticated account response was tested.

| Source | Evidence | Proposed behavior |
| --- | --- | --- |
| KAYA | The current [web application bundle](https://kaya-app.kayaclimb.com/static/js/main.9113009d.chunk.js) contains `WebAscentFields` with `photo { photo_url thumb_url }` and a distinct video object. The earlier authenticated field audit in [kaya.md](../../kaya.md#confirmed-request-coverage) established the same fields. | Request the ascent's photo object, preserve it in raw, and acquire `photo_url`. `thumb_url` is a lower resolution alternative, not a second photograph. Validate the selection against the authenticated logbook query before claiming live coverage. |
| OpenBeta | Published [Tick schema](https://github.com/OpenBeta/openbeta-graphql/blob/develop/src/graphql/schema/Tick.gql) has no media association. The [Media schema](https://github.com/OpenBeta/openbeta-graphql/blob/develop/src/graphql/schema/Media.gql) exposes user media and climb/area tags, not ticks. | Record retrieval as unverified for ascent photos. Do not assign user/climb gallery photos to particular ticks. |
| Mountain Project | The existing [client](../../../packages/mountain-project-client/src/client.ts) reads tick CSV and route/area metadata. It has no verified per-tick photo contract. | Record retrieval as unverified pending evidence of explicit ascent association; do not substitute route photos or profile albums. |
| theCrag | Existing [adapter](../../../src/providers/thecrag/provider.ts) reads the [personal logbook API](https://www.thecrag.com/en/article/logbookreadapi). The documentation fetch returned HTTP 403 during this audit; a photo contract has not been verified. | Record retrieval as unverified unless a documented or observed ascent media contract can be verified during implementation. |
| KAYA CSV | The existing [CSV importer](../../../src/providers/kaya/import.ts) has no verified photo field. | Record unavailable retrieval with a clear source-specific reason; do not infer media from text. |

“Unverified” describes Dofek's retrieval knowledge, not proof that the provider
product lacks photos. Every climbing source participates in the coverage model;
only verified ascent photo fields produce candidates. Existing workout media
from Strava and other activity providers continues through the activity path.
Do not infer an individual ascent association from a climbing workout photo.

## Data model and migration

Extend the existing image and discovery tables with nullable
`climbing_log_entry_id`; make `activity_id` nullable and constrain each row to
exactly one owner. Add owner-scoped foreign keys and per-owner provider/source
uniqueness, including a matching unique key on climbing logs. Retain existing
activity rows, UUIDs, object keys, and work records unchanged.

This is one canonical image association table, one object table, and one
acquisition ledger. Existing activity-oriented table names can remain to keep
the migration focused; runtime owner types become an explicit discriminated
union of Activity and ClimbingLogEntry. No polymorphic UUID without foreign-key
integrity and no duplicate climbing object store.

Provider identity must match the source log at write and acquisition time. All
reads and mutations remain account scoped. Source identity for KAYA's singular
photo slot is based on ascent ID; preserve URL alternatives and detect changed
photo content references without treating expiring query signatures as edits.
Do not invent stable media IDs or upstream revision guarantees.

## Discovery, acquisition, and historical import

KAYA requests the photo field in its existing ascent feed. Persist photo
discovery after the corresponding climbing records exist, including standalone
ascents. Treat omitted or malformed fields as unknown/failed coverage, not as
proof of an empty gallery. A valid explicit null establishes no photo for that
ascent. Partial discovery must preserve previous associations.

Extend the existing provider media contract with ascent discovery only where
needed. Adapters stay provider owned. Acquisition dispatch, claiming, refreshed
URLs, completion, and reconciliation resolve the typed owner and apply its
visibility and provider-connection checks. Reuse existing SSRF-safe downloads,
original-byte storage, account-scoped hashing, durable retries, and erasure work
barriers. Unexpected failures must reach Sentry and actionable coverage state.

Historical acquisition uses the same queue and a resumable climbing-log scan,
with a captured creation-time upper bound and `(created_at, id)` cursor. Do not
reuse nullable climb dates as a scan cursor. Refresh source data when old raw
payloads lack the newly requested field; a historical import cannot interpret
missing fields as an empty gallery. KAYA's paginated ascent feed should be
fetched once per discovery pass rather than once per ascent. The builder may
choose the precise bounded batching interface after reading the current sync
and backfill code; it must avoid quadratic provider requests, preserve stable
checkpoints on failure, and respect existing provider/user locks.

No new bucket, credentials, environment variables, or dependencies are planned.
The private storage configuration already described in
[activity-images.md](../../activity-images.md) remains canonical.

## API and clients

Add an account-authorized `climbing.images` query accepting a log entry ID and
returning the shared gallery shape, coverage, and acquisition state. Reuse the
existing signed URL renewal and cache policies. Return only private stored
objects, never raw provider URLs or credentials to clients.

Web and mobile climbing log detail/disclosure views render the shared photo
experience, with caption, provider attribution, full image viewing, loading,
pending acquisition, empty, and actionable error states. Keep list summaries
concise. Attached activity galleries include ascent photos through current log
attachments without copying or moving image associations; attachment changes
are reflected by queries. Preserve every source association when gallery
deduplication combines representations.

## Retention and visibility

Soft provider absence hides the log and its photos, pauses acquisition, and
preserves bytes. Reappearance restores visibility. Disconnect stops acquisition
but retains stored copies. Removing an activity attachment keeps the log's own
photos. Existing explicit activity deletion semantics retire activity-owned
images; log-owned photos follow the retained log's visibility and survive if
the log remains. Hard deletion of a log cascades its associations and work.
Account erasure must remove both owner kinds, discovery, work, and unreferenced
objects under the existing erasure barrier. Cleanup must count associations of
both owner kinds before deleting an object.

## Verification and completion

Write failing behavior tests first. Use real Postgres integration tests for
owner constraints, source isolation, acquisition state, disappearance and
restoration, attachment changes, and object retention/cleanup. Preserve activity
photo regressions. Client tests cover photo display, viewer interactions, and
error handling on both platforms; visually inspect representative populated,
pending, empty, and error states. Verify provider media parsing and pagination
with sanitized observed fixtures; fixture tests alone do not establish live
account validation. Run applicable lint/typecheck, unit/mobile, integration,
and migration checks, regenerate schema diagrams, and document exact coverage
and live-validation limits. Commit and push the completed changes.

## Implementation discretion

Exact module boundaries, SQL formulation, component reuse, and batching details
are builder decisions within the constraints above. Do not add unsupported
provider media fields or a second pipeline. If no additional verified ascent
photo contract exists, deliver KAYA photo retrieval plus explicit unverified
coverage for the other sources; do not claim all-provider retrieval is complete.
