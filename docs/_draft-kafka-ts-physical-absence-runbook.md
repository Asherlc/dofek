# DRAFT — Kafka TS physical absence (Root review; NOT operational)

**Status:** incomplete / **non-operational**. Do not ship as runbook and do not
treat `stock_physical_maintenance_ack` for Kafka-TS bytes as justified by this
draft until native retention → remote Delete → `ListObjectsV2` empty is proven
end-to-end on a real broker+R2 inventory (Q-DEL or equivalent). No new ack
schema/SQL/protocol.

Input gap **closed in code** at `e3761a714a096f92ceb49153a971564cefd20560`
(`ingest_fence.highWatermarks` four-field projection through scrub). That does
**not** make this draft operational.

Reuses existing `stock_physical_maintenance_ack` (no new schema/SQL/ack kind).
JSONL R2 archive erasure remains a separate path.

Citations:
- Aiven RSM v1.2.0 `ObjectKeyFactory` + `rsm.config.key.prefix` —
  https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/ObjectKeyFactory.java
  https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/docs/configs.rst
- `RemoteLogSegmentMetadata` start/end inclusive; states include
  `DELETE_SEGMENT_STARTED` / `DELETE_SEGMENT_FINISHED` —
  https://kafka.apache.org/44/javadoc/org/apache/kafka/server/log/remote/storage/RemoteLogSegmentMetadata.html
