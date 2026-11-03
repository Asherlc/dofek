# Single-server Pulsar qualification — 2026-11-03

**Decision: blocked before application migration or production deployment.**
The isolated topology works on ARM64, but the bundled offloader did not pass
actual Cloudflare R2 uploads, and the proposed whole-host memory budget does not
fit the current service ceilings. This is evidence for Task 1 of the
[approved plan](superpowers/plans/2026-11-03-single-server-pulsar.md), not a
production certification or a completed resync. No production producer, sink,
retention, filesystem feature, or resource limit was changed.

## Acceptance results

| Gate | Result | Evidence / limit |
| --- | --- | --- |
| ARM64 images and Node native client | PASS | Pulsar 5.0.1, Oxia 0.18.0, official pulsar-client 1.18.0 on Node 26.13.0 / Alpine ARM64. |
| Persistent metadata / native transport | PASS, bounded fixture | Separate Oxia namespaces; 100 unacknowledged records survived abrupt termination and restart of all four processes. |
| S3 offload and local-ledger GC | PASS against local S3 only | 100 records read back after native GC removed the local BookKeeper ledger metadata. This does not certify R2. |
| Matched restore | PASS, stopped synthetic snapshot | 10,000 offloaded records restored in another Compose project/network, identical payload digest. |
| Mismatched metadata restore | PASS, refusal | Bookie refused a disk cookie whose instance ID differed from the metadata store. |
| Logical backlog quota | PASS as an eventual control | A new producer was rejected immediately; an existing producer sent 2,503 further 100-byte messages over 34,401 ms before rejection. Not a physical disk bound. |
| ext4 project quota enforcement | PASS in disposable host-kernel filesystem | Unprivileged writer hit EDQUOT at an 8 MiB directory budget while filesystem use was 8%. Root capability bypass was observed. |
| Production filesystem enablement | NOT QUALIFIED | Production ext4 has neither quota nor project features; maintenance, recoverable backups and enablement procedure remain prerequisites. |
| Bookie memory | 512 MiB FAIL; 768 MiB fixture PASS | 512 MiB hit a cgroup OOM during 10,000 × 8 KiB publishing. At 768 MiB the same workload passed, cgroup peak 688,697,344 bytes. |
| Whole production host resource fit | FAIL at current ceilings | Proposed capped steady services total about 23.992 GiB on a 23.413 GiB host, before uncapped services and host reserve. |
| Native offload to actual R2 | FAIL in tested stock drivers | Generic S3/V4 cannot rewind the multipart stream; aws-s3 streaming signing receives R2 HTTP 501. |
| R2 outage/interrupted-upload and full BookKeeper disk-exhaustion soak | NOT QUALIFIED | No claim from the smaller restart, quota or failed-authentication tests substitutes for these exercises. |
| Combined ClickHouse peak / web workload soak | NOT QUALIFIED | No production resource allocation passed; local transport fixtures are insufficient. |

## Tested topology and versions

