# Application analytics orchestration

[`cycling-power-projector.ts`](cycling-power-projector.ts) persists derived
cycling power history using the reusable
[`@dofek/cycling-power` algorithms](../../packages/cycling-power/README.md).
Application reference data and policy live in
[`cycling-power-policy.ts`](cycling-power-policy.ts); persistence is defined by
[`cycling-power-schema.ts`](../db/cycling-power-schema.ts).

The bounded-work foundation uses [`effect-journal.ts`](effect-journal.ts) for
structural effects and discovery receipts in ClickHouse, and
[`analytics-work-store.ts`](analytics-work-store.ts) for small PostgreSQL
run/frontier/cursor and ownership records. Its executable contracts are in the
adjacent integration suites. Production activation requires the account-erasure
ownership migration in the same release unit; see the
[approved plan](../../docs/superpowers/plans/2026-11-03-bounded-analytics.md).

The [grouped delivery coordinator](analytics-delivery.ts) retains each message's
native position, receipt and ingestion timestamp while processing a bounded
group under one publication owner. PostgreSQL retains the exact pending or
completed membership descriptor; receipt verification precedes the processed
frontier update. The [native consumer](../metric-stream/pulsar-consumer.ts)
acknowledges individual messages only after that operation returns. These
contracts have [database recovery tests](analytics-delivery-group-coordinator.integration.test.ts)
and [native acknowledgement tests](../metric-stream/pulsar-consumer.pulsar.integration.test.ts).

Initial local measurements reached 139.8 samples/s at a group of 100 and
259.6 samples/s at 500. Replacing inherited sink-side chunks with bounded set
operations reduced a 500-message group's ClickHouse calls from 134 to 13.
One subsequent local run reached 984.3 samples/s in 508 ms, exceeding the
300 samples/s sink qualification target, with a process high-water mark of
about 311 MiB. It used 469–503-byte synthetic samples, producer batches of 20
and the unchanged 128 MiB query budget, including subscription and first-group
warm-up. All 500 raw rows and stable fields, receipts, processed frontier,
individual native ACK identities and distinct ingestion timestamps were checked.
This is a local sink result, not a production or combined-workload certification.
The [set-operation regressions](../metric-stream/clickhouse-sink-group.integration.test.ts)
cover groups of 1, 100 and 500. Persisted manifests authorize the larger proof
only for simple scalar groups; multi-effect control proofs and analytics
discovery pages remain bounded to 20 references.
Canonical Pulsar activation and retirement of the Kafka consumer remain release
gates; this checkpoint must not be deployed as a mixed-consumer recovery scheme.

The bounded sensor SQL qualification uses the canonical sealed page and native
dbt compiler, retaining complete candidates at each affected key. The
[resource fixtures](../db/deduped-sensor-read-model.integration.test.ts) compare
all stable fields of 8,000 scalar rows and 20 deduplicated rows against an
independent complete-key reference. Both the 800,000-version input and the
3.2-million-version input passed the fixed 128 MiB query allowance. The latter
used 320 unmerged raw parts and 320 normalized parts; measured scalar and dedup
query peaks were 72,968,443 and 120,158,615 bytes. This qualifies those fixtures,
not production throughput or whole-host memory fit.

