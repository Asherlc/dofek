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

The validated private candidate is `ghcr.io/asherlc/dofek-ota-internal@sha256:32982fe09df2d69ecc880c6d5418e933338f4d8ee79a4da8ce59cdb1e573fc85`, built from Dofek revision
`910118225de6062b265e2758eda265ad233a7c14`. The
[canonical CI publication](https://github.com/Asherlc/dofek/actions/runs/40967775586)
passed upstream tests and both privacy checks; authenticated metadata confirms
private visibility and anonymous pull authorization is denied. Production
migration still requires a successful snapshot and isolated rehearsal.

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

Run a read-only inventory before sizing a backup. Inventory uses rclone's
[size --json](https://rclone.org/commands/rclone_size/) to report production
object and byte totals, including an empty bucket. It creates no snapshot and
does not consume the supplied planned identifier. The manual workflow allows
only this read-only operation on a reviewed non-main ref; every copy, restore,
verification and rehearsal operation remains main-only. Set `REVIEWED_REF` to
main or the reviewed branch containing this operation, and generate a fresh
planned identifier:

```sh
SNAPSHOT_ID="$(date -u +%Y%m%d-%H%M%S)-before-v3"
gh workflow run ota-storage.yml --ref "$REVIEWED_REF" -f operation=inventory -f snapshot_id="$SNAPSHOT_ID"
```

Retain the same snapshot ID throughout this sequence. Never
reuse the failed `2026-10-29-before-v3` identifier. Dispatch on main, in order:

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
A successful snapshot writes a locked sibling verification receipt at
`snapshots/<id>.verified.json`, containing its object count, byte count and CI
run ID. Production restore and migration verification require that receipt
and matching snapshot totals before proceeding.
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
prefix** and restores the original layout from the locked snapshot. Production recovery uses the separately guarded procedure below. Never run a
restore while a server can continue migrating or a publisher can write.

Before resuming automatic deployment, require successful **main push CI** for
the cutover commit or a reviewed descendant containing the upgrade. The
[release selector](../../scripts/select-web-deploy.ts) chooses the newest
successful main CI release; a manual deployment alone does not establish that
baseline. Cancel or drain obsolete main CI while publishers remain disabled,
and confirm no older deployment runs remain queued, waiting or running. After
cutover, delivery verification and that main CI baseline succeed, re-enable each
paused workflow with `gh workflow enable <file>`. Verify the first automatic
deployment selects the cutover release or a reviewed newer release. Retain the
workflow run links, snapshot ID and candidate image digest in the incident record.
Before cutover, dispatch `operation=verify-snapshot` with the same ID to prove
production still matches the locked snapshot after rehearsal. This operation
only lists and reads objects; it fails on any byte or object-set difference.

The [licensing guide](https://mercure-technologies.gitbook.io/xprem/references/open-core-and-licensing.md)
documents stateless community self-hosting. The full image includes EE code and
dashboard assets subject to the [EE license](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/ee/LICENSE).
Distribute this rebuilt image only privately for deployments with the required
commercial entitlement. Stateless mode does not enable enterprise features.


## Production cutover and recovery

Before cutover, retain the verified snapshot/rehearsal run links and inspect the
actual desired OTA image and app image through the read-only Docker API. Record
the app image source revision as well. Use only the private candidate digest
that passed the isolated rehearsal. Production's pinned stack image, EOAS
publisher version, application identity, preview cleanup/lifecycle prefix and
runtime gate must be changed as one release. The app ID and signing keys remain
the existing Infisical values; clients keep their installed URL and certificate.
The upstream [migration](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/internal/bucket/v2_migration.go)
requires the matching app-scoped publisher.

Dispatch the canonical Deploy workflow for that reviewed release with
`target=web`. This applies Terraform and the stack without publishing OTA. Do
not use `all` or `ota` for this step: those targets publish before the exact
snapshot comparison can run. Keep preview and cleanup workflows paused. Enable
the manual dispatcher only for the operation, then disable it again when it
finishes; the storage CLI requires all four writers disabled and no outstanding
runs. Retain `CUTOVER_SHA` and a release tag `CUTOVER_REF` pointing to that
reviewed main commit. Use the same tag for cutover, publication and recovery:
[workflow dispatch accepts a branch or tag reference](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

```sh
gh workflow enable deploy.yml
gh workflow run deploy.yml --ref "$CUTOVER_REF" -f target=web
# Wait for the complete Deploy run to succeed, then:
gh workflow disable deploy.yml
```

Before publication, dispatch:

```sh
gh workflow run ota-storage.yml -f operation=verify-production-migration -f snapshot_id="$SNAPSHOT_ID"
```

After that verification succeeds, enable the dispatcher for a separate
`target=ota` deployment from the same validated release and app image tag. That
target completes the canonical server check before publishing. Resume the other
writers only after the post-publication audit succeeds.

This operation requires the locked backup receipt and compares the entire
production object set and all retained bytes against the expected migration of
that snapshot. It performs no writes. Complete it before publishing a new
update, because publication intentionally adds objects. Both production and
preview publication then audit the EOAS `--emitMetadata` receipt: the exact
published UUID/runtime, installed device certificate signature and every asset
hash. The manifest gate requests the runtime being published, accepts a genuine
empty-runtime directive, and retains its five-second deadline, following the
[Expo protocol](https://docs.expo.dev/technical-specs/expo-updates-1/).

If migration fails, keep all publishers paused. Use the canonical Deploy
workflow's `web-stack` target with `ota_quiesce=true`. Use the currently
deployed app release's recorded release tag and image tag, plus the recorded immutable old
OTA image as `ota_image`. The app image must match the dispatch revision;
[image verification](../../scripts/resolve-deploy-image.ts) rejects mismatches.
Do not roll back the app image or database schema to an earlier release merely
to restore OTA storage. The zero-replica overlay remains active during every
canonical stack apply, and the workflow waits for actual OTA tasks to stop
using [Swarm task states](https://docs.docker.com/engine/swarm/how-swarm-mode-works/swarm-task-states/).
After that workflow finishes, disable the manual dispatcher again. Then run:

```sh
gh workflow run ota-storage.yml -f operation=restore-production -f snapshot_id="$SNAPSHOT_ID"
```

Restore verifies the explicit production Docker endpoint, zero desired replicas,
all actual task states, paused writers and the locked backup receipt before any
write. It uses [rclone sync](https://rclone.org/commands/rclone_sync/) from the
snapshot to the serving bucket, then byte-checks the result. Any failed guard,
copy or comparison stops the operation. The isolated rehearsal exercises the
same transfer tools without writing production; production destination and task
refusal paths have executable CLI regression tests.

Only after restore succeeds, deploy the recorded old OTA image through the
canonical workflow with `ota_quiesce=false`, keeping the same current app
release. Keep publication paused until a coherent server/publisher release has
been validated. Re-enabling the old image alone cannot undo migrated paths.
The quiescence bound remains the canonical 35 minutes, and the storage job bound
remains 30 minutes; these existing limits bound operator work and are not
substitutes for diagnosis of a stalled phase.
