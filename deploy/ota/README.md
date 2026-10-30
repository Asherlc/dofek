# OTA server image and storage operations

The server is based on [xprem 3.2.7](https://github.com/mercuretechnologies/xprem/releases/tag/v3.2.7),
commit `071f6d907527d7de1ba21dd0be23a6ba669a2b1c`. The Dockerfile retains the
official runtime and dashboard and replaces the binary with the same source
plus [upstream.patch](upstream.patch).

The patch propagates stored-metadata read and decode failures instead of
treating them as absent updates. Version 3.2.7 already propagates marker-read
errors; the [upstream repository](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/internal/repository/update_bucket.go)
still skips metadata errors. Executable HTTP tests cover both faults, malformed
metadata, incomplete uploads, empty runtimes, and complete manifests. They use
real filesystem failures and the normal server router.
Corrupt metadata in a newer update also blocks older candidates in that
branch/runtime with HTTP 500. This is intentional: storage corruption must not
silently choose an older update or become a successful empty response. Inspect
the failed object, preserve evidence, and repair or remove the invalid upload
through an explicit storage operation before publishing again.

## Build

Check out the immutable upstream revision into a separate build directory,
apply the patch there with `git apply`, then use that directory as the Docker
build context:

```sh
docker build --target test -f deploy/ota/Dockerfile <patched-upstream-directory>
docker build -t dofek-ota:3.2.7-dofek.1 -f deploy/ota/Dockerfile <patched-upstream-directory>
```

The compiler and runtime image are pinned by version and digest. The compiler
is [Go 1.27.3](https://go.dev/dl/); the upstream runtime remains non-root. The
result reports `3.2.7-dofek.1` so normal version-scoped caches identify this
binary separately. CI verifies the upstream tests and builds the runtime image.
On main, the workflow publishes source-commit tags to the private `dofek-ota-internal`
GHCR package and records its digest. The package must already exist and be
private before any licensed image is uploaded. A missing package, an unreadable
package, or any other visibility blocks publication. Bootstrap a new package
with a `FROM scratch` image containing only the repository source label; verify
its private visibility, repository linkage and anonymous pull denial before
using the canonical `build-private-ota.yml` workflow. Verify visibility again
after publication. The first publication on October 29 was public despite the
[documented private default](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry);
that default is insufficient evidence for uploading licensed code.
Do not export OTA build layers to GitHub Actions caches: this repository is
public, and [fork pull requests can read base-branch caches](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache).

Storage operations stream child stderr directly to CI while retaining stdout
for JSON results, using [Node subprocess stdio](https://nodejs.org/api/child_process.html#optionsstdio).
Phase boundaries and [rclone transfer statistics](https://rclone.org/flags/#logging)
identify work in progress without changing retries or deadlines. A cancelled
snapshot is unverified; use a new identifier and retain the failed prefix for
investigation.

## Migration boundary

Do not replace the production image until backup and rehearsal are complete.
The upstream [bucket migration](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/internal/bucket/v2_migration.go)
copies objects under the app ID and deletes their old paths. Reverting an image
does not restore those paths. Retain the signing key pair and app ID, and use
the matching 3.2.7 EOAS publisher with its app-scoped publication endpoints.

Pause publishers before taking a byte-verified snapshot in the separate backup
bucket. Rehearse using a second, mutable copy under a disjoint
`BUCKET_KEY_PREFIX`, with local cache. Compare manifest identities, verify
signatures with the retained public key, and verify asset bytes before cutover.
Keep the original snapshot unchanged for explicit restore if the migration
fails; the upstream [prefix wrapper](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/internal/objectstore/prefixed.go)
scopes migration reads, copies, and deletions to the configured prefix.

## Verified storage operations

Terraform provisions `dofek-ota-backups` separately from the serving bucket.
Its `snapshots/` prefix has an indefinite
[R2 bucket lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/),
preventing overwrite or deletion of recovery objects. The mutable `rehearsals/`
prefix has no lock. Keep snapshots until recovery is no longer required;
removing their retention policy requires a separately reviewed Terraform change.

Before dispatching **OTA Storage**, disable these workflows using
`gh workflow disable <file>` and wait for their existing runs to finish:

- `deploy-web.yml` (automatic releases)
- `deploy.yml` (manual releases)
- `mobile-preview-ota.yml` (preview publication)
- `cleanup-pr-r2.yml` (preview deletion)

The operator CLI checks that every workflow is manually disabled and has no
queued, running, pending, requested or waiting runs. Disabling a workflow does
not stop existing runs; GitHub documents
[workflow management](https://docs.github.com/en/actions/managing-workflow-runs/disabling-and-enabling-a-workflow).
Keep manual EAS/EOAS publication stopped for the same window.

Inventory capacity before planning a copy. The read-only `inventory` operation
runs [rclone size --json](https://rclone.org/commands/rclone_size/) on production
and prints object/byte totals. It creates no objects and does not consume the
planned snapshot identifier. Inventory can run from a reviewed branch and does
not hold the deployment lock or require publisher pauses. Its observed totals
can change during publication and never certify a backup.

```sh
SNAPSHOT_ID="$(date -u +%Y%m%d-%H%M%S)-before-v3"
gh workflow run ota-storage.yml --ref "$REVIEWED_REF" -f operation=inventory -f snapshot_id="$SNAPSHOT_ID"
```

Set `REVIEWED_REF` to main or the reviewed branch containing this operation.
[CI inventory 40976854752](https://github.com/Asherlc/dofek/actions/runs/40976854752)
reported 25,613 objects and 6,963,170,524 bytes. The instrumented default-worker
[copy attempt](https://github.com/Asherlc/dofek/actions/runs/40967669419)
completed 5,182 objects before the 30-minute limit, without reaching verification.
The copy and verification commands now use 64 transfers and 32 checkers. These
bounded worker counts address the measured API throughput requirement; rclone
recommends [parallelism for server-side S3 copies](https://rclone.org/s3/#increasing-the-rate-of-api-requests).
Higher concurrency increases request and runner memory use. The full byte check,
lock requirements, retries and 30-minute job bound remain unchanged.

Copies, verification and restores remain main-only, hold the production lock
and require paused writers. Pause the workflows listed above and wait for
existing deployment runs to finish before copying. Retain the same planned ID
throughout the following sequence; never reuse a failed snapshot ID:


```sh
gh workflow run ota-storage.yml -f operation=snapshot -f snapshot_id="$SNAPSHOT_ID"
gh workflow run ota-storage.yml -f operation=rehearsal-copy -f snapshot_id="$SNAPSHOT_ID"
```

Wait for each run to succeed before the next operation. The first copies the
production bucket into `snapshots/<id>/`; the second copies that snapshot into
`rehearsals/<id>/`. Existing destinations are refused. Both use pinned rclone
1.75.2, [copy --immutable](https://rclone.org/commands/rclone_copy/) and
[check --download](https://rclone.org/commands/rclone_check/) to compare bytes,
rather than relying on S3 multipart ETags. Empty sources fail before copying.
Only after the comparison succeeds, the workflow writes a locked sibling
`snapshots/<id>.verified.json` receipt containing the snapshot ID, object/byte
totals and CI run ID. Future production recovery uses this receipt; failed
copies or comparisons cannot create one.
The destination is locked as objects arrive, before verification. A failed copy
or verification consumes that snapshot ID; retain its run as failed evidence
and use a fresh ID after resolving the error. Never treat a failed run as a
recovery point or remove retention merely to reuse its name.
Existing Infisical `R2_ENDPOINT`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`
must permit both buckets; a denied list/read/write stops the operation.

Dispatch the CI rehearsal with the private image digest recorded by the main
image build:

```sh
gh workflow run ota-storage.yml -f operation=migration-rehearsal -f snapshot_id="$SNAPSHOT_ID" -f image=ghcr.io/asherlc/dofek-ota-internal@sha256:<digest>
```

The ARM64 job uses the [locked Infisical tool](../../mise.lock), loads existing
keys through OIDC and runs the candidate against **only** `dofek-ota-backups`,
with `BUCKET_KEY_PREFIX=rehearsals/<id>/` and `CACHE_MODE=local`. It observes the
candidate's migration-ready log before making manifest requests. It verifies
that the rehearsal copy still matches the original snapshot before starting
the container; a dirty or previously migrated copy fails before launch. Restore
that copy with `restore-rehearsal` before attempting another candidate.
After readiness, it verifies
the exact relocated object set and byte-checks moved and untouched objects
against the snapshot using [rclone file lists](https://rclone.org/filtering/#files-from0-read-nul-separated-list-of-source-file-names).
It then audits the latest complete main iOS update on both production and the
candidate: retained update UUID/runtime, the signature against the installed
device certificate, and SHA-256 hashes of the launch bundle and assets,
following the [Expo protocol](https://docs.expo.dev/technical-specs/expo-updates-1/).
The audit uses Remix's maintained
[multipart parser](https://github.com/remix-run/remix/tree/main/packages/multipart-parser)
to bind the signature to the manifest part's headers and exact bytes, and
[structured-headers](https://github.com/evert/structured-header) for the signature
dictionary. A signature on another MIME part does not certify the manifest.
The legacy request omits `expo-app-id`, exercising the installed-client fallback.
The audit bounds each asset fetch and body read to 60 seconds. Expo's
[iOS downloader](https://github.com/expo/expo/blob/expo%4058.0.21/packages/expo-updates/ios/EXUpdates/AppLoader/FileDownloader.swift)
uses a 60-second request timeout; the audit applies a total deadline so a stalled
body fails through normal candidate cleanup. The manifest deadline remains five
seconds.

The job stops the candidate before restoring the mutable copy and refuses to
restore if the stop fails. It byte-verifies restoration, then rechecks that
production still matches the locked snapshot. The job summary records the
image digest and retained update identity. For an explicit restore after a
failed rehearsal, first confirm that its CI runner/container has stopped:

```sh
gh workflow run ota-storage.yml -f operation=restore-rehearsal -f snapshot_id="$SNAPSHOT_ID" -f candidate_stopped=true
```

Restoration uses [rclone sync](https://rclone.org/commands/rclone_sync/) followed
by byte verification. It deletes migrated objects **only in the rehearsal
prefix** and restores the original layout from the locked snapshot. The tool
does not provide a production restore command: production recovery requires
quiescing the migrated server through the canonical deployment workflow before
any destructive restore, followed by verification and the old image. Never
run a restore while a server can continue migrating or a publisher can write.

After successful cutover and validation, re-enable each paused workflow with
`gh workflow enable <file>`. Retain the workflow run links, snapshot ID and
candidate image digest in the incident record.
Before cutover, dispatch `operation=verify-snapshot` with the same ID to prove
production still matches the locked snapshot after rehearsal. This operation
only lists and reads objects; it fails on any byte or object-set difference.

The [licensing guide](https://mercure-technologies.gitbook.io/xprem/references/open-core-and-licensing.md)
documents stateless community self-hosting. The full image includes EE code and
dashboard assets subject to the [EE license](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/ee/LICENSE).
Distribute this rebuilt image only privately for deployments with the required
commercial entitlement. Stateless mode does not enable enterprise features.
