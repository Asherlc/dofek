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

The [licensing guide](https://mercure-technologies.gitbook.io/xprem/references/open-core-and-licensing.md)
documents stateless community self-hosting. The full image includes EE code and
dashboard assets subject to the [EE license](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/ee/LICENSE).
Distribute this rebuilt image only privately for deployments with the required
commercial entitlement. Stateless mode does not enable enterprise features.
