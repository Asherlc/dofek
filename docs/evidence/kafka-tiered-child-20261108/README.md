# Child tiered-storage qualification — November 8, 2026

Offline synthetic evidence for [PR #3236](https://github.com/Asherlc/dofek/pull/3236),
stacked on broker migration PR #3233. No production/cloud reads or mutations,
secret changes, archive downloads, old-data retirement or deployment occurred.

## Exact runtime and image

- Worker source: `e19b9200196c698e1d159597fc359d384d3a9a8e`.
- [Stock image build](https://github.com/Asherlc/dofek/actions/runs/42530141695).
- Immutable OCI index: `ghcr.io/asherlc/dofek@sha256:a0d8861a791fec7d043237b44158f38c57b35c17f79e0bcd1a3cf1a021f2979c`.
- Tested arm64 manifest: `sha256:214e63942f490163c58c7cf31cfecfa0e8a730e9fbe071d0f3fbb76d53c570d6`.
- OCI revision and image `SENTRY_RELEASE` matched that source. The receipt records
  SHA256 equality for seven runtime files between workspace and packaged image.
  Subsequent changes in this qualification commit affect tests/docs only.
- Kafka: pinned stock 4.4.0 image in the canonical stack, 1-GiB JVM heap and
  2-GiB container limit. Aiven upstream 1.2.0 core/S3 archive SHA256 respectively
  `14fb636d3a5c781ae9ae961012bf7b0881b09629859dbc784dc49356faeaa747` and
  `1fd89dea84988b857e546fcfa88504f5b4e45d7712e3eddeb506f11a394ef010`.
  These reuse the [qualified artifact provenance](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-ts-lab-20261106/plugin-provenance.json).

## Observed behavior

The owned Compose project `kafka-tiered-storage-tiered-proof` used six synthetic
source/quarantine topics, one partition and RF1. It ran stock SeaweedFS 4.48 as a
local S3 fixture, not Cloudflare R2. Broker environment came from the child stack;
only local listeners and synthetic backend inputs differed. Native cleanup,
file-delete and remote task intervals were unchanged. Synthetic topic segments
were 1 MiB and `local.retention.bytes=1` forced eviction for this test; that value
is **not** a production policy recommendation. Host-bound disposable broker data
and tmpfs JVM diagnostic logs avoided the shared Docker root's disk pressure.

[The chronological receipt](tiered-phase.json) preserves successful and premature
observations:

1. Seeded 3,600 synthetic records across six topics. Before the second logical
   expiry at offset 400, all 36 covered remote objects were visibly present.
2. The actual `retention_verification` phase held while native local bytes
   remained, including two premature read attempts. No longer runtime waits or
   altered cleanup settings were added. At 22:38:41 UTC the same phase passed
   after native cleanup, reading a complete captured cut of all 50 RLMM partitions
   and complete object/multipart listings.
3. With local `400.log` absent, a fresh consumer retrieved records 400–499 from
   remote storage and matched the expected payload SHA256
   `aad17bf9c4c43b807554e74eb897fa3aaa020d1519bc38283f2f3847c9abcc41`.
   After restarting only Kafka, another fresh client matched the same generation
   and digest. Retention passed again with populated native remote-index cache.
4. The immutable worker image ran as UID/GID 1000 with a 512-MiB limit, production
   Node preloads/strip-types flags, and read-only broker/retired roots. Its actual
   production retention phase and imported native/RLMM/S3 implementations passed,
   and its remote-only read matched the same digest. This did not invoke the
   migration launcher, start HTTP, boot every worker queue or run a whole erasure.
5. Through the same actual phase, a synthetic covered orphan object, unfinished
   MPU, file in the original-RP fixture root, and file in the aborted-Kafka fixture
   root each blocked completion. Removing only those owned synthetic artifacts
   restored success.

The temporary fixture injected only unrelated backup, processor and PeerDB gates
as successful stubs. Their `verified` fields in the raw receipt do **not** qualify
those systems. Replay/quarantine, broker storage, native history, listings and
retention-phase integration were real. Production constructor dependency wiring
is additionally covered by focused runtime tests; the fixture supplied synthetic
topics/backend directly rather than exporting production secrets.

## Configuration boundary and limits

[Configuration comparison](configuration.json) checked all 29 canonical broker
environment keys, the three explicit local-listener overrides, 30 actual generated
server properties, and canonical renderer broker/worker endpoint, bucket, region,
credential and derived-prefix equality. It used synthetic inputs only. Production
consumed configuration/credential scope still needs secret-safe release checking;
Admin redaction does not establish backend equality.

This qualifies native lifecycle/remote retrieval on the specified local fixture.
It does not prove R2-cloud behavior, power-loss durability, storage performance,
production capacity, archive restore, forensic overwrite or survival of RF1 disk
loss. The separately accepted late unknown-outcome upload/indefinite-orphan risk
remains; [R2 documents that ordering](https://developers.cloudflare.com/r2/reference/consistency/#negative-reads-and-in-flight-writes).
The [release packet](../../../deploy/kafka/tiered-cutover-packet.md) retains policy,
capacity, old-data, scrub-combination and two-PR release-sequencing gates.

The owned fixture is removed with the workspace Compose wrapper and
`down --remove-orphans --volumes`; other workspaces' resources are preserved.
Temporary scripts and full diagnostic logs remain under `/tmp/kafka-tiered-child`
on the operator workstation; they are not a new maintained CLI or release path.

## Integration/packet follow-up

After the main synchronization, all seven receipt runtime files remained
unchanged; the merged checkout also includes main's separate history/sample-
identity repair outside those files. This does not change the image's revision.
Parent 134-test and child 232-test focused unit checks, plus all three
package typechecks, passed. Merged-head CI remains separate from the green
[97-job pre-sync CI](https://github.com/Asherlc/dofek/actions/runs/42532677882).

The canonical packet's eight shell blocks passed Bash syntax checks. A temporary
fixture intercepted only its broker/worker Docker commands, compared all 29
canonical broker settings and both backend/prefix contracts, checked read-only
mounts/entrypoint, and preserved a synthetic credential containing dollar/quote
characters literally. It made no Docker-engine call and is not deployment proof.
No maintained parser, validator or operational tool was added.
