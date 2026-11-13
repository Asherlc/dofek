# Kafka tiered retention

The November 12, 2026 audit found native R2 uploads working while local
retention inherited total retention. The selected change uses stock Kafka
retention controls and the existing deployment reconciliation. No replacement
broker, storage controller or plugin fork is needed ([Kafka tiering](https://kafka.apache.org/44/operations/tiered-storage/)).

## Selected policy

| Setting | Source topics | Quarantine topics |
| --- | --- | --- |
| Total retention time | Seven days | Seven days |
| Total retention bytes | No byte cap | 1 GiB per partition |
| Local retention target | 24 hours or 1 GiB per partition | 24 hours or 256 MiB per partition |
| Segment rolling | One hour or 128 MiB | One hour or 128 MiB |

[topic-policy.json](topic-policy.json) is the single source for exact settings.
The existing workflow incrementally reconciles all six topics and verifies
every selected key before and after consumers start. Quarantine retains its
existing exact total-policy contract. Topic identities, offsets, archive routes
and account-erasure guards are preserved. Local limits are cache budgets, not
promised local replay windows. Offload failure can still grow local storage;
these settings are retention targets rather than hard quotas
([Kafka topic settings](https://kafka.apache.org/44/configuration/topic-configs/)).

The stock Prometheus JMX agent 1.7.0 exports native Kafka metrics through the
existing collector to the existing Axiom metrics dataset. The canonical workflow
verifies its release SHA256 before atomic installation in the plugins bind.
The broker loads a versioned Swarm config; the collector config rotates from v3
to v4. No new service, metrics datastore, secret or externally supplied variable
is required ([upstream release](https://github.com/prometheus/jmx_exporter/releases/tag/1.7.0),
[OTLP agent mode](https://prometheus.github.io/jmx_exporter/configuration/opentelemetry/)).

## Working notes

- Production audit at 20:44 UTC: broker remote storage enabled, upstream Aiven
  manager configured, generated endpoint is Cloudflare R2; sampled logs include
  successful native copy and deletion. All six application topics have tiering
  enabled and both local limits at `-2` (inherit total limits).
- At 20:46 UTC the data filesystem had 28,242,874,368 available bytes; Kafka used
  approximately 8.3 GiB and retained Redpanda approximately 29 GiB. Retained
  history segments span a roughly two-hour 4 GiB burst; this is a lower-bound
  observation of retained data, not a peak-rate or seven-day capacity measurement.
- Release Production [43301636803](https://github.com/Asherlc/dofek/actions/runs/43301636803)
  was active. Its ClickHouse sinks were quiesced; source archive groups had zero
  observed lag. Source sink lag was 943,197 live / 1,444,879 history offsets.
  Those counts are not byte measurements or a steady-state health verdict.
- Local limits are cache budgets, not promised local replay windows. Source
  totals retain seven days by time without a byte ceiling; no seven-day R2 cost
  estimate or RF1 disk-loss guarantee is inferred from the partial observations.

## Native qualification

At 20:53 UTC, an isolated workspace Compose fixture using the production-pinned
Kafka 4.4.0 image and Aiven 1.2.0 plugins accepted and read back all eight policy
keys on six synthetic source/quarantine topics. The object backend was a local
S3-compatible fixture, not production R2. No production broker records or settings were
changed. The disposable probe is outside the repository.

The probe first reproduced inherited local retention keeping a covered segment.
It then accelerated only the fixture's segment/local-retention timers to one
second. Native Kafka removed that local segment while the global low/high offsets
remained `0`/`192`. A fresh consumer read the first 64 records after eviction;
their concatenated payload SHA256 was
`f317dd9d6ba01c465d82e4c4d55d01d270dda69db4a01a64c587a5593ac6084d`,
matching the generated fixture. The first local segment remained absent after
the read. All six topic identities survived; the exact intended production
policy was restored in the fixture. This verifies native remote replay, not a
24-hour wall-clock run, R2 availability, automatic index-cache erasure or survival
of an RF1 disk loss. Kafka documents the
[upload/eviction/read sequence](https://kafka.apache.org/44/operations/tiered-storage/).

## Rollout and observation

### Production observation: November 12 (November 13 UTC)

The canonical [server release](https://github.com/Asherlc/dofek/actions/runs/43330045743/job/131572442558)
for `c7909fdafb0ad868407c9de493e3bd4e72f83b51` applied the policy above.
Independent native readback found all eight intended values on all six topics,
with their original topic IDs and one-member ISR preserved. The release also
passed the private broker/worker backend comparison. The server job completed
successfully at 00:31 UTC on November 13, including the final broker and policy
checks after consumer startup. This is the server result; mobile publication
has separate jobs.

The [dated evidence packet](../../docs/evidence/kafka-retention-20261112/README.md)
retains the initial operator snapshot and timestamped raw follow-up readbacks.
The [initial observation](../../docs/evidence/kafka-retention-20261112/production-initial-observation.json)
is a transcription of the command outputs for the figures below; its individual
command timestamps were not retained. Later raw samples can have advancing
offsets and allocation.

| Partition 0 | Global earliest offset | Local earliest offset after eviction | Fresh remote-only read |
| --- | --- | --- | --- |
| Live | 1,696,520 | 7,493,452 | Offset 1,696,520 returned |
| History | 427,815 | 7,353,960 | Offset 427,815 returned |

The independent console consumers disabled automatic commits and suppressed
payload output. These reads establish production remote replay after native
local eviction; they are not a complete restore or an RF1 disk-loss test.
Allocated Kafka bytes fell from 8,805,670,912 before reconciliation to
1,257,779,200 afterward; the filesystem had 66,485,805,056 available bytes.
These are point-in-time allocated-byte measurements, not permanent quotas.
Kafka describes the [local/remote retention and read behavior](https://kafka.apache.org/44/operations/tiered-storage/).

At 00:30 UTC, both nonempty source archive groups had zero lag. Sink commits
were progressing (live 8,461,347; history 5,913,085) while their respective
backlogs remained 1,209,890 and 1,440,875 offsets. Retention deployment does not
establish that ingestion has caught up. A bounded broker sample showed a
successful history segment copy and no matching error lines. The collector's
OTLP accepted/sent metric-point counters advanced from 24,426 to 49,228, with
zero receiver failures/refusals. This confirms continuing transport acceptance;
the existing token still lacks metrics-query permission, so Axiom stored-query
readback and per-series production backlog/error values remain unverified.
See [Axiom ingestion](https://axiom.co/docs/send-data/opentelemetry) and
[metrics query permissions](https://axiom.co/docs/query-data/metrics).

Use the [canonical production release](../README.md#checking-the-latest-production-deployment)
with the matching source/image after review and passing CI. The existing workflow
incrementally applies this policy and verifies all selected keys before and after
consumer startup. Do not manually alter production topics or bypass that release.
Although topic-policy reconciliation is dynamic, adding the Java agent changes
the Kafka service specification and restarts the sole broker. The release needs
an approved interruption window and the normal ingress/consumer quiescence;
it is not a zero-interruption broker change ([Swarm service updates](https://docs.docker.com/engine/swarm/services/#update-a-service)).
The seven-day source limit applies across local and remote storage; lifting the
byte cap cannot restore records already expired under the old policy
([retention settings](https://kafka.apache.org/44/configuration/topic-configs/)).

Before and after release, record the six topic identities, effective configs,
global offsets, consumer-group progress, Kafka allocation and filesystem free
space. Use the pinned operator container outside the broker cgroup, as in the
[operator command reference](operator-proposal.md). Describe topic configs with
`kafka-configs.sh --describe --entity-type topics --all` and group lag with
`kafka-consumer-groups.sh --all-groups --describe`. These are read-only stock
[Kafka operations](https://kafka.apache.org/44/operations/basic-kafka-operations/).

Watch native broker copy/delete completion and unexpected failures through the
existing Docker/Axiom logging path. Sample with:

```sh
ssh dofek-server 'docker service logs --raw --timestamps --since 30m --tail 2000 dofek_kafka 2>&1'
ssh dofek-server 'df -h /mnt/dofek-data; du -sh /mnt/dofek-data/kafka-broker/data'
```

Successful copies establish progress, not a zero upload backlog. Quantitative
copy backlog and error rates use Kafka's existing `RemoteCopyLagBytes`,
`RemoteCopyLagSegments`, `RemoteCopyErrorsPerSec`, `RemoteFetchErrorsPerSec` and
`RemoteDeleteErrorsPerSec` JMX metrics. This change adds the stock JMX agent and
the [collector metrics pipeline](../otel-collector-config.yaml). Verify fresh
samples after each release. The agent exports every 60 seconds to the
existing Axiom `dofek-host-metrics` dataset with service name `dofek-kafka`, without
opening a JMX control or HTTP metrics port. See
[Kafka monitoring](https://kafka.apache.org/44/operations/monitoring/),
[JMX agent OTLP configuration](https://prometheus.github.io/jmx_exporter/configuration/opentelemetry/)
and [Axiom metrics ingestion](https://axiom.co/docs/send-data/opentelemetry).

Stock metric naming keeps the native Kafka metric name in a `name` attribute:

| Series | Attribute | Meaning |
| --- | --- | --- |
| `kafka_server_brokertopicmetrics_value` | `name=RemoteCopyLagBytes` / `RemoteCopyLagSegments` | Eligible upload backlog |
| `kafka_server_brokertopicmetrics_count` | `name=RemoteCopyErrorsPerSec` / `RemoteFetchErrorsPerSec` / `RemoteDeleteErrorsPerSec` | Cumulative operation failures |
| `kafka_server_brokertopicmetrics_oneminuterate` | Same operation names | Kafka one-minute operation/error rate |
| `kafka_server_brokertopicmetrics_count` | `name=BytesInPerSec` | Cumulative ingress bytes |
| `kafka_log_log_value` | `name=Size` | Local log bytes by topic and partition |
| `jmx_scrape_error` | none | Agent scrape failure indicator |

Filter by `service.name=dofek-kafka` and the desired `topic`. Broker-wide series
omit `topic`; do not sum them with their per-topic counterparts. Count series
use stock default gauge typing, so compare successive samples with reset
awareness instead of assuming an OTel monotonic counter. In Axiom's Metrics
Builder, select the dataset, series and these attributes. For example, the MPL
equivalent for copy backlog is:

```text
`dofek-host-metrics`:kafka_server_brokertopicmetrics_value
| where `service.name` == "dofek-kafka" and name == "RemoteCopyLagBytes"
| align to 1m using max
```

See [Axiom metrics queries](https://axiom.co/docs/query-data/metrics). Missing
samples are unknown health, not zero lag. Review increasing backlog, new failures,
scrape errors and the 20 GiB free-space reserve together. This provides continuous
metrics ingestion; it does not create an alert notifier or new notification policy.

The local native qualification observed copy backlog and error series in the
collector, `jmx_scrape_error=0`, and successful synthetic remote copy. The collector
accepted its config using the pinned 0.149.0 binary. An OTLP metrics request to
the existing dataset returned HTTP 200 with an empty success response. The token
lacks metrics-query permission (HTTP 403), so stored-query readback and alert
behavior were not verified. Local qualification uses
`service.name=dofek-kafka-qualification` to distinguish its synthetic series.

Require consumer/archive progress, successful remote reads after native local
eviction, no unexpected copy/fetch/delete errors and at least the existing 20 GiB
filesystem reserve before declaring a production rollout verified. Retention
targets cannot cap disk growth during an offload outage; investigate the first
fatal error rather than disabling tiering or extending retry/timeout settings.

## Retired Redpanda cleanup

The operator explicitly approved cleanup on November 12. At 21:29 UTC, the
original Redpanda contents were deleted after checking the cutover receipts,
current R2 object-range coverage, absence of a running Redpanda broker, no
writable container references and no nested mounts. Only
`/mnt/dofek-data/redpanda` contents were removed. Its directory inode and the
worker's read-only mount were preserved; active and aborted Kafka allocations
were unchanged. This reclaimed 30,980,030,464 bytes (28.9 GiB), increasing
filesystem availability from 28,259,467,264 to 59,239,497,728 bytes.

The metadata scan inspected 403,000 archive objects. Nonempty object ranges cover
every retained old live offset `[212186947, 247794777)` and history offset
`[55609019, 74445631)`, matching both sink and archive final cutover commitments
in the [phase-1 receipt](phase1-execution.md). This verifies retained-range
coverage, not payload decoding, a full restore or forensic overwrite. The
independent JSONL archive and both Kafka trees remain intact. See the
[incident record](../../docs/production-incident-baseline.md#2026-11-12--kafka-tiering-retains-the-full-replay-window-locally-rollout-pending).

### Pre-retirement review (historical)

The audit found approximately 29 GiB under the original
`/mnt/dofek-data/redpanda` root and no running Redpanda container. This is a
separate destructive operation. Before approval, refresh the preserved
[phase-1 final offsets and archive commitments](phase1-execution.md), establish
that every required old record is accounted for, and decide whether the preserved
tree remains required for recovery. The JSONL archive is independent of native
Kafka tiering; the
[archive replay runbook](../../docs/metric-stream-redpanda-r2-runbook.md#replay)
still records the limits of operator-ready recovery.

The proposed deletion scope is only the contents of that original retired root,
after verification and explicit approval. Keep its directory and read-only worker
mount in place so the existing erasure guard observes actual emptiness. Do not
rename the tree, substitute an empty mount, remove the completion hold, delete
the active Kafka root or include the aborted Kafka tree in this scope. Actual
mount sources and retained bytes are part of the
[erasure boundary](README.md#erasure-boundary), not disposable Docker cache.
The deletion above was a separately authorized operator action, not a topic-policy
deployment hook or automatic cleanup service.
