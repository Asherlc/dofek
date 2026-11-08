# Replay window and durability assessment

**Withdrawn as a release direction.** The user requires Kafka tiered storage;
hot-log-only window sizing does not solve that objective. This evidence/gap
analysis remains historical context. Do not advance its observation or retention
proposal as the migration solution. See the [tiered blocker](qualification.md#tiered-storage-required-quiescence-review).

Planning direction: durability takes priority over speed. The user permits
shortening retention to fit disk; no exact window, byte cap or production change
is approved. The former 1 GiB/source proposal is a candidate to evaluate, not an
accepted constraint. No new production observation or load test was run here.

## What the retained measurements establish

| Evidence | Measured quantity | Limits |
|---|---|---|
| [Capacity snapshot](cutover-packet.md#capacity-and-proposed-topic-policy) | 39,599,476,736 available filesystem bytes (36.8799 GiB) | One instant; shared with database growth and retained trees, not reserved Kafka capacity |
| [Three retained archive objects](../../docs/pulsar-foundation-qualification.md#november-5-retained-archive-line-size-measurement) | 247,242 JSONL lines, 116,115,423 decompressed bytes, 8,779,459 gzip bytes | About 469.64 decompressed bytes/line in this sample; neither Kafka log size nor a production byte rate |
| [History recovery](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/history-clickhouse-recovery-20261108/README.md) | 3,867,001 offsets drained to an unchanged high watermark | Consumer catch-up, not fresh production ingress; no encoded-byte/backfill burst budget |
| [Native lifecycle fixture](hot-log-qualification.md) | Two synthetic 100-record batches; each log length 814,387 bytes; delayed removal under stock settings | Synthetic workload, not production rate; file length/index apparent size is not allocated filesystem blocks |
| [Tiered lab](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-ts-dual512-fix-20261106/README.md) | 256 MiB synthetic payload with remote count/order/hash after restart | Different storage mode; total run time includes multiple phases, not sustained production ingress or canonical JSONL restore |

These records cannot support a measured replay-window recommendation. Multiplying
history offset counts by the archive sample's mean line size would combine
different populations and omit keys, Kafka encoding and storage overhead. Gzip
object sizes cannot be used directly as broker retention bytes. Net disk growth
can also hide ongoing ingestion when retention deletes old segments.

## Shorter-window candidates, pending measurements

Let `R_i` be measured sustained **Kafka log bytes/hour** for each source route,
and `B_i` its separately measured worst admitted backfill/burst excess over that
rate within a window. For a candidate window `W`, its source storage budget must
cover at least `R_i × W + B_i`. Do not apply a steady-state rate twice to the same
burst. Measured rolling-window byte totals are preferable when available.

| Candidate broker replay target | Required source-log budget, before other storage | Durability/recovery coverage lost |
|---|---|---|
| 6 hours | `Σ(6 × R_i + B_i)` | Broker recovery for a longer consumer/archive outage is unavailable after expiry |
| 24 hours | `Σ(24 × R_i + B_i)` | Outages beyond one day depend on separately validated recovery outside the broker |
| 72 hours | `Σ(72 × R_i + B_i)` | Three-day broker coverage, still shorter than the current time policy |

These are comparison targets, **not measured feasible options or guarantees**.
None can yet be priced in GiB using the retained evidence. Prefer the longest
window demonstrated to fit with conservative headroom; do not pick six hours
merely to speed migration or accept arbitrary source caps.

For each candidate, compare the source budget plus quarantine storage, active
and pending-deletion segments, indexes/metadata, and reserved database/host growth
against refreshed filesystem availability. Quarantine's three existing 1 GiB
targets total 3 GiB nominally and retain their existing time policy. With six
1-partition topics, six default 1 GiB segments are another useful planning
allowance, **not a bound on overshoot or delayed-deletion storage**. The observed
36.8799 GiB therefore does not imply 36.8799 GiB is available for source logs.
Kafka's [topic configuration](https://kafka.apache.org/44/configuration/topic-configs/)
defines byte retention per partition and segment-based cleanup. A byte threshold
can expire records sooner than a requested time window.

## Failure durability is a separate gate

The candidate has one broker/controller, RF1 and remote storage disabled. More
local retention improves the duration of broker replay while its only disk
survives; none of the three windows adds a second copy on an independent failure
domain. Even `acks=all` cannot protect records after loss of the only in-sync
replica. A process restart test does not establish disk-loss, machine-loss or
power-loss durability; no per-record forced-flush guarantee is claimed. See
[Kafka's replication/failure design](https://kafka.apache.org/44/design/design/).
If the required objective is preservation of every acknowledged record after
host/disk loss, none of these RF1 options establishes it; increasing or reducing
retention cannot repair that failure-domain gap. Any architecture change needs
separate strategy alignment rather than silently adding machinery here.
The [current producer](../../src/metric-stream/redpanda-producer.ts) uses KafkaJS
send defaults; [KafkaJS 2.2.4](https://kafka.js.org/docs/producing) documents default
all-in-sync acknowledgements and no compression. Do not substitute Java-client
defaults or treat a broker acknowledgement as an R2 archive acknowledgement.

The [canonical archive runbook](../../docs/metric-stream-redpanda-r2-runbook.md#replay)
explicitly states that bounded R2-to-ClickHouse replay is not shipped; the named
command is absent. Retained object hashes and parsers do not prove a complete
operator restore. Archive existence therefore supplies no demonstrated recovery
time or end-to-end loss bound after Kafka expiry/disk loss. PostgreSQL backup
freshness/restore checks are [separate](../../docs/database-backup-recovery-runbook.md)
and do not restore the metric-stream broker log. The single-disk archive lag
exposure, missing bounded replay verification and accepted failure/recovery
objective must be resolved before activation; no new infrastructure, backup
scheme, flush setting or replay implementation is selected by this assessment.

## Smallest aggregate observation proposal

**Proposed read-only work, not executed or authorized by this document.**

1. If an existing metrics system retains them, request one bounded export of the
   prior seven days for just the three source/quarantine routes: timestamped
   topic produce-byte counters, archive group progress, host disk availability
   and allocated broker/database filesystem use. Export aggregate series only;
   no event bodies, account identifiers, archive listings/downloads or new
   instrumentation. Confirm that any natural import/backfill is represented.
2. If that history does not exist, request a single bounded 24-hour observation
   at 60-second resolution using existing stock metrics, with no generated load
   or retention changes. Bound collection at 1,441 timestamps and the six
   configured topics. Read filesystem space at start/end and any existing
   collected disk history; do not recursively scan database or archive contents.
   Do not install a new metrics stack, poll indefinitely, or claim unobserved
   history/backfill coverage from a quiet day.
3. Redpanda documents the topic/produce-labelled
   [`redpanda_kafka_request_bytes_total`](https://docs.redpanda.com/streaming/current/reference/public-metrics-reference/)
   counter. First confirm its availability and semantics on the pinned running
   version. Reject intervals spanning resets or missing samples. These are
   broker-reported topic bytes; assess the conversion to the intended Kafka log
   format and allocated storage before treating them as Kafka disk demand.
   Offset deltas remain lag indicators, not a byte counter.
4. Report per-route rolling 6/24/72-hour totals where coverage actually exists,
   short-interval byte peaks, naturally observed backfill excess, allocated disk
   overhead and concurrent database growth. A 24-hour observation cannot measure
   a 72-hour maximum. Missing representative bursts, retention/deletion overhead
   or a justified filesystem reserve leave that option unqualified.

The immediate recommendation is to obtain these smallest aggregate measurements
and define the accepted host/disk-loss recovery objective before choosing a cap.
Then select the longest feasible shorter window and report exactly which outage
and failure coverage is relinquished. Keep current production unchanged until
that durability/readiness bundle and the cutover itself are approved.
