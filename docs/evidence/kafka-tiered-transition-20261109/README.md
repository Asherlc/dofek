# Existing Kafka to stock tiering — November 9, 2026

Local synthetic qualification only. No production, R2, secret, topic or offset
was changed. [transition.json](transition.json) contains timestamped native
identities, offsets, payload digests and actual retention-phase observations.
[policy.json](policy.json) records execution of the canonical deployment
reconciler and native six-topic readback. [backend.json](backend.json) describes
the exact consumed broker inputs compared and the worker-fixture limitation.
[source.json](source.json) binds these observations to source file hashes.

## Method and results

The isolated Compose project was `kafka-tiered-storage-tieredreview1109`, operated
through `pnpm compose -- --project-suffix tieredreview1109 -f <fixture.yml>`.
It used the pinned Kafka 4.4.0 and Aiven 1.2.0 artifacts from the
[canonical stack](../../../deploy/stack.yml), a new host log directory and a
synthetic SeaweedFS S3 backend. Kafka retained its 2 GiB container/1 GiB heap.
Only this fixture used host listeners, 1 MiB segments, one offsets partition,
and a one-byte local retention target to exercise eviction with little data.
Production retention targets were not selected or changed by the experiment.

1. Start with broker and all six source/quarantine topics remote-disabled.
   Seed 200 deterministic 8 KiB records per topic and capture native cluster
   and topic IDs plus low/high offsets.
2. Restart the same broker/data directory with stock tiering enabled. Confirm
   every identity and offset is unchanged before enabling topic remote storage;
   add another 200 records per topic to roll the original segments.
3. Observe native local eviction and file deletion. The first five-minute
   observation window ended before the default retention/file-delete cycle
   completed; a subsequent check confirmed the original local files absent.
   No broker cleanup interval or runtime timeout was increased. A fresh consumer
   read the original 200 records remotely and matched their SHA-256 digest;
   another fresh consumer matched it after broker restart.
4. Run the actual workflow's stock `kafka-configs.sh --alter --add-config` loop
   on the six existing topics. Native readback verified every selected value
   and `TOPIC_CONFIG` source, including remote storage enabled. This operation
   preserved unrelated local-retention overrides. Kafka documents
   [incremental topic configuration](https://kafka.apache.org/44/operations/basic-kafka-operations/#adding-and-removing-topic-configurations).
5. Invoke the current workspace's real
   `createAccountErasurePhaseRunner(...).runPhase('retention_verification', ...)`
   with real broker/quarantine, native local/history/cache and S3 verifiers.
   Backup, processor and PeerDB checks alone were stubbed. The history consumer
   read native metadata from its beginning through a captured cut; no broker
   log message or low offset substituted for deletion history.

## Cache limitation and positive-branch attribution

After deleting records below offset 200, terminal native remote deletion
completed but six disk index-cache files from the remote read remained.
The real phase rejected them with `Kafka retains covered or unknown remote index
cache files` throughout the five-minute observation window. That is correct
fail-closed behavior, not a positive erasure result.

The operator then stopped only this synthetic broker, removed exactly those
six fixture cache files, and restarted it. The actual phase passed afterward.
This establishes its positive branch; it does **not** establish automatic cache
cleanup, authorize production cache deletion, or supply a production procedure.
A qualified stock cache-cleanup policy is an activation blocker. Preserve the
guard. The pinned [Kafka cache source](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/storage/internals/log/RemoteIndexCache.java)
is the relevant implementation for further qualification.

From that isolated positive state, a covered orphan object and an open multipart
upload each blocked the actual phase. Removing/aborting each produced a recorded
fresh phase pass. Each distinct retained root then blocked completion with an
injected file; removal produced a fresh phase pass for that same root. Paths and
both recoveries are explicit in the receipt. These fixture removals are test
operations, not production cleanup instructions.

## Evidence limits and release hold

This tests current workspace modules, not a newly built immutable application
image or a fully booted worker service. The actual broker's generated properties
and credential environment matched the synthetic expected worker environment
using the canonical workflow comparison; no running application worker template
was available in Compose. Unit tests separately cover matching and drifted
broker/worker service fixtures. No secret values are retained in these receipts.

The [release-readiness observation](release-readiness.json) records GitHub's
automatic deployment hold (`disabled_manually`), queried through its
[workflow API](https://docs.github.com/en/rest/actions/workflows#get-a-workflow).
The hold was not changed. Source merge and production activation remain separate;
the [phase-2 packet](../../../deploy/kafka/tiered-cutover-packet.md) lists fresh
production identities, actual backend/credential scope, measured headroom,
writer/consumer pause, forward recovery, exact release-image qualification,
cache cleanup and retained-data retirement gates. Local S3 does not qualify R2.
