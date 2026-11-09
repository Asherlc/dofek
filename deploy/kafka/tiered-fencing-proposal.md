# Tiered-storage deletion fencing proposal

Status: **Historical, unselected custom-plugin proposal; not implemented.**
The user later selected stock upstream Aiven and split tiering into
[PR #3236](https://github.com/Asherlc/dofek/pull/3236). See the
[current release sequence](README.md); phase 1 is already live on Kafka.
On November 8 the user accepted the specific unknown-outcome upload risk below.
The earlier adoption objection and hot-log-only alternative were superseded by
the explicit Kafka-first, tiering-second release order. The custom fencing patch
was not selected under that order.

## Accepted exception and intended stock path

After the concrete scenario was explained, the user said: “This seems niche
enough that I’m ok with the risk.” This accepts an earlier unknown-outcome remote
upload committing after deletion and the final erasure check. It does not waive
ordinary deletion, complete object/multipart checks, local file removal,
generation binding, retained Redpanda checks, or other account-erasure gates.
R2 explicitly permits this [in-flight-write ordering](https://developers.cloudflare.com/r2/reference/consistency/#negative-reads-and-in-flight-writes).
Its frequency has not been established and no such production incident was
observed here. Do not describe observed absence as a guarantee against this
accepted late commit.
The user subsequently clarified “Fine by me” after being told such an orphan
could persist indefinitely. Neither that accepted exception nor the historical
stock-path recommendation below overrides the later rejection of Aiven.

The preceding recommendation was to keep the stock plugin and qualify native terminal deletion plus complete
generation-scoped object/multipart enumeration and local/retired-data checks
through the existing worker retention hook. Stock Aiven already includes
[failed-copy orphan cleanup](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/pull/590).
Do not require permanent empty objects, conditional-only uploads or a plugin
fork. This decision authorizes offline candidate work, not activation, cloud
experiments, credentials, data removal, merge or deployment.

The remaining sections preserve the unselected stronger protocol for reference.

## Historical proposal and stronger finality requirement

Keep Kafka stock. Qualify a narrow change to the pinned Aiven S3 module instead
of weakening account erasure, adding whole-broker shutdown machinery, or holding
all future erasures permanently after an ambiguous copy failure.

Stock native metadata and object enumeration are useful, but do not prevent an
earlier unknown-outcome upload from committing after deletion. R2 explicitly
documents that [negative reads do not settle in-flight writes](https://developers.cloudflare.com/r2/reference/consistency/#negative-reads-and-in-flight-writes).
The existing contract also says late work must not recreate data; see the
[erasure runbook](../../docs/account-erasure-runbook.md#phase-ordering).
No existing supported stock deletion-finality mechanism was established in the
review. The proposed plugin change supplies that missing capability without a
new registry, coordinator, manual acknowledgement or certificate system.

### Minimal protocol

1. Every segment `.log`, `.indexes` and `.rsm-manifest` upload is a **single**
   `PutObject` with `If-None-Match: *`, including every SDK retry.
2. Native deletion overwrites **all three deterministic keys** with unconditional
   zero-byte PUTs, even when the original upload never succeeded. It returns
   success only after every empty PUT is acknowledged; failures propagate.
3. These empty objects are permanent fences. Never physically delete or expire
   them, reuse their keys, change the prefix, or allow an incompatible writer.

R2 evaluates conditional writes atomically at commit time. An earlier payload
upload therefore either commits before the empty overwrite and is erased, or
encounters the fence and cannot commit. A delayed/retried empty PUT preserves
that state. This argument relies on [R2's documented conditional-write contract](https://developers.cloudflare.com/r2/reference/consistency/#conditional-writes),
not on an invented upper bound for upload delays.

Ordinary SDK retries remain enabled. A lost success response followed by 412
can fail the copy, trigger cleanup, and let native Kafka retry with a fresh
attempt UUID. Do not reinterpret 412 as success. The proposed patch makes the
existing [Kafka delete-finished transition](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/server/log/remote/storage/RemoteLogManager.java)
mean that the old attempt is fenced, including failed/interrupted attempts.
Native expiration retries incomplete cleanup after storage recovery.

## Mandatory invariants

- **Durable admission from the first generation:** preserve native copy-start
  publication before any remote request and intact metadata history. Effective
  `flush.messages=1` on `__remote_log_metadata` is required before the first
  tiered topic. This relies on storage honoring synchronous flush; process-kill
  tests do not establish a power-loss guarantee. See the [native publication](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/server/log/remote/metadata/storage/TopicBasedRemoteLogMetadataManager.java)
  and [append/flush paths](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/storage/internals/log/UnifiedLog.java).
- **Fresh, compatible generations only:** no prior unconditional PUT or multipart
  writer may target the namespace. Existing lab generations are not retroactively
  qualified. Pin the [deterministic key layout](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/ObjectKeyFactory.java)
  and prefix; prohibit custom key overrides. Missing history, metadata-topic
  recreation or volume rollback invalidates the proof, even if low offsets are 0.
- **Multipart must be impossible in code:** reject an oversized object before
  any multipart initiation; do not rely on part-size configuration. Aiven starts
  multipart at equality, and transformed log/index/manifest sizes are not bounded
  by `segment.bytes` alone. Rejected streams must not commit a truncated payload
  when close runs. See the [upload stream](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/storage/s3/src/main/java/io/aiven/kafka/tieredstorage/storage/s3/S3UploadOutputStream.java).
- **Proven size/memory envelope:** bound actual objects, buffers, copier concurrency
  and other memory within the existing 1 GiB heap/2 GiB broker cgroup. Start
  qualification with default compression/encryption disabled and measure every
  object class; do not select production segment/buffer values from a guess.
- **Fence preservation:** no object-expiry lifecycle, operator deletion or old
  writer may remove/bypass fences. Lifecycle drift and missing markers fail the
  gate. Existing multipart-abort policy is a separate resource; it must not be
  replaced with object expiration. Retain managed R2 resources and old data.

## Narrow implementation boundary after approval

The plugin changes belong in Aiven's [S3 upload stream](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/storage/s3/src/main/java/io/aiven/kafka/tieredstorage/storage/s3/S3UploadOutputStream.java)
and [storage delete methods](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/storage/s3/src/main/java/io/aiven/kafka/tieredstorage/storage/s3/S3Storage.java).
Use an auditable pinned patch/upstream contribution, not a new broker fork,
transport, runtime toggle or evidence service. Publishing upstream is not
authorized by approval to develop/qualify locally.

Keep the existing `retention_verification → assertBrokerStorageExpired` call,
structural generation checkpoints and scrub. Extend its adapter to:

1. Verify native identities, logical expiry and covered local-file removal, then
   consume an appropriately bounded native-history cut. Preserve the copy
   admission ordering when closing this scan race.
2. Require terminal deletion for every covered attempt, including failed copies.
   `COPY_FINISHED` is not mandatory once failed copies can be fenced.
3. **Positively verify all three expected fence objects exist and have zero
   payload bytes for each covered terminal attempt. Absence is a failure.**
4. Fully paginate generation-scoped objects/multipart uploads, reject covered
   nonzero data, unexplained entries, missing history, failed reads or generation
   drift; preserve the original Redpanda-root hold and local checks.

Use the stock metadata formatter/decoder as the qualification reference before
choosing runtime packaging or maintaining a new binary decoder. Remote-index
cache scope stays unchanged unless explicitly revised; native cache eviction
must be qualified rather than assuming only partition stop removes files.
Combining PR #3234 must preserve the broker hook and all six structural fields;
it must not duplicate the verifier or import unrelated erasure redesign.

## One bounded offline qualification

Use synthetic records and the actual pinned broker/plugin plus a local S3
endpoint with controllable request ordering. Limit it to six topics, a few closed
segments per topic, a fixed wall-clock/data budget and owned disposable resources.
Do not change stock cleanup intervals to get a passing result.

| Case | Required outcome |
|---|---|
| Normal copy, remote fetch, restart and expiry | Record digest preserved; actual retention path blocks until covered local data is gone and every expected empty fence is present |
| Payload PUT held until after cleanup | Releasing it cannot restore payload; every expected key remains zero-byte |
| Lost successful response with ordinary SDK retries | Retry remains conditional; 412 fails the copy, cleanup fences it and a fresh-UUID copy can succeed |
| Crash after durable admission or during each cleanup PUT | Native recovery eventually fences the old attempt after service recovery; no premature completion |
| Equality/oversize and transformed-object boundaries | No multipart call; no truncated successful upload; qualified object sizes fit the cgroup |
| Missing fence, orphan, unknown key, truncated/recreated metadata or retained RP data | Actual worker path fails closed |
| Storage outage and recovery | No loss of unoffloaded acknowledged data; growth and write-failure behavior measured, not inferred from retention caps |

Any late payload at a fenced key, payload request missing its condition, multipart
initiation, or success with an unfenced covered attempt falsifies the candidate.
Verify durable admission ordering separately. A hard power-off experiment must
use a separately approved disposable VM, never the shared Docker VM.

A local fixture can falsify implementation errors, not independently prove R2's
service contract. Any later R2-specific test requires separate explicit approval;
no cloud experiment, production read/write, credential change or data removal is
authorized here.

## Historical patch costs and release gates

This section describes the unselected patch, not a current approval request.
That proposal would have required approval for maintaining/pinning a plugin patch and retaining permanent
empty structural objects. Their native history and listing costs grow; measure
that overhead. Oversize rejection can stall offload and grow local storage, so
observability and a qualified object envelope are required.

The protocol replaces permanent ambiguity holds with recoverable native cleanup,
but does not promise the 30-day deadline through an arbitrarily long outage.
State the supported recovery budget. RF1 and asynchronous offload still do not
provide zero-RPO survival of irreversible loss of the only local disk. Local
retention is not a hard disk ceiling during offload failure; any hard storage
boundary requires accepting write unavailability, not dropping uncopied data.
No quota, new infrastructure, retention value or deployment is selected here.

No plugin-patch approval is currently requested. The selected stock Aiven work
and its qualification belong to PR #3236; this historical protocol is not its
implementation or release authorization.
