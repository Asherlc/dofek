# Tiered-storage release gates

**Review only. This packet does not authorize production actions.** This branch
depends on [broker migration PR #3233](https://github.com/Asherlc/dofek/pull/3233).
The [parent packet](cutover-packet.md) preserves current image contracts and
broker transition evidence; it is not sufficient to deploy this tiered layer.

## Effective candidate

- Stock Kafka 4.4.0 and upstream Aiven 1.2.0, with the previously qualified core
  and S3 [artifact provenance](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-ts-lab-20261106/plugin-provenance.json).
- Remote storage enabled in the canonical stack; plugin path
  `/plugins/1.2.0/core/*:/plugins/1.2.0/s3/*`. Existing installed plugins must be
  verified, not silently replaced or accepted from partial directories.
- One fresh broker source `/mnt/dofek-data/kafka-broker/data`, read-only in the
  worker at `/var/lib/dofek/kafka-data`. No data move between source layers.
- Existing five dedicated Kafka R2 inputs, separate from JSONL archive inputs.
  Prefix is derived as `<KAFKA_CLUSTER_ID>/` by the same existing renderer that
  supplies both processes. Region is `auto`; missing inputs fail immediately.
- The changed worker uses the existing retention phase and six structural
  checkpoint fields. Both original Redpanda and aborted Kafka roots remain
  mounted read-only and hold completion while any entry remains.

See [Kafka tiering](https://kafka.apache.org/44/operations/tiered-storage/),
[Aiven key generation](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/ObjectKeyFactory.java)
and [S3/R2 API support](https://developers.cloudflare.com/r2/api/s3/api/).

## Required before an activation proposal

1. Use the [child qualification receipt](../../docs/evidence/kafka-tiered-child-20261108/README.md):
   worker source `e19b9200196c698e1d159597fc359d384d3a9a8e`, immutable image
   `ghcr.io/asherlc/dofek@sha256:a0d8861a791fec7d043237b44158f38c57b35c17f79e0bcd1a3cf1a021f2979c`.
   Its actual retention phase and remote-only read passed in the isolated native
   fixture. The old hot-log image is historical. Complete CI for the actual head;
   test/docs-only follow-ups do not require rebuilding identical runtime source.
2. Verify the effective broker/worker endpoint, bucket, prefix and credential
   scope using existing secret-safe tooling. Kafka Admin redacts RSM inputs;
   terminal metadata alone does not establish that both processes inspect the
   same backend. No new credential/store edits are made by this offline work.
3. Local cleanup, native history across all 50 partitions, full object/multipart
   listing, remote-only reads and broker restart passed in the child fixture.
   Synthetic orphan/MPU/retired-root entries held the actual phase. This is local
   S3-compatible evidence, not an R2-cloud or power-loss test. Preserve fail-closed
   behavior for incomplete legacy checkpoints and unsupported layouts.
4. Resolve actual retention/local-cache policy and measured capacity/headroom.
   Offload failure can grow local usage beyond local retention targets; RF1 and
   asynchronous upload do not guarantee survival of irreversible only-disk loss.
   Qualify native metadata-history size/read time against the existing reader's
   64-MiB/100,000-segment/30-second envelope; exceeding it holds completion rather
   than accepting a partial history. No production measurement is implied here.
5. Review old-data disposition separately. Original RP and aborted Kafka bytes
   are not assumed empty, excluded, moved or deleted. Their holds must remain
   until a separately approved retirement action satisfies the reviewed scope.
6. Preserve each current application/Connect image's `REDPANDA_BROKERS`, the
   repaired history image's `KAFKA_BROKERS` and source/image pin, existing archive
   identity and ClickHouse 26.6. No unrelated migrations or erasure redesign.
7. Coordinate both PRs' merge/deploy order. Main CI can deploy the local-only
   parent configuration; it must not run after tiered activation and turn remote
   storage off. Splitting the source does not select a standalone hot-only stage
   or authorize disabling/changing automation. Produce one stock release sequence
   before asking for production approval.
8. Coordinate PR #3234's scrub projection: preserve both UUID fields and the
   existing broker dependency rather than copying entire erasure runtime files.

## Accepted residual

An earlier unknown-outcome remote PUT may commit after deletion and final
verification, leaving an orphan indefinitely. The user accepted that specific
residual. Normal deletion/namespace/object/multipart/local/retired-data gates
remain required. [R2 documents this ordering](https://developers.cloudflare.com/r2/reference/consistency/#negative-reads-and-in-flight-writes).
No new fencing protocol, permanent empty objects, manual acknowledgement or
plugin fork is selected. Manual orphan cleanup is a separately reviewed action;
object keys are structural, not an index of user identities.
