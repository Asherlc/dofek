# Phase 2: enable tiered storage on the existing Kafka broker

This is the release review for [PR #3236](https://github.com/Asherlc/dofek/pull/3236).
Kafka is already live; the [phase-1 receipt](phase1-execution.md) and
[shared application release receipt](shared-release-execution.md) describe that
completed work. Keep its data directory, cluster/topic UUIDs, offsets, consumer
groups and archive namespaces. Do not format storage or recreate topics.

The earlier combined first-cutover and complete-child retarget proposals are
historical. Their [dated commands](https://github.com/Asherlc/dofek/blob/62298eeb0246053aa5e2e23e84e09c16efdc8856/deploy/kafka/tiered-cutover-packet.md)
are not the phase-2 procedure. Do not repeat their directory creation, topic
creation or per-service credential arguments.

## Source landing and activation

The `Deploy Web` workflow was observed as `disabled_manually` during this review;
the [release-readiness receipt](../../docs/evidence/kafka-tiered-transition-20261109/release-readiness.json)
records the observation from GitHub's [workflow API](https://docs.github.com/en/rest/actions/workflows#get-a-workflow).
Keep that existing hold unchanged. Source merge does not authorize reenabling
automatic deployment, dispatching a release, changing credentials or activating
tiering. Recheck the workflow state before source merge.

After main CI builds the exact merged source, qualify and select that immutable
application image through the existing [release workflow](../../.github/workflows/deploy-web.yml).
The normal [image/source matching](../../scripts/resolve-deploy-image.ts), migration,
CDC and rollout gates remain in force. The older `e19b92001` image is historical
evidence, not the image for the changed runtime. No independent broker-only
deployment, custom plugin, fallback mode or new release flag is introduced.

## Canonical configuration

[`../stack.yml`](../stack.yml) pins Kafka 4.4.0 and upstream Aiven 1.2.0.
The [checksum manifest](plugin-sha256.txt) covers every file extracted from the
core and S3 release archives. Their verified archive SHA256 values are:

| Archive | SHA256 |
| --- | --- |
| core-1.2.0.tgz | `14fb636d3a5c781ae9ae961012bf7b0881b09629859dbc784dc49356faeaa747` |
| s3-1.2.0.tgz | `1fd89dea84988b857e546fcfa88504f5b4e45d7712e3eddeb506f11a394ef010` |

See the [upstream release](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/releases/tag/v1.2.0)
and [earlier provenance](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-ts-lab-20261106/plugin-provenance.json).
Deployment runs stock `sha256sum --check --strict` before the stack apply,
rather than accepting an empty plugin directory.

The existing renderer supplies broker and worker from the same cluster ID and
five `KAFKA_TIERED_STORAGE_*` settings. The worker requires R2 region `auto`;
the renderer rejects other values before writing deployment environments.
Keep credentials in the existing private CI env-file flow; never expand them
into service-update arguments or logs. Docker documents [env-file inputs](https://docs.docker.com/reference/compose-file/services/#env_file).

The same [deploy-owned topic policy](topic-policy.json) now enables remote storage
on all six existing source/quarantine topics. Source retention remains seven
days/4 GiB, quarantine seven days/1 GiB, and segments 128 MiB. No second policy
loop is added. Kafka requires both broker and topic tiering configuration; see
[tiered storage](https://kafka.apache.org/44/operations/tiered-storage/).

No new production local-retention cap is selected here. Unspecified local limits
inherit global limits, so enabling tiering alone does not promise immediate disk
savings. A smaller local target needs a separately reviewed capacity decision;
preserve the existing 20 GiB reserve. Retention targets are not hard disk caps;
see [topic configuration](https://kafka.apache.org/44/configuration/topic-configs/).

## Review before a production release

Bind these checks to one image and release window before activation approval:

1. Fresh metadata for six existing topic identities, offsets, assignments,
   consumer/archive progress, effective policy and available disk/RAM. Do not
   read historical health payloads or download archives for this check.
2. Existing `/mnt/dofek-data/kafka-broker/data`, original Redpanda and aborted
   Kafka roots, plus the complete pinned plugin installation. The workflow
   validates these paths; it never creates an empty retired-root substitute.
3. Names-only secret prerequisites and the intended R2 bucket, endpoint, region,
   prefix and credential scope, inspected privately. No credential edit or cloud
   write is authorized by this source review.
4. Exact image/source, migration effects and actual service contracts from the
   shared release. All current applications and Connect use `REDPANDA_BROKERS`;
   preserve their routes and groups.
5. Approved writer/ingress pause, single-broker restart interruption, observation
   interval, named operator and stop/preserve/forward-recovery boundary.
   Starting workers or consumers can write queued/quarantine records; do not
   release them before the approved first-write boundary.

## Existing deployment sequence

Use the canonical [stack workflow](../../.github/workflows/deploy-web-stack.yml),
with its existing maintenance/quiescence and image/source gates. Review the
whole application release; do not bypass gates with manual service updates.

- Before stack changes, verify the data filesystem, all required roots, pinned
  plugin checksums, Kafka API and the existing six topic routes.
- Apply the canonical dependency stack with processing quiesced. Kafka restarts
  against the same data directory with broker tiering enabled. External operator
  JVMs stay outside its 2 GiB cgroup.
- Before migrations, compare the running broker's generated `server.properties`
  and credential environment with the worker's actual service template and
  intended env file. Missing or mismatched evidence fails without printing
  values. Admin redacts RSM backend settings and cannot supply this comparison;
  see [configuration inspection](https://kafka.apache.org/44/operations/basic-kafka-operations/#checking-configurations).
- Continue existing migration/CDC gates and requested-image rollout; repeat
  consumed-backend verification. The worker uses the native local/RLMM/S3
  erasure guard, including both retained-root holds.
- Incrementally reconcile the canonical policy onto all six existing topics,
  read it back before consumer restoration, and repeat after startup. Preserve
  native topic identities and unrelated overrides. The
  [policy runbook](quarantine-config-correction.md) describes the stock operation.

The backend comparison is a deployment invariant, not a persisted attestation
or a live-configuration API. Out-of-band broker/worker edits invalidate that
invariant and are prohibited by the [deployment instructions](../README.md).

## Qualification, recovery and limits

The [existing-broker transition evidence](../../docs/evidence/kafka-tiered-transition-20261109/README.md)
distinguishes workspace/native tests from historical packaged-image evidence.
Production backend scope, capacity and the exact post-merge image remain release
checks; a local S3 fixture does not certify R2 or a production rollout.

**Activation blocker:** remote reads populate disk index-cache files that remained
after terminal remote deletion in the local transition. The verifier correctly
holds completion. The stock default cache has no qualified bounded cleanup
policy here; preserve that guard and qualify a stock cache-cleanup policy before
activation. Removing only the stopped synthetic fixture's cache tests the
positive verifier branch, not automatic cleanup. See the pinned
[Kafka cache implementation](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/storage/internals/log/RemoteIndexCache.java)
and the [local observation](../../docs/evidence/kafka-tiered-transition-20261109/README.md).

If a release gate fails, keep affected writers/consumers stopped, preserve data,
capture fatal evidence and use the approved forward-recovery scope. Do not turn
tiering off, reset offsets, recreate topics, acknowledge records, switch back
to Redpanda or improvise archive replay. Kafka documents separate
[remote copy/deletion controls](https://kafka.apache.org/44/operations/tiered-storage/);
an image rollback is not a remote-data recovery procedure.

Both retained roots block final account-erasure completion while nonempty.
Any erasure-branch combination must preserve all six structural generation
checkpoints. Old-data retirement remains separately approved.

The user accepted an earlier unknown-outcome PUT completing after deletion/final
verification, including an indefinitely retained orphan. This does not waive
native terminal history, complete object/multipart enumeration, local/cache
removal, generation or retained-root checks. No custom fence or plugin fork is
selected. [R2 documents the ordering](https://developers.cloudflare.com/r2/reference/consistency/#negative-reads-and-in-flight-writes).
