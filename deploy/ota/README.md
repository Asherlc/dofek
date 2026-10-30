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

The patch also emits one canonical Content-Type field per multipart JSON part.
The [upstream response writer](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/internal/services/expo_protocol_service.go)
emits both `Content-Type` and `content-type`. A case-insensitive MIME parser
combines those into `application/json, application/json; charset=utf-8`, which
is not the JSON media type required by the [Expo protocol](https://docs.expo.dev/technical-specs/expo-updates-1/).
[RFC 2045's entity-header grammar](https://www.rfc-editor.org/rfc/rfc2045.html#section-3)
defines a single optional `Content-Type` field per MIME entity.
Real-router regressions assert one parseable JSON Content-Type for complete
manifests and empty/incomplete update directives, as well as the existing
storage fault cases. Keep the client parser strict. The production image pin
in [stack.yml](../stack.yml) is the release source of truth.

Stateless publisher authentication resolves Expo's `meActor` identity and compares
its nonempty ID with the actor of the access token configured for that app.
This supports the existing [Expo robot token](https://docs.expo.dev/accounts/programmatic-access/)
without accepting another actor with a matching username. Null identities and
GraphQL errors remain authentication failures. The upstream human-user lookups
used for dashboard display remain separate; upload-route regression tests cover
robots, humans and identity rejection. Preserve the empty-identity refusal from
[upstream security fix #311](https://github.com/mercuretechnologies/xprem/pull/311)
when changing this check; two empty lookup results must never authenticate.

The [unchanged-publication correction](https://github.com/mercuretechnologies/xprem/pull/312)
returns the existing manifest UUID when an identical export is published. The
workspace pins EOAS 3.2.7 with the matching [CLI patch](../../patches/eoas@3.2.7.patch),
and both publishers invoke that installed CLI. Its receipt includes unchanged
platforms so the existing device signature and asset audit also runs on a no-op.
With `--emitMetadata`, a missing unchanged identity is an explicit failure.

## Build

Check out the immutable upstream revision into a separate build directory,
apply the patch there with `git apply`, then use that directory as the Docker
build context:

```sh
docker build --target test -f deploy/ota/Dockerfile <patched-upstream-directory>
docker build -t dofek-ota:3.2.7-dofek.4 -f deploy/ota/Dockerfile <patched-upstream-directory>
```

The compiler and runtime image are pinned by version and digest. The compiler
is [Go 1.27.3](https://go.dev/dl/); the upstream runtime remains non-root. The
result reports `3.2.7-dofek.4` so normal version-scoped caches identify this
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

## Release storage and publication

Production serves new updates from the Terraform-managed `dofek-ota-releases`
bucket. The old `dofek-ota` bucket and partial locked snapshots in
`dofek-ota-backups` remain untouched. They are historical artifacts, not
prerequisites for publication or verified recovery points. Old updates are not
copied into the serving bucket.

Retain the public OTA URL, application ID and signing keys. Version 3.2.7
supports installed clients without an app-ID header through its
[legacy application fallback](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/config/apps.go).
New native configuration includes `expo-app-id`, required by the matching
[EOAS publisher](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/apps/eoas/src/lib/expoConfig.ts).
The header changes the [fingerprint runtime](https://docs.expo.dev/eas-update/runtime-versions/),
so this release requires the matching TestFlight binary before a device can
receive its OTA updates. Older installs retain their embedded/cached app; no
old-runtime update is republished into the fresh store.
Publication uses app-scoped keys; preview deletion and the new bucket's
14-day lifecycle target only `<app-id>/pr-`, preserving shared assets.
See the [upstream key layout](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/internal/bucket/keys.go)
and [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

The canonical Terraform workflow creates the bucket before the stack workflow
switches the pinned private image and bucket together. The existing Swarm
convergence gate includes OTA and checks both its desired digest and every
running task against the canonical stack pin before reporting success; it
retains the existing startup stability window. Deploy OTA resolves the
current iOS runtime, validates the server within five seconds, publishes with
EOAS 3.2.7, then verifies the exact published UUID/runtime, manifest signature
and all asset hashes using the retained device certificate. An empty runtime is
accepted only through the [Expo no-update protocol](https://docs.expo.dev/technical-specs/expo-updates-1/).
Storage read/decode failures remain fatal. The gate and receipt audit send the
same `expo-app-id` header as the configured client.

The audit detects failures after publication; it does not make publication
atomic. A failed audit leaves that release advertised until explicit repair.
EOAS [omits its receipt when the bundle is unchanged](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/apps/eoas/src/commands/publish.ts).
The audit then compares the served launch bundle hash and complete asset hash set
against the fresh local export for the explicitly resolved runtime. It verifies
the device signature and every downloaded asset before writing the existing
update's verified identity as a receipt. Missing exports, content differences,
signature failures and unreadable assets remain fatal; a present receipt still
requires its exact UUID, runtime and branch.
[Expo clients verify manifest signatures and asset hashes](https://docs.expo.dev/technical-specs/expo-updates-1/)
and reject invalid downloads. Keep the failed UUID/runtime and evidence,
diagnose whether the cause is transport, configuration or corruption, then
perform targeted remediation. Do not automatically delete a potentially valid
release or shared immutable assets merely because a network audit failed. A publication failure leaves the
installed app's embedded or cached update available; diagnose the failed step
before retrying. Keep automatic and preview workflows enabled throughout this fresh-store
rollout. A failed gate stops the affected run for diagnosis; it does not
authorize disabling publishers. Any pause requires fresh explicit operator
approval naming that pause. No migration freeze is required.

The [licensing guide](https://mercure-technologies.gitbook.io/xprem/references/open-core-and-licensing.md)
documents stateless community self-hosting. The full image includes EE code and
dashboard assets subject to the [EE license](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/ee/LICENSE).
Distribute this rebuilt image only privately for deployments with the required
commercial entitlement. Stateless mode does not enable enterprise features.