The [ARM access-plan run](https://github.com/Asherlc/dofek/actions/runs/41897085571/job/126809932687)
and its [fixture](../db/bounded-sensor-access-plan.analytics-qualification.integration.test.ts)
confirm key and ID pruning in the current SQL. Read cost still depends on
overlapping parts and candidate dispersion; the large dedup case uses about 90%
of its query allowance. A pathological complete key fails visibly within that
allowance without restarting ClickHouse or producing output. The real executor's
failure-state and no-checkpoint proof remain separate release gates in
[Task 5](../../docs/superpowers/plans/2026-11-03-bounded-analytics.md#task-5-serialized-executor-query-ownership-and-output-before-cursor-recovery).

Each discovery receipt contains at most one effect reference. A page reads at most 20
references plus one lookahead before fetching the referenced effects. A missing
payload fails the page. An explicit empty delivery uses cursor ordinal `-1`;
actual effect ordinals are unsigned. Empty pages can advance a cursor while
`exhausted` remains false. Delivery completion verifies the count and ordered
SHA-256 identity digest through bounded receipt pages before advancing the
processed delivery frontier. Integer holes are allowed; exclusive admission
orders observed native deliveries. These behaviors are covered by the
[journal tests](effect-journal.integration.test.ts) and
[work-store tests](analytics-work-store.integration.test.ts).

Native delivery order is scoped to one epoch/topic/partition and preserves the
serialized ID. The adapter is pinned to Node `pulsar-client` 1.18.0 and its
[declared C++ 4.2.0 dependency](https://github.com/apache/pulsar-client-node/blob/v1.18.0/pulsar-client-cpp.txt).
The exact supported native representation and ledger/entry/batch ordering come
from the [pinned implementation](https://github.com/apache/pulsar-client-cpp/blob/v4.2.0/lib/MessageId.cc);
unknown and chunked representations fail qualification. See
[native tests](../../docs/testing.md#native-pulsar-position-qualification).

Transport evidence uses an explicit Kafka/Pulsar discriminator throughout the
journal, frontiers, and cursors. Kafka retains its decimal offset; Pulsar retains
its serialized ID and native ordering coordinates. The existing Kafka runtime
requires `METRIC_STREAM_TRANSPORT_EPOCH`, an opaque identity for the current
broker log incarnation. Preserve it across process restarts and deploys; rotate
it only when deliberately replacing that log. Never generate a new epoch on
consumer startup. The [position contract](../metric-stream/transport-position.ts)
and [coexistence tests](effect-journal.integration.test.ts) specify these rules.
Production environment rendering requires this key for all three sink services.
For local sink runs, configure it once in `.env.local`; `compose:env` preserves
that explicit value. Local Compose passes an absent value through as empty so
database-only commands remain usable; the sink fails immediately if its epoch is
missing. See the [environment renderer](../../scripts/deploy-service-environment.ts),
[workspace environment generator](../../scripts/compose-env.ts), and
[Docker Compose interpolation](https://docs.docker.com/reference/compose-file/interpolation/).

Every consumer batch supplies typed positions and `assertActive()`. The Kafka
adapter checks `isRunning()` and `isStale()` before and after its heartbeat,
including before resolving or committing offsets; these APIs are documented in
[KafkaJS batch consumption](https://kafka.js.org/docs/consuming#eachbatch).
The final ClickHouse journal schema has one transport-aware sorting identity.
Inactive native columns on Kafka rows use checked zero/-1 defaults and an empty
serialized-ID field; inactive Kafka offsets on Pulsar rows are zero. Application
positions never expose those storage placeholders. The
[schema](../db/analytics-work-schema.ts) and
[real-engine tests](effect-journal.integration.test.ts) enforce the invariant.

Run-writer ownership is separate from transport-consumer ownership. A run owner
is claimed by explicit compare-and-set, and checkpointing locks that same run
row before checking its owner and cursor. Before transferring ownership, the
caller must prove that the former writer and its server-side queries have
terminated; ownership CAS alone does not establish safe publication takeover.
The [ownership test](analytics-work-store.integration.test.ts) covers handoff at
an unchanged cursor. PostgreSQL documents the underlying
[row-lock semantics](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS).

The qualified [query owner](analytics-query-owner.ts) records an exact request
identity before dispatch. A fully consumed response establishes terminal
execution evidence in that live executor; the next exact-predecessor
registration combines its persistence with registration of the successor.
The final request is flushed separately before intent clearance or quiescence,
including on known-terminal callback failure. Thus request-related PostgreSQL
exchanges are N+1 for N > 0 requests, excluding lifecycle statements; zero
requests create no synthetic request proof. Between those
boundaries the durable row conservatively remains nonterminal. Losing the
executor's local evidence requires verified external recovery; a free lock,
missing process or elapsed time never authorizes takeover. The
[owner engine cases](analytics-query-owner.integration.test.ts) cover lost
registration/final responses, late writes and actual executor death.

Processed receipt replay uses the coordinator's required completion verifier:
fresh frontier coverage, the full exact receipt and the final transport-active
check precede its returned intent identity. That identity names the proof's
subject; it is not an independent proof or recovery token. Successful finalization
may retire only that exact matching completed intent through guarded
[UPDATE/RETURNING](https://www.postgresql.org/docs/current/sql-update.html).

| Admitted owner state | Verified replay of A |
| --- | --- |
| Terminal/quiescent, pending A | Retire only A; the next delivery can proceed. |
| Terminal/quiescent, pending B | Preserve B and its original ingestion time. |
| Terminal/quiescent, no pending intent | Preserve time and frontier; create no intent. |
| Unknown or nonquiescent | Reject before verification; require verified recovery. |

Missing proof, a void verifier, transport failure or unconfirmed retirement
cannot publish success. A lost retirement response keeps the owner blocked even
if PostgreSQL committed the clear. These distinctions are exercised by the
[coordinator cases](analytics-delivery.integration.test.ts) and the
[completed-A/pending-B sink case](../metric-stream/clickhouse-sink-recovery.integration.test.ts).

Receipt checks cover missing journal payloads while discovery receipts remain.
Loss of both receipts and payloads is part of the separate storage/restore
qualification gate. Per-effect receipts add metadata rows and write overhead
that must be included in the host storage and throughput budget; see the
[resource qualification requirements](../../docs/superpowers/plans/2026-11-03-bounded-analytics.md).

The projector first refreshes normalized power for at most 100 changed completed
activities with power, including cycling activities whose power is unavailable.
It then reconstructs at most 32 ready users' compact cycling histories. Each user
is published only after all their normalized-power observations match current
source versions. Corrections, deletion tombstones, algorithm versions, policy
versions, and UTC date progression participate in invalidation; see the
[projector](cycling-power-projector.ts) and its
[executable ClickHouse fixtures](cycling-power-projector.integration.test.ts).

Activity eligibility uses the requested projection instant: an active activity's
recorded end must be at or before that instant. A future import becomes dirty
when it completes, including later on the same UTC day. Clock-rewind fixtures
verify that premature observations are tombstoned and restored when eligible;
see the [maturity regressions](cycling-power-projector.integration.test.ts).

The application adapter retains negative or nonfinite native watt observations
as timestamped null barriers. It preserves recorded zero watts; the reusable
numerical package continues rejecting invalid direct inputs. The
[negative-sentinel regression](cycling-power-projector.integration.test.ts)
verifies that invalid coverage produces unavailable NP without failing the build.

[`run-analytics-build.ts`](../../scripts/run-analytics-build.ts) runs this stage
after successful dbt input builds, then builds threshold-dependent healthspan
models before recording the combined processing result.
Outstanding projection work prevents processing success and cache warming.
Deletion and recomputation jobs await the same serialized analytics writer via
[`analytics-refresh-queue.ts`](../analytics-refresh-queue.ts).

[`activity-read-model-build.ts`](activity-read-model-build.ts) contains the CDC
barriers used before dispatching serialized analytics maintenance.

Both observation and history writes use the existing account-erasure fence inside
`INSERT … SELECT`, and fenced accounts are excluded from dirty-user selection.
The [race fixtures](cycling-power-projector.integration.test.ts) activate erasure
between source reads and each persistence boundary.