- Stock metadata decode: `kafka-dump-log.sh --remote-log-metadata-decoder`
  ([KIP-1057](https://cwiki.apache.org/confluence/spaces/KAFKA/pages/311626460/KIP-1057+Add+remote+log+metadata+flag+to+the+dump+log+tool))
- Kafka high watermark = next offset (exclusive upper bound for consumed range;
  empty log → 0) — [Kafka protocol / consumer docs on high watermark](https://kafka.apache.org/documentation/#intro_consumers)
- Quarantine topic suffix `.quarantine.v1` — `metricStreamQuarantineTopic()` in
  `src/metric-stream/kafka-quarantine.ts`
- Cloudflare R2: no object versioning; `ListObjectsV2` only —
  https://developers.cloudflare.com/r2/api/s3/api/

## Local RO validation (2026-11-07; no cloud alloc/download/delete)

Validated against existing git evidence + stock `apache/kafka:4.4.0` image
entrypoint help only. No live broker attach, no R2 session, no Delete/MPU.

| Claim | Result | Evidence |
|-------|--------|----------|
| Aiven key layout `{prefix}{topic}-{topicId}/{partition}/{startOffset:020d}-{segmentUuid}.{log\|indexes\|rsm-manifest}` | **PASS** | `ObjectKeyFactory.java` v1.2.0; Phase F `CLEANUP_REQUEST.json` `expected_object_keys` + `ROOT_CLOUD_CLEANUP.json` `before[]` exact match |
| `topicId` / `segmentUuid` string form | **PASS (wording fix)** | Kafka `Uuid` base64url (22 chars, no dashes), e.g. `qssvVphqSKmVcbl9m6d3Fw` ↔ UUID `aacb2f56-986a-48a9-9571-b97d9ba77717`. Do **not** dash-format for key mapping |
| `kafka-dump-log.sh --remote-log-metadata-decoder` flag exists on stock 4.4.0 | **PASS (binary)** | `docker run --rm --entrypoint … apache/kafka:4.4.0 kafka-dump-log.sh --help` |
| Execute dump on real RLMM `*.log` (all partitions/rolls) | **GAP** | No `__remote_log_metadata*` files retained under `docs/evidence/**` or local `/tmp` labs |
| TopicId via `kafka-topics.sh --describe` | **GAP** | Phase F recorded TopicId from RSM metadata / CORE_PROOF only; no `--describe` artifact |
| `kafka-log-dirs.sh` / local segment inventory commands | **PARTIAL** | Local dir listings exist (`local-segments-*.txt`); no `kafka-log-dirs.sh` stdout captured |
| `kafka-configs.sh --describe` retention/remote flags | **PARTIAL** | Configs appear in broker create log (`remote.storage.enable`, `retention.ms`, `local.retention.ms`); no stock configs-tool artifact |
| HWM exclusive vs inclusive segment endOffset | **PASS (semantics)** | Phase F: `startOffset=0`, `endOffset=63` inclusive; active local `…00064.log` ⇒ next offset 64 |
| Main + quarantine dual inventory | **GAP** | Labs used single lab topics only; no `.quarantine.v1` path exercised |
| Native RLM retention → `DELETE_SEGMENT_FINISHED` → R2 empty | **FAIL / absent** | Phase F `not_claimed` includes `RSM_DeleteObjects_physical_GC` / `plugin_Delete_GC`; cleanup was **manual** parent `DeleteObjects` + CF bucket DELETE (`ROOT_CLOUD_CLEANUP.json` `manualCleanup: true`). Zero `DELETE_SEGMENT_*` lines in sanitized upload/copy logs |
| Measured bound windows (copy lag, delete lag, ≤30d fence→absence) | **GAP** | Not measured; draft correctly fail-closed |
| `ListObjectsV2` / list-MPU against live R2 | **GAP (historical only)** | Host has no `aws` CLI; live buckets deleted. Historical list proof only for **presence then manual wipe**, not native GC |
| `stock_physical_maintenance_ack` schema | **PASS (unchanged)** | Draft step 7 still points at existing SQL path / fields (`kind`, `runId`, `operator`, `verifiedAt`, `verifiedCutoffAt`, `runbookRevision`) — no new protocol |

## Non-claims

- Quarantine HWM alone cannot prove **main** log Kafka-TS absence.
- Timestamp fence alone, log-start alone, or `DELETE_SEGMENT_STARTED` alone ≠
  physical absence of bytes.
- Empty live RLMM segment set after purge/compaction is **not** a vacuous pass —
  R2 key inventory must still cover historically mapped segments.
- Do not manually `DeleteObject` / abort **active** broker MPUs to fake GC.
  Phase F manual wipe is **not** a pass for this runbook.
- Do not require `ListObjectVersions` / B2 version rituals on R2.

## Required post-scrub checkpoint inputs

After `request_pii_scrub`, operators need **both**:

| Phase | Field | Topic semantics |
|-------|--------|-----------------|
| `ingest_fence` | `highWatermarks[]` `{topic,partition,low,offset}` | **Main** metric-stream topic(s) |
| `consumer_drain` | `quarantineHighWatermarks[]` `{topic,partition,low,offset}` | **Quarantine** topic = `{source}.quarantine.v1` (if a row’s `topic` is the main name, derive quarantine via suffix; never inventory main under quarantine HWM alone) |

`offset` here is the Kafka **high watermark / next offset** (exclusive). A value
of `0` means empty. Do **not** treat HWM as an inclusive last-consumed offset
without a separate source that says so.

`ingest_fence.completed_at` still orders `stock_physical_maintenance_ack`; it
does not select which segments span personal bytes.

Scrub projection (landed `e3761a714`): keep `ingest_fence.highWatermarks` and
`consumer_drain.quarantineHighWatermarks` (+ PeerDB cutoff) as the four non-PII
fields; strip nested identifiers. No new table/cert framework.

## Stock workflow (operator) — command text retained; execution still unproven

Vars: `$BOOTSTRAP`, `$MAIN_TOPIC`, `$QUARANTINE_TOPIC` (`$MAIN_TOPIC.quarantine.v1`),
`$PARTITION`, `$HWM_NEXT` (exclusive next offset from checkpoint), `$R2_BUCKET`,
`$RSM_PREFIX` (**`rsm.config.key.prefix`**, not `storage.s3.key.prefix`),
`$METADATA_LOG_GLOB` (all `__remote_log_metadata-*` partition dirs / rolled
`*.log` files), client Kafka tools JVM **outside** the broker cgroup, readonly
on metadata logs only — never dump application/PII payload topic logs.

### 1) Resolve TopicId for each topic (main and quarantine)

```bash
kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --describe --topic "$MAIN_TOPIC"
kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --describe --topic "$QUARANTINE_TOPIC"
# Record TopicId as Kafka Uuid string (base64url, typically 22 chars, no dashes).
# Name alone is insufficient for Aiven keys. Do not reformat to dashed RFC UUID.
```

### 2) Local segment inventory + late-arrival / backlog

```bash
kafka-log-dirs.sh --bootstrap-server "$BOOTSTRAP" --describe --topic-list "$MAIN_TOPIC,$QUARANTINE_TOPIC"
# On brokers: under each $TOPIC-$PARTITION dir, inventory local *.log/*.index whose
# offset ranges can still serve offsets < $HWM_NEXT (exclusive). Confirm produce
# lag / hold so new bytes are not still landing under the attested cutoff.
```

### 3) RLMM metadata — all partitions and rolled files; latest state per segment

Exact stock copy-before-down + 384 MiB readonly dump + inspect steps:
[`docs/kafka-ts-rlmm-dump-procedure.md`](./kafka-ts-rlmm-dump-procedure.md)
(Kafka 4.4.0 `--remote-log-metadata-decoder`; no maintained parser).

```bash
# Enumerate EVERY metadata partition dir and rolled segment file, not only -0.
# Run dump with a client JVM outside the broker cgroup; readonly metadata paths.
for f in $METADATA_LOG_GLOB; do
  kafka-dump-log.sh --remote-log-metadata-decoder --files "$f"
done
# For each TopicIdPartition of interest, reduce to latest state per segmentUuid.
# Spanning main (or quarantine) HWM next-offset N: startOffset < N && endOffset >= 0
# with care: Kafka segment endOffset is inclusive on the segment; HWM N is exclusive
# next offset — a segment still covers bytes that must be gone for absence < N when
# startOffset < N (i.e. segment began at or before the last present offset N-1 when N>0).
# Empty HWM (N=0): no offsets present; still inventory any leftover remote objects
# for that TopicIdPartition from historical keys / prior dump rows.
```

### 4) Map metadata → Aiven object keys (`rsm.config.key.prefix`)

```
{rsm.config.key.prefix}{topic}-{topicId}/{partition}/{startOffset:020d}-{segmentUuid}.log
{rsm.config.key.prefix}{topic}-{topicId}/{partition}/{startOffset:020d}-{segmentUuid}.indexes
{rsm.config.key.prefix}{topic}-{topicId}/{partition}/{startOffset:020d}-{segmentUuid}.rsm-manifest
```

### 5) Native RLM retention first

```bash
kafka-configs.sh --bootstrap-server "$BOOTSTRAP" --entity-type topics --entity-name "$MAIN_TOPIC" --describe
kafka-configs.sh --bootstrap-server "$BOOTSTRAP" --entity-type topics --entity-name "$QUARANTINE_TOPIC" --describe
# remote.storage.enable + retention.ms / retention.bytes / local.retention.* must
# fit ≤30d when measured end-to-end (copy+delete lag), not vendor SLA text.
```

Wait for RLM delete completion. **`DELETE_SEGMENT_STARTED` ≠ absence.**
`DELETE_SEGMENT_FINISHED` may purge metadata from the live cache / later compact —
so pass criteria are: (a) no live unfinished delete for spanning segments, and
(b) R2 inventory has zero keys for every historically mapped segment key from
step 4. Empty live metadata alone is not a pass.

### 6) Physical absence on R2 (ListObjectsV2; quiesced MPU handling)

```bash
aws s3api list-objects-v2 \
  --bucket "$R2_BUCKET" \
  --prefix "${RSM_PREFIX}${MAIN_TOPIC}-${MAIN_TOPIC_ID}/${PARTITION}/" \
  --endpoint-url "https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"
# Repeat for quarantine TopicId prefix. Expect zero keys for mapped historical
# .log/.indexes/.rsm-manifest names covering offsets < $HWM_NEXT.
```

Multipart uploads: list under the same prefixes. **Do not** abort uploads while
the broker is actively writing. Require uploads **quiesced** (no in-flight RSM
copy for that partition) or prove orphan ownership before stock
`AbortMultipartUpload`. Active abort to fake GC is forbidden.

### 7) Ack

When main + quarantine inventories pass and
`verifiedCutoffAt ≥ ingest_fence.completed_at`, record existing
`stock_physical_maintenance_ack` via the current SQL path
(`docs/account-erasure-runbook.md` Stock physical maintenance acknowledgement).
No new ack fields.

## Bound windows

Measure produce→COPY_FINISHED, retention breach→DELETE_FINISHED→ListObjectsV2
empty, segment.ms/rollover vs local.retention/retention.ms under prod-like load.
Require fence→full physical absence ≤30d. Until measured, fail closed.

## Exact remaining gaps (block operational)

1. **Native Delete/GC proof** — no `DELETE_SEGMENT_*` / plugin DeleteObjects →
   empty inventory artifact; Phase F wipe was manual.
2. **RLMM dump execution** — flag OK; no retained metadata logs to decode;
   no all-partition/roll dump transcript.
3. **Stock describe tools on a live cluster** — `kafka-topics` TopicId,
   `kafka-log-dirs`, `kafka-configs` stdout not captured as command validation.
4. **Live R2 ListObjectsV2 + list-MPU** after native GC (read-only) — unavailable
   without a standing broker+bucket; host lacks `aws` CLI for re-check of deleted labs.
5. **Quarantine topic path** — `.quarantine.v1` inventory never run in labs.
6. **Measured ≤30d windows** — copy/delete lag unset; fail closed remains.
7. **COPY_SEGMENT_FINISHED in dumps** — Phase F sanitized lines still show
   `state=COPY_SEGMENT_STARTED` even on “copy completed successfully”; operators
   must trust RLMM decoder latest-state reduction, not a single log line.

## Out of scope

- New parser CLI / custom segment-body reader
- New cloud Delete/MPU qualification budget (needs Root Q-DEL ACK)
- Labeling this draft operational before native retention/Delete proof exists
