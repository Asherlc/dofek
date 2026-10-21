# Preserve provider activity images

Status: written specification approved in conversation on 2026-10-20.
Implementation has not started.

## Outcome and scope

Dofek keeps its own private copies of every distinct image that connected
providers expose for a user's activities. Photos, workout screenshots, and
class artwork are included. The user explicitly requested all images and
confirmed that storing remote URLs alone is insufficient.

Collect images from every contributing provider, including historical
activities. Do not limit collection to a primary image or choose one provider
as the only media source. Preserve source associations even when identical
bytes share one stored object. Resolution variants of the same source image
are alternatives: download the highest resolution the provider exposes;
distinct images and edited images remain distinct assets. Do not upscale,
recompress, or discard original metadata while copying the selected file.

This scope excludes videos, unrelated profile portraits, arbitrary photographs
of a trail or climbing route, manual uploads, and generated summary cards.
Artwork explicitly attached to the activity's class is included. Historical
files that a provider no longer exposes cannot be recovered from a URL alone.

## Existing architecture and alternatives

Reuse the AWS SDK and R2 client in [r2-storage.ts](../../../src/r2-storage.ts).
The existing [file upload architecture](../../file-upload-architecture.md)
provides the ownership, durable dispatch, and cleanup patterns to follow.
Use a dedicated private activity-media bucket: imports and exports have
different retention rules and must not expire permanent image copies.
R2 supports the required object operations through its
[S3-compatible API](https://developers.cloudflare.com/r2/api/s3/api/).

URL-only storage does not meet the requested outcome. Database byte storage
would put image payloads into relational backups and replication. A new media
hosting vendor adds an unnecessary service when R2 is already integrated.

## Data ownership

Introduce two relational concepts in Postgres:

- An image object owns the stored bytes: user ID, SHA-256, opaque object key,
  MIME type, byte length, dimensions, and creation time. Enforce uniqueness
  within a user by content hash. Never share objects between user accounts.
- A provider image record owns the source association: user, source activity,
  provider, provider image identity, original source URL, image kind, caption,
  source order, available resolution metadata, source payload, current object
  reference, and acquisition state. Source IDs are scoped to their provider
  and activity. Use a stable provider media identity where available; rotating
  signed URL query parameters must not create new logical images.

Use same-user foreign keys for source activity and object ownership. Keep
provider records independent even if their bytes match. This follows the
[schema's raw-source ownership rules](../../schema.md); file deduplication
must not discard source observations or merge provider records.

Associate images with source activity rows, not a chosen canonical winner.
Resolve the existing activity group at read time so merge/split behavior follows
its contributing source activities. Do not copy a second gallery onto the group.

## Provider discovery and coverage

Every production activity provider must be audited for image discovery. Each
adapter reports complete discovery, partial discovery, unavailable API support,
or a failed request. An empty complete result means no exposed images; lack of
support or a failure must not be presented as an empty complete gallery.
Enumerate all pages of any verified gallery endpoint.

Known starting points from source inspection and documentation:

- Peloton: joined ride data is already fetched. Extend the ride schema and
  mapper to preserve class artwork. The author's
  [pylotoncycle payload example](https://github.com/justmedude/pylotoncycle)
  contains `ride.image_url`; this is third-party client evidence for a private
  API, not a live verification or a supported Peloton API contract.
- Strava: preserve the detailed activity response in regular sync rather than
  retaining only the list summary. Its official
  [PhotosSummary model](https://developers.strava.com/docs/reference/#api-models-PhotosSummary)
  exposes the primary image and count. This does not establish full gallery
  access. A count larger than discovered images is partial coverage; verify
  any gallery endpoint before adding it.
- Zwift: screenshots and export to Strava are documented by
  [Zwift](https://www.zwift.com/eu/news/29644-video-screenshots).
  Direct screenshot retrieval is unverified; the current Dofek client has no
  image discovery implementation. Preserve screenshots exposed through a
  connected Strava activity without claiming direct Zwift coverage.
- Ride with GPS: [ride photos exist](https://support.ridewithgps.com/hc/en-us/articles/4419009425563-Add-Photos-to-an-Activity-or-Route-on-the-Website),
  but the audited [API attributes](https://ridewithgps.com/api/v1/doc/reference/routes_and_trips)
  do not establish photo retrieval. Garmin and the remaining providers also
  require explicit retrieval evidence before claiming support.

Document verified adapter coverage and its limits. Do not ship guessed
endpoints or claim that the first two adapters provide universal coverage.

## Acquisition and ongoing sync

Discovery writes provider image records and durable acquisition work. Follow
the existing Postgres outbox/BullMQ pattern so a Redis interruption cannot lose
discovered work. Use deterministic job identities and bounded concurrency.

Workers resolve current per-user provider credentials, refresh expired source
links through the provider when possible, and download the selected image.
Validate the response's image signature, MIME type, byte count, and dimensions;
enforce documented finite file-size and request-time limits. Reject private
network destinations and validate redirects; never forward provider credentials
to a different origin or log signed source URLs.

Hash downloaded bytes, upload to the user's content-addressed object key, then
mark the source image stored. A failed upload never creates a ready record.
Concurrent downloads of identical bytes converge on one user-owned object.
Retries after upload but before database acknowledgement must be idempotent.
Reconcile orphaned objects and stale work using the established cleanup pattern.

Record pending, processing, stored, retryable-failure, and terminal-failure
states with attempt information and a sanitized reason. Respect provider rate
limits and bounded retry policies. Failed image acquisition does not erase a
successfully synced workout or pretend that the image was stored.

On later syncs, refresh source metadata and discover additions. Do not overwrite
a stored copy merely because its URL changed. If a stable source image changes
content, point its association to the newly stored object and reclaim an old
object only after no retained association references it.

## Historical backfill

Provide a resumable, paginated job over each user's existing source activities,
including records outside the normal recent sync window. Re-fetch source image
metadata when the current raw payload omitted it. Share provider throttling
with routine sync; checkpoint progress and expose discovered/stored/failed counts
and coverage. Repeated runs must not duplicate associations or stored files.
Backfill does not run inside an activity-detail HTTP request.

## Access, retention, and deletion

Serve only stored images after authenticating the user and checking source
activity visibility and ownership. Prefer the existing short-lived signed URL
pattern; signed URLs are bearer credentials per
[Cloudflare's guidance](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
Return image metadata and all contributing provenance through the shared API.
Collapse identical bytes for display while retaining every source association.
No gallery UI redesign or thumbnail-generation subsystem is required here.

Provider-side absence hides the source association under existing activity
visibility rules but preserves the archived copy; disconnecting a provider
stops acquisition without deleting the user's existing archive. Explicit Dofek
activity deletion retires that source's associations and schedules deletion of
objects no longer referenced by another retained activity. Account erasure
removes all image records, queued work, and the entire user object prefix.
Use the existing [account-erasure lifecycle](../../account-erasure-runbook.md)
to fence workers, prevent late writes, and reconcile restored database rows
against deleted accounts. Deletion failures remain retryable and observable.

## Configuration and validation

Provision a private media bucket through the existing Terraform/deployment
workflow. Add its required bucket binding through Infisical before deploying
runtime code that requires it. Reuse the existing R2 SDK and credential pattern;
include the bucket in erasure inventories. Media objects have no automatic
age-based expiry. Do not alter backup, import, or export retention policies.

Acceptance evidence must cover provider pagination and partial coverage,
all-image discovery, highest-resolution selection, cross-provider provenance,
same-user content deduplication, cross-user isolation, idempotent retries,
expired URLs, invalid responses, rate limiting, interrupted backfills, grouped
activity reads, activity deletion, and erasure racing with an in-flight upload.
Use database/object-store integration tests for constraints and lifecycle
behavior, with focused unit tests for parsing and download validation. Run the
repository's required checks and report unavailable live-provider or service
validation explicitly. Documentation review alone does not verify retrieval.
