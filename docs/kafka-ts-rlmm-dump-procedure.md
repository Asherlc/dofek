# Stock Kafka 4.4 RLMM dump procedure (evidence capture)

Operator procedure for lane **87** `20261107c` (and any disposable TS lab).
**Offline-sourced** from `apache/kafka:4.4.0` `kafka-dump-log.sh --help` and
Apache Kafka **4.4.0** sources (`DumpLogSegments.RemoteMetadataLogMessageParser`,
`RemoteLogMetadataSerde`, `RemoteLogSegmentState`). No maintained parser —
inspect stock dump stdout only. **No heavy broker lab / new cloud from this
doc alone**; run against the **already-approved** 8 MiB packet lab.

## Why (close the 20261107b gap)

`About to delete remote` in RSM logs ≠ `DELETE_SEGMENT_FINISHED`. Capture
**all** `__remote_log_metadata` partition dirs + rolled `*.log` **before**
`compose down --volumes`, then decode offline so one follow-up proves
`COPY_SEGMENT_FINISHED` and `DELETE_SEGMENT_FINISHED` (latest state per
segment) instead of repeating the metadata gap.

## Pins

| Pin | Value |
|---|---|
| Image | `apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f` |
| Tool cgroup | **384 MiB** (`--memory=384m`) |
| Heap | `KAFKA_HEAP_OPTS="-Xms32m -Xmx256m"` |
| Topic | `__remote_log_metadata` ([`TopicBasedRemoteLogMetadataManagerConfig.REMOTE_LOG_METADATA_TOPIC_NAME`](https://github.com/apache/kafka/blob/4.4.0/storage/src/main/java/org/apache/kafka/server/log/remote/metadata/storage/TopicBasedRemoteLogMetadataManagerConfig.java)) |
| Default partitions | **50** unless `remote.log.metadata.topic.num.partitions` / `KAFKA_RLMM_CONFIG_REMOTE_LOG_METADATA_TOPIC_NUM_PARTITIONS` overrides (20261107c compose does **not** override → expect up to 50 dirs) |
| Lab data dir | container `/var/lib/kafka/data` (compose volume `pulsar-foundation-kafka-ts-r2-q-mpudel-c-data`) |
| Decoder flag | `--remote-log-metadata-decoder` → `RemoteLogMetadataSerde.deserialize(value).toString()` |

## Timing (one capture, not two gaps)

1. After native retention has had time to delete (RSM may log `About to delete`).
2. **Before** Root/operator `ListObjects` pass criteria and **before**
   `compose down --volumes` / volume wipe / bucket DELETE.
3. Prefer dump while broker is still up **or** after a clean stop **with the
   volume retained** — either way, **copy RLMM logs out first**.
4. Coordinate with the single 8 MiB `20261107c` packet: do **not** recreate
   `20261107` / `20261107b`; do **not** start a second cloud run just for
   RLMM if this packet’s retention window can still emit FINISHED.

## Step A — Copy RLMM logs out (before down)

```bash
LAB="${LAB:-/tmp/kafka-ts-r2-q-mpudel-20261107c}"
OUT="${OUT:-$LAB/evidence/rlmm-logs}"
IMAGE='apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f'
mkdir -p "$OUT"

# From the lab compose project directory (service name: kafka):
# Copy every __remote_log_metadata-* partition directory (not only -0).
docker compose cp \
  'kafka:/var/lib/kafka/data/.' \
  "$OUT/data-tree-staging"

# Keep only RLMM partition dirs + their rolled segment files.
rm -rf "$OUT/__remote_log_metadata_copy"
mkdir -p "$OUT/__remote_log_metadata_copy"
find "$OUT/data-tree-staging" -type d -name '__remote_log_metadata-*' -print0 \
  | while IFS= read -r -d '' dir; do
      base="$(basename "$dir")"
      mkdir -p "$OUT/__remote_log_metadata_copy/$base"
      # All rolled *.log files (and companions for provenance); dump uses *.log only.
      cp -a "$dir"/. "$OUT/__remote_log_metadata_copy/$base/"
    done

# Inventory what will be decoded (must be non-empty after copy+delete activity).
find "$OUT/__remote_log_metadata_copy" -type f -name '*.log' | sort | tee "$OUT/rlmm-log-files.txt"
test -s "$OUT/rlmm-log-files.txt"
```

Alternative if `compose cp` is awkward: `docker volume inspect
pulsar-foundation-kafka-ts-r2-q-mpudel-c-data` → copy from `Mountpoint` with
host permissions — still **before** `down --volumes`.

## Step B — Stock dump (separate 384 MiB / heap 256 tool, readonly mount)

```bash
DUMP_DIR="$OUT/dump"
mkdir -p "$DUMP_DIR"

# Mount the copy read-only. Do NOT mount application/PII topic logs.
# --files is REQUIRED and comma-separated; batch if argv gets long.
mapfile -t LOGS < <(find "$OUT/__remote_log_metadata_copy" -type f -name '*.log' | sort)
test "${#LOGS[@]}" -gt 0

# Dump each file separately so a bad segment does not skip siblings.
for logf in "${LOGS[@]}"; do
  rel="${logf#"$OUT/__remote_log_metadata_copy/"}"
  safe="$(printf '%s' "$rel" | tr '/ ' '__')"
  docker run --rm --memory=384m \
    -e KAFKA_HEAP_OPTS='-Xms32m -Xmx256m' \
    -v "$OUT/__remote_log_metadata_copy:/rlmm:ro" \
    --entrypoint /opt/kafka/bin/kafka-dump-log.sh \
    "$IMAGE" \
    --remote-log-metadata-decoder \
    --files "/rlmm/$rel" \
    >"$DUMP_DIR/$safe.txt" 2>"$DUMP_DIR/$safe.err"
done

# Concatenate in partition/base-offset order for human review.
find "$DUMP_DIR" -name '*.txt' | sort | xargs cat >"$OUT/rlmm-dump-all.txt"
```

`kafka-dump-log.sh --help` (4.4.0): `--remote-log-metadata-decoder` parses
TopicBasedRemoteLogMetadataManager records; `--files` is required.

## Step C — Inspect real output (no custom parser)

Each data record prints roughly:

```text
Dumping /rlmm/__remote_log_metadata-N/<baseOffset>.log
...
offset: <rlmmOffset> CreateTime: ... keySize: -1 valueSize: ...
 payload: RemoteLogSegmentMetadata{remoteLogSegmentId=RemoteLogSegmentId{topicIdPartition=..., id=...}, startOffset=..., endOffset=..., ..., state=COPY_SEGMENT_FINISHED, ...}
```

or

```text
 payload: RemoteLogSegmentMetadataUpdate{remoteLogSegmentId=..., ..., state=DELETE_SEGMENT_FINISHED, ...}
```

Sources:

- Parser: `RemoteMetadataLogMessageParser` → `metadataRecordSerde.deserialize(data).toString()`
  ([`DumpLogSegments.java` 4.4.0](https://github.com/apache/kafka/blob/4.4.0/tools/src/main/java/org/apache/kafka/tools/DumpLogSegments.java))
- States (enum order): `COPY_SEGMENT_STARTED` → `COPY_SEGMENT_FINISHED` →
  `DELETE_SEGMENT_STARTED` → `DELETE_SEGMENT_FINISHED`
  ([`RemoteLogSegmentState`](https://kafka.apache.org/44/javadoc/org/apache/kafka/server/log/remote/storage/RemoteLogSegmentState.html))

### Latest state per segment (log order)

RLMM is an append-only metadata log. **Later records win** for the same
`remoteLogSegmentId` / segment `id=`:

1. Walk `$OUT/rlmm-dump-all.txt` in file order (partition dir + baseOffset) then
   ascending `offset:` within each file.
2. For each payload line, note `id=` (segment Uuid) and `state=...`.
3. Keep the **last** `state=` seen per segment id (and TopicIdPartition).
4. Pass intent for delete evidence: spanning segments show latest
   `state=DELETE_SEGMENT_FINISHED` (or document unfinished
   `DELETE_SEGMENT_STARTED` / missing FINISHED as **gap**, not pass).
5. Also retain evidence of prior `state=COPY_SEGMENT_FINISHED` in the history
   for the same segment (20261107c criterion B).

Stock helpers only (examples — not a maintained tool):

```bash
# All FINISHED delete payloads (then eyeball segment ids vs TopicIds)
grep -n 'state=DELETE_SEGMENT_FINISHED' "$OUT/rlmm-dump-all.txt" | tee "$OUT/grep-delete-finished.txt"
grep -n 'state=COPY_SEGMENT_FINISHED' "$OUT/rlmm-dump-all.txt" | tee "$OUT/grep-copy-finished.txt"
grep -n 'state=DELETE_SEGMENT_STARTED' "$OUT/rlmm-dump-all.txt" | tee "$OUT/grep-delete-started.txt"
```

Do **not** treat RSM `About to delete` lines as FINISHED. Do **not** claim pass
from empty live RLMM after compact without the pre-down dump of all rolls.

## Step D — Pair with Root inventory (same packet)

After dump artifacts are on disk under `$LAB/evidence/rlmm-logs/`:

1. Root `ListObjectsV2` + list-MPU under the 20261107c prefix → expect **0**
   **before** operator cleanup (criterion B).
2. Then cleanup / `down --volumes` / bucket DELETE.
3. Commit evidence: `rlmm-log-files.txt`, per-file dump txt/err, greps, and a
   short note of latest state per segment id — **no test-pass overclaim**.

## Explicit non-goals

- No new cloud budget from this procedure alone
- No body GET of remote `.log` objects
- No dumping metric-stream / quarantine **application** logs here (PII risk)
- No repo-maintained RLMM parser or CI decoder job
