# OTA server upgrade

The operator approved upgrading the server and publisher to 3.2.7 and migrating
storage before merging the runtime/protocol gate correction in PR 3148.

## Required behavior

- Marker and stored-metadata read failures must produce HTTP 500, never a
  successful empty-runtime response. Genuinely absent markers, empty runtimes,
  and valid updates retain their protocol behavior. The pinned 2.3.16 server
  suppresses both failures; [3.2.7 fixes markers but still skips metadata errors](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/internal/repository/update_bucket.go).
- Use server and EOAS publisher 3.2.7. Preserve current signing keys, app ID,
  channel mapping, R2 and Redis configuration. The [new publisher endpoints](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/internal/router/routes_publish.go)
  include the app ID; installed clients retain the [legacy app-ID fallback](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/internal/handlers/manifest_handler.go).
- Before production migration, pause publishers, make an immutable verified
  backup, rehearse on a separate copy, and prove the source was unchanged.
  The upstream [migration copies and deletes object paths](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/internal/bucket/v2_migration.go)
  and its down migration does not restore old paths. Image rollback alone is
  insufficient; retain an executable restore procedure.
- Isolate rehearsal with [BUCKET_KEY_PREFIX](https://github.com/mercuretechnologies/xprem/blob/v3.2.7/internal/bucket/keys.go)
  and local cache. Keep backup and mutable rehearsal prefixes disjoint.
- Terraform owns new R2 infrastructure. Use existing Infisical-managed
  credentials. Deployment goes through the canonical workflows; no manual
  Swarm changes, temporary production flags, or compatibility routes.
- After the server fix is deployed, the gate validates the publishing runtime,
  accepts the [valid no-update directive](https://docs.expo.dev/technical-specs/expo-updates-1/),
  rejects mismatched manifests, and keeps its existing five-second deadline.

## Validation and limits

Fault-injection tests must run against executable server behavior. Rehearsal
must preserve old manifest identities and signatures, serve assets, migrate
paths only inside its prefix, and support the upgraded publisher. Verify bytes,
not just object counts, in the backup and restore path; [rclone check --download](https://rclone.org/commands/rclone_check/)
provides an established object-store comparison tool.

The iOS release proceeds independently after the Account Holder accepted Apple's
agreement. A successful upload is distinct from processing and on-device capture.
The missing historical WHOOP ride samples remain unrecovered.