[The qualification overlay](../docker-compose.pulsar.yml) has no published host
ports. It runs one Pulsar broker, one BookKeeper bookie, one Oxia data server and
one Raft coordinator; quorum and replication factor are one. Both Oxia processes
persist their state. Bootstrap details and the fresh-only BookKeeper formatting
boundary are in [deploy/pulsar/README.md](../deploy/pulsar/README.md).
These responsibilities follow the [Pulsar metadata architecture](https://pulsar.apache.org/docs/5.0.x/administration-zk-bk/)
and [Oxia deployment model](https://oxia-db.github.io/docs/deployment/bare-metal).

| Artifact | Pinned version / digest |
| --- | --- |
| Pulsar image | `apachepulsar/pulsar:5.0.1@sha256:4507075d8c11b34629f3a0b41f48e3c659951e601538562ee0c088cd2c737ec0` |
| Oxia image | `oxia/oxia:0.18.0@sha256:65f9898d531c3ca48a3277247650200c8065435fd542ea9a81e51c37b90fff60` |
| Client | Official `pulsar-client` 1.18.0, including the published musl ARM64 native binding |
| Fixture runtime | `node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94` |

Both service image indexes contain ARM64 manifests. A complete isolated npm
install of the client also connected successfully; testing only an unpacked
binding would not establish package installation compatibility. Upstream sources:
[Pulsar releases](https://github.com/apache/pulsar/releases),
[Oxia releases](https://github.com/oxia-db/oxia/releases),
[Node client configuration](https://pulsar.apache.org/docs/client-libraries/node-configs/).

The measured local candidate uses broker 768 MiB, bookie 768 MiB, Oxia server
128 MiB and coordinator 128 MiB: 1.75 GiB total, excluding the one-shot initializer,
client and local S3 stand-in. Bookie heap/direct limits are 192/128 MiB with
32 MiB write/read caches; broker heap/direct limits are 256/192 MiB with a
32 MiB managed-ledger cache. These are fixture inputs, not certified production
values. BookKeeper documents its independent heap, direct-memory and storage
controls in its [configuration reference](https://bookkeeper.apache.org/docs/reference/config/).

## Transport, offload and restore evidence

The larger deterministic fixture published 10,000 messages, each an 8,192-byte
buffer filled with `index % 251`, with the first four bytes replaced by the
unsigned message index in big-endian order. Batching was disabled and sends
were awaited. Total payload: 81,920,000 bytes; concatenated payload SHA-256:

```text
e0e1c3e34d2d4df91abaa2ac251981dc2e1a2cdaec29910327adac30e22ed84e
```

At the 768 MiB bookie cap, publishing took 24,925 ms. Matched restore read and
acknowledged 10,000/10,000 offloaded messages in 11,706 ms with the same digest;
broker logs explicitly opened ledger 16 from the offload driver. The snapshots
included BookKeeper, Oxia server state, coordinator Raft state and the local
object store, all stopped consistently before capture. They were restored into
empty named volumes **before creating containers**, because the S3 image can
populate a volume during container creation. Stable bookie hostname and matching
absolute journal/ledger paths were preserved.

With the original bookie volume mounted read-only against different fresh
metadata, native startup exited 2 with `BookieException$InvalidCookieException`:
disk instance `a15df492-4002-4e65-a78c-53256ed38936` did not match metadata instance
`a2718e81-9eb7-4ac7-b9a3-35badea25b29`. Earlier attempts failed DNS/path checks and
were not counted as proof of instance mismatch. No populated metadata was forced
or reformatted. See [BookKeeper metadata and recovery tools](https://bookkeeper.apache.org/docs/reference/cli/).

This proves the tested consistent-snapshot boundary, not zero RPO, sole-disk-loss
survival, an online backup procedure or reconstruction from R2 objects alone.
[Pulsar's offload mechanism](https://pulsar.apache.org/docs/5.0.x/tiered-storage-overview/)
still depends on ledger metadata and does not offload the current open segment.

## Actual R2 failure and diagnosis

Terraform created private bucket `dofek-pulsar-qualification` through the existing
Cloudflare state: **2 resources added, 0 changed, 0 destroyed**, including its
synthetic-data lifecycle (seven-day object expiration, one-day incomplete
multipart expiration). No existing archive bucket was used as a test target.
These lifecycle actions follow [Cloudflare's documented rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).
Ordinary R2 storage/request charges can apply; see [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

The same existing credentials successfully ran AWS SDK `HeadBucket`,
`ListObjectsV2`, `CreateMultipartUpload` and `AbortMultipartUpload` against this
bucket. Thus the failed native test cannot be attributed simply to missing
multipart write permission. Credentials and provider payloads were not included
in committed evidence.

1. **Generic `S3`, default signing:** native offload of a sealed 10,000-message
   ledger failed multipart initiation with HTTP 401. jclouds' generic driver
   [defaults to Signature V2](https://github.com/apache/jclouds/blob/master/apis/s3/src/main/java/org/jclouds/s3/S3ApiMetadata.java).
2. **Generic `S3`, supported `jclouds.s3.signer-version=4`:** initiation passed,
   but the first part failed before successful upload at 19:52:20 UTC with
   `unable to reset unrepeatable payload stream after calculating AWS4 signature`,
   caused by `java.io.IOException: mark/reset not supported`.
   The [Pulsar 5.0.1 offloader](https://github.com/apache/pulsar/blob/v5.0.1/tiered-storage/jcloud/src/main/java/org/apache/bookkeeper/mledger/offload/jcloud/impl/BlobStoreManagedLedgerOffloader.java)
   supplies an input-stream payload, while the
   [jclouds header signer](https://github.com/apache/jclouds/blob/master/apis/s3/src/main/java/org/jclouds/s3/filters/Aws4SignerForAuthorizationHeader.java)
   hashes and then resets a non-repeatable stream.
3. **Bundled `aws-s3`, custom R2 endpoint and explicit S3-specific fields:**
   the 100-message fixture reached R2 multipart part upload, which returned
   **HTTP 501 `NotImplemented`: `STREAMING-AWS4-HMAC-SHA256-PAYLOAD not implemented`**.
   An initial AWS-driver configuration selected empty legacy S3 fields before
   the generic fields; that failed attempt was corrected and is not the claimed
   R2 compatibility result. The native driver uses its
   [AWS signing implementation](https://github.com/apache/jclouds/blob/master/providers/aws-s3/src/main/java/org/jclouds/aws/s3/filters/AWSRequestAuthorizeSignatureV4.java).

The sealed ledgers remained marked `offloaded: false`. Following the failed
uploads, local reads verified all 10,000/10,000 large-fixture messages in 4,330 ms
with the original digest, and 100/100 AWS-driver fixture messages. This establishes
retention in these failures, not remote durability. Actual R2 GC/readback,
interrupted-upload recovery and outage soak therefore remain unqualified.
No custom offloader, signer patch, retry increase or alternative storage service
was introduced. Local containers holding real credentials were stopped and
removed without deleting named volumes; the temporary credential file was removed.

## Host memory and storage gates

At 19:55 UTC, the production host reported 25,139,458,048 bytes RAM (23.413 GiB),
no swap, and about 15.35 GB available. Available idle RAM is not a peak bound.
Current desired capped services total 26.707 GiB. Removing Redpanda (1.465 GiB)
and three archive services (3 GiB), adding the 1.75 GiB Pulsar candidate, retiring
the legacy 300 MiB sink and restoring the held 300 MiB history sink yields
**23.992 GiB**, before uncapped Redis, collector, OTA, Traefik, host memory,
temporary clients and migration overlap. No ceiling was lowered to make this
calculation pass. Container limit semantics are documented by
[Docker](https://docs.docker.com/engine/containers/resource_constraints/).

The current capped allocation, aggregated from each service's inspected limit
times desired replicas, is:

| Service group | MiB |
| --- | ---: |
| ClickHouse | 13,312 |
| Postgres | 2,048 |
| PeerDB, catalog, flow API/worker/snapshot worker, MinIO/lifecycle, Temporal/admin tools | 4,304 |
| Web (two replicas) and worker | 1,512 |
| Analytics worker, CDC health, Databasus and reconciliation | 1,000 |
| Live and legacy ClickHouse sinks | 600 |
| Three R2 archives | 3,072 |
| Redpanda | 1,500 |
| **Total capped desired** | **27,348** |

Stopped optional services and the held history sink contribute zero to that
current total. Uncapped services and temporary operator containers are separate,
not assumed to consume zero. Lowering existing ceilings requires workload
measurements; this qualification did not change them.

The 512 MiB bookie experiment failed at 19:26:21 UTC with exit 137,
`OOMKilled=true` and kernel `CONSTRAINT_MEMCG`; this was a container limit,
not evidence of a production OOM. At 768 MiB, native memory tracking recorded
383,420 KiB committed JVM memory, with additional native/file-cache costs;
observed cgroup peak was 688,697,344 bytes. A smaller smoke test had passed at
512 MiB, demonstrating why it could not certify the larger workload.

Production `/dev/sdb` is a 150 GiB ext4 device mounted without project/quota
features. A private mount namespace and disposable 128 MiB loopback filesystem
on the root disk tested project ID 4242 with an 8 MiB hard limit. An unprivileged
writer received EDQUOT after 7 MiB of payload; root with `CAP_SYS_RESOURCE` bypassed
the quota. Runtime identity/capabilities are therefore part of enforcement.
All loopback files, mounts and extracted quota tools were removed afterward;
no production package, filesystem feature or mount option changed. The local
Docker kernel lacks quota support, so its failed mount was not counted as a
production-kernel test. See [ext4 quota features](https://man7.org/linux/man-pages/man5/ext4.5.html)
and [capability semantics](https://man7.org/linux/man-pages/man7/capabilities.7.html).

## Production safety and next decision

At 19:51:39 UTC public health was ok, web was 2/2, worker 1/1, history sink 0/0;
data free space was 10,049,093,632 bytes and root free space 13,096,763,392 bytes.
The three owned queue pauses and history-sink hold remain intentional. Live Apple
Motion intake continues independently; the read-only sample exposed event
metadata only. No bulk work may resume on the strength of local qualification.

The current Pulsar strategy is not abandoned, but Task 1 cannot pass. Further
application migration requires a reviewed stock or upstream-supported R2 upload
solution, a measured whole-host allocation with reserve and overlap capacity,
and a safe production physical-budget enablement/backup procedure. A custom
offloader or different storage backend would change the approved approach and
requires a separate decision. Tasks 2–7 have not started.

Conversion of **all existing R2 JSONL archives remains mandatory**. It must replay
original event bytes through Pulsar, preserve event IDs/versions, reconcile every
inventoried object and apply current erasure fences. Archive filenames contain
Kafka range boundaries, not a per-line offset; `firstOffset + lineIndex` must
never be invented. Native ledger objects and metadata must be created by the
broker. Original archives remain retained until separately reviewed retirement,
as specified in [Task 5](superpowers/plans/2026-11-03-single-server-pulsar.md#task-5-convert-all-existing-r2-archives-into-native-pulsar-storage).

The useful result is early rejection of two unsafe assumptions: idle RAM does not
prove resource fit, and a local S3 emulator does not prove R2 compatibility.
Future qualification should test actual object storage before application work,
and keep the four-hold restoration ledger in every incident handoff.

## Checkpoint validation

Compose merged-schema validation, Terraform 1.17.1 formatting/validation, lint
and root/server/web typechecks passed. SQLFluff retained its existing warnings
for four oversized SQL files; no limits were changed. No application source or
schema changed, so application test suites were not rerun for this configuration
and evidence checkpoint. The runtime fixture results above are the behavioral
qualification evidence; they do not convert the failed or untested gates to PASS.
