<!-- cspell:ignore Stravalib EXIF -->
# Provider activity image copies

Dofek stores original provider images in a private R2 bucket and keeps every
provider association in Postgres. Identical bytes share one object only within
an account. This feature stores exposed photos, screenshots, and class artwork;
it does not generate screenshots, import videos, or scrape arbitrary pages.
The [approved design](superpowers/specs/2026-10-20-activity-images-design.md)
describes the intended behavior and retention contract.

## Provider coverage and evidence

This audit inspected the production registration in
[src/jobs/provider-registration.ts](../src/jobs/provider-registration.ts), each
activity writer, client types, and the sources below. Source-backed contracts
are not authenticated live-account validation. A missing adapter means
**unverified retrieval**, not proof that the provider has no photographs.

| Activity source | Implemented collection | Evidence / remaining limit |
| --- | --- | --- |
| Peloton | Joined ride `image_url` and each recognized `extra_images` entry | [Client payload example](https://github.com/justmedude/pylotoncycle); [Dofek client schema](../packages/peloton-client/src/types.ts). Unknown extra-image shapes produce partial coverage. Private API; live account not tested here. |
| Strava | Activity gallery with `photo_sources=true`, paginated with `page`/`per_page`; primary photo fallback | [Stravalib's implemented `get_activity_photos`](https://github.com/stravalib/stravalib/blob/main/src/stravalib/client.py), [official primary-photo model](https://developers.strava.com/docs/reference/#api-models-PhotosSummary). Requests size 4096 and selects the largest returned resolution; this does not promise a camera-original resolution the API does not expose. Gallery endpoint is unofficial; incomplete/error/repeated pages produce partial coverage. |
| Zwift | Primary screenshot URL from activity summary; refreshed summary lookup for historical records | [Wrapper source types](https://github.com/rally25rs/zwift-api-wrapper/blob/master/src/types.ts), [Dofek source audit](zwift.md). Source types leave snapshot payloads unknown; full snapshot gallery is explicitly partial. No guessed image endpoint. |
| Ride with GPS | Retrieval unverified | [API attributes](https://ridewithgps.com/api/v1/doc/reference/routes_and_trips) and [product photo support](https://support.ridewithgps.com/hc/en-us/articles/4419009425563-Add-Photos-to-an-Activity-or-Route-on-the-Website). Photos exist in the product; the inspected API contract does not establish retrieval. |
| Garmin | Retrieval unverified | [Activity API overview](https://developer.garmin.com/gc-developer-program/activity-api/), [current official API ingestion](../src/providers/garmin/activities.ts). Profile images are not activity media. |
| AllTrails | Retrieval unverified | [Recording API audit](alltrails.md), [current writer](../src/providers/alltrails.ts); no verified per-recording photo contract in the inspected implementation. Trail catalog photos are not personal activity photos. |
| Wahoo | Retrieval unverified | [Current activity persister](../src/providers/wahoo/activity-persister.ts) and [provider](../src/providers/wahoo/provider.ts); no image retrieval adapter. |
| WHOOP | Retrieval unverified | [Workout writer](../src/providers/whoop/sync-workouts.ts), [source audit](whoop.md); no verified activity-media adapter. |
| Polar | Retrieval unverified | [Exercise sync](../src/providers/polar/sync-service.ts), [provider audit](polar.md); no verified media retrieval path. |
| Oura | Retrieval unverified | [Activity sync](../src/providers/oura/sync-steps.ts), [source audit](oura.md); no verified media retrieval path. |
| TrainerRoad | Retrieval unverified | [Current client/writer](../src/providers/trainerroad.ts), [API audit](trainerroad.md); generated chart screenshots are not automatically presumed available through its API. |
| Concept2 | Retrieval unverified | [Current client/writer](../src/providers/concept2.ts); no verified image adapter. |
| Xert | Retrieval unverified | [Current client/writer](../src/providers/xert.ts); no verified image adapter. |
| Cycling Analytics | Retrieval unverified | [Current client/writer](../src/providers/cycling-analytics.ts); no verified image adapter. |
| Wger | Retrieval unverified | [Current client/writer](../src/providers/wger.ts); exercise catalog pictures are not individual workout photos. |
| Kaya | Retrieval unverified | [Current sync writer](../src/providers/kaya-sync.ts); no verified per-activity media contract. |
| Amazfit/Zepp | Retrieval unverified | [Current client/writer](../src/providers/amazfit-zepp.ts); no verified activity-media contract. |
| FIT, Garmin dump, Apple Health, Strong CSV, Kaya CSV, Zepp OS imports | No verified embedded image extraction | [FIT import](../src/providers/fit-file.ts), [Garmin export importer](../src/providers/garmin-dump.ts), [Apple Health importer](../src/providers/apple-health/import.ts), [Strong importer](../src/providers/strong-csv.ts), [Kaya importer](../src/providers/kaya/import.ts), [Zepp OS importer](../src/providers/zos-app/provider.ts). Unsupported media is reported rather than inferred from sensor records. |

Health/nutrition-only registrations do not produce activity photo candidates.
Unregistered historical modules (Fitbit, Suunto, COROS, Komoot, MapMyFitness,
Decathlon) retain unavailable coverage. See the
[production provider scope](../src/providers/README.md#supported-providers).

## Storage and background work

- `fitness.activity_image` owns provider identity, caption/order, source payload,
  resolution alternatives, generation, and the current stored-object reference.
- `fitness.activity_image_object` owns hash, object key, MIME type, dimensions,
  and original-byte length. Object keys are `images/<user-id>/<sha256>`.
- `fitness.activity_image_discovery` records complete, partial, unavailable, or
  failed discovery. Discovery coverage is separate from acquisition status.
- `fitness.activity_image_work` is the durable outbox and acquisition ledger.
  Redis carries IDs; source URLs are never included in queue payloads.
- `fitness.activity_image_backfill` records historical scan checkpoints.

The outbox polls every five seconds. Acquisition has four worker slots and uses
existing provider/user execution locks and account-erasure barriers. Five
attempts use exponential delays from 30 seconds, respecting image-host
Retry-After. Expired links are refreshed through the provider once per attempt.
A stored copy remains available when a refresh fails.
Rediscovery updates URLs in place; only a changed source revision advances the
generation. Stored or exhausted acquisition work is not restarted by unchanged
rediscovery ([persistence implementation](../src/db/activity-images.ts)).

Downloads allow public HTTPS destinations only, pin validated DNS results,
revalidate redirects, and never send provider credentials to image hosts.
Limits are 50 MiB, 100 million pixels, three redirects, and two minutes.
Downloads stream original chunks to a temporary file with incremental hashing;
metadata inspection reads that file rather than buffering a complete original.
Rejected images remain visible as failed acquisition records. JPEG, PNG, WebP,
GIF, AVIF, and supported HEIF images retain their original bytes; no EXIF
stripping or recompression occurs. Animated files are not flattened.

Reconciliation runs every five minutes, repairs 15-minute stale leases, and
checks at most 100 stored keys per sweep. Unreferenced files older than one day
are eligible for cleanup. Cleanup tries an exclusive user-work session advisory
lock in the existing four-session guard pool, skipping busy locks or a full
guard pool; acquisitions retain the shared user-work lock through upload and
attachment. Cleanup skips admitted work and briefly blocks new work for that
user only after acquiring the lock, preserving live associations without holding
a database transaction during R2 requests. PostgreSQL documents these
[session and shared/exclusive advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).
R2 supports the required operations through its [S3 API](https://developers.cloudflare.com/r2/api/s3/api/).

## Backfill and API

After configuration and migration, run from the repository root:

```bash
pnpm tsx scripts/backfill-activity-images.ts --user-id <uuid>
pnpm tsx scripts/backfill-activity-images.ts --user-id <uuid> --provider-id strava
pnpm tsx scripts/backfill-activity-images.ts --user-id <uuid> --status <run-id>
```

Commands enqueue durable runs; the worker must be running. A run scans 100
source activities per page using `(started_at, id)` checkpoints and a captured
upper time bound. Re-running the command starts another idempotent discovery
pass. Disconnected providers stop with a disconnected status; start a new pass
after reconnection. Scanned/discovered/failed are run counters. Stored and
coverage are current provider-wide totals, not a claim that discovery completed
all downloads in that run. Partial/failed rows identify records requiring a
provider-contract investigation. Transient discovery failures pause before the failed
activity and retry after the provider’s Retry-After deadline (five minutes by
default). Failure counters count attempts; unavailable historical records advance
the checkpoint. PostgreSQL retains failure history, while failed Redis jobs are
removed so the durable dispatcher can recreate them.

`activity.images({id})` uses the existing activity visibility and entitlement
resolution, then reads images from every contributing source activity. The
response includes image metadata, all source associations, discovery coverage,
and current acquisition states. Identical stored objects appear once. Signed
URLs expire after five minutes and are bearer credentials
([Cloudflare signed URL guidance](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)).

Web and mobile activity details display downloaded images in a Photos gallery.
Selecting a thumbnail opens the full image with its caption and source provider.
Activity cards show the first downloaded image only when they have no map;
recorded routes, climbing-source maps, and processing maps take precedence.
Activities without a downloaded image keep their existing details-only card.
The clients reuse `activity.images`, including its ownership and canonical-group
resolution, rather than fetching provider URLs directly.

The [shared image query policy](../packages/training/src/activity-images.ts)
refreshes signed links on mount/focus and every four minutes while observed.
If renewal fails while stored photos remain, it retries after thirty seconds.
It polls pending acquisitions every three seconds and stops polling completed
empty results. Web card queries run only near the viewport and retain loaded
photos when scrolled away. Mobile excludes these bearer URLs from its persisted
query cache. These settings use TanStack Query's
[query lifecycle options](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery)
and [dehydration filtering](https://tanstack.com/query/latest/docs/framework/react/reference/hydration).
The web image viewer reuses the existing modal with keyboard containment,
Escape dismissal, and focus restoration, following the
[WAI modal-dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

## Deployment and deletion

Provision the private `dofek-activity-media` bucket through Terraform and set
`ACTIVITY_MEDIA_R2_BUCKET` in Infisical before deployment. Web and worker reuse
the existing R2 client credentials. Do not apply import/export expiry policies
to permanent media. See [deployment storage](../deploy/README.md#activity-image-storage).

Provider absence hides associations while retaining archived bytes; disconnect
stops acquisition and retains existing copies. Explicit activity deletion
retires its image associations. Shared objects remain until no retained source
references them; cleanup removes unreferenced files after the grace period.
Account erasure purges image queue jobs, database records, and the entire user
object prefix under the existing work barrier, including files whose database
acknowledgement was interrupted. The erasure sweep paginates and verifies an
empty prefix before acknowledging success. See the
[erasure runbook](account-erasure-runbook.md).

## Validation limits

Unit tests cover discovery, variant selection, redirects/DNS boundaries,
original-byte metadata, retries, outbox delivery, and authorization ordering.
Database and real S3 integration tests are checked in for ownership,
checkpoints, byte preservation, and account isolation. Authenticated live
provider calls, production R2 provisioning, and Infisical changes require the
corresponding runtime access; they were not performed during implementation.

S3 integration fixtures configure explicit SeaweedFS identities: ordinary requests
can succeed anonymously while SigV4 streaming uploads fail with
`InvalidAccessKeyId`. The storage and erasure-race fixtures use the same explicit
credentials. This was reproduced with SeaweedFS 4.47 running natively and verified
with original-byte upload, retrieval, and prefix erasure.
