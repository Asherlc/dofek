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
On main, the workflow publishes source-commit tags to the private `dofek-ota`
GHCR package and records its digest. Visibility is checked before and after
publication; a public package stops the job. GitHub documents that
[new container packages are private by default](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
Do not export OTA build layers to GitHub Actions caches: this repository is
public, and [fork pull requests can read base-branch caches](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache).

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

Use a unique snapshot ID, for example `2026-10-29-before-v3`. Dispatch the
workflow on main, in this order:

```sh
gh workflow run ota-storage.yml -f operation=snapshot -f snapshot_id=2026-10-29-before-v3
gh workflow run ota-storage.yml -f operation=rehearsal-copy -f snapshot_id=2026-10-29-before-v3
```

Wait for each run to succeed before the next operation. The first copies the
production bucket into `snapshots/<id>/`; the second copies that snapshot into
`rehearsals/<id>/`. Existing destinations are refused. Both use pinned rclone
1.75.2, [copy --immutable](https://rclone.org/commands/rclone_copy/) and
[check --download](https://rclone.org/commands/rclone_check/) to compare bytes,
rather than relying on S3 multipart ETags. Empty sources fail before copying.
The destination is locked as objects arrive, before verification. A failed copy
or verification consumes that snapshot ID; retain its run as failed evidence
and use a fresh ID after resolving the error. Never treat a failed run as a
recovery point or remove retention merely to reuse its name.
Existing Infisical `R2_ENDPOINT`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`
must permit both buckets; a denied list/read/write stops the operation.

Start the candidate server against **only** `dofek-ota-backups`, with
`BUCKET_KEY_PREFIX=rehearsals/<id>/` and `CACHE_MODE=local`, retaining the app
ID and signing keys. Verify migration, manifests, signatures and asset bytes.
Stop that rehearsal server before testing restoration:

```sh
gh workflow run ota-storage.yml -f operation=restore-rehearsal -f snapshot_id=2026-10-29-before-v3
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
