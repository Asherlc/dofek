# Kafka backlog throughput investigation — November 13 UTC

This packet records an unresolved throughput incident after a successful
[canonical release](https://github.com/Asherlc/dofek/actions/runs/43364317917).
Healthy containers and active consumer groups did not establish adequate drain
rate: from 04:49:03 to 05:50:11 UTC the live backlog grew by 53,142 records while
history declined by 23,023. R2 archive groups remained caught up. These offset
figures are operator transcriptions from timestamped native consumer-group
readings; no claim is made that every original command output was retained.

## Retained primary output

- [Batch metadata](production-batches.jsonl): Axiom CLI output for
  `metric_stream.consumer_batch` between 05:25 and 06:00 UTC, retrieved at
  approximately 06:26 UTC. Only time, topic, event/deletion counts and total sink
  duration are selected. Sink duration includes ownership wait and database work.
- [ClickHouse query summary](production-query-summary.jsonl): native
  `system.query_log` aggregate, retrieved at 06:26:46 UTC, for completed queries
  between 05:30 and 06:00 UTC whose text begins `INSERT INTO ingest.metric_stream`.
  Shapes use ClickHouse `normalizeQuery`, removing literal values. The summary
  does not include client round trips, PostgreSQL owner registration or lock wait.

The live batches contained 1,823 deletion events each. The retained query
summary shows 38 tombstone queries reading 2,771,302,724 rows, plus 3,646 separate
receipt inserts. PostgreSQL lock readings separately showed the accepted shared
publication resource alternately held by analytics and sink batches. Those lock
observations are operator transcriptions, not retained raw database audit records.

The [design](../../superpowers/specs/2026-11-13-kafka-deletion-throughput-design.md)
keeps the existing shared owner, event/revision order and erasure fences while
reducing repeated scope reads and per-event receipt requests. At packet creation,
implementation and production qualification remain pending. No analytics pause,
offset reset, owner recovery, retention change or production mutation was used
for this investigation. Original synthetic local baseline suites passed 42 unit
tests and 15 ClickHouse integration tests before new regressions were added.

## Reproduction of the bounded queries

The batch query filters `dofek-logs` by the fixed UTC window and exact body
`metric_stream.consumer_batch`, selecting `event_count`, `deletion_event_count`
and `sink_duration_ms` from the current custom map or historical flattened fields.
It sorts by timestamp. No provider payload or identifying filename is selected.
See the [Axiom field contract](../../axiom-observability-runbook.md).

The native query groups `QueryFinish` records by the first 160 characters of
`normalizeQuery(query)`, selecting `count()`, total/max `query_duration_ms` and
summed `read_rows`. Both timestamps are converted with explicit `UTC` timezone.
Use [ClickHouse query_log](https://clickhouse.com/docs/operations/system-tables/query_log)
for those field definitions; query execution time is distinct from full batch time.

Native before/after fixtures and release results will be added only after they
have run. The relevant stock optimization is
[synchronous client-side batching](https://clickhouse.com/docs/optimize/bulk-inserts),
not a new retry, timeout or asynchronous acknowledgement path.

## Acknowledgement batching qualification, interim

The original 101-event fixture failed its request-count assertion with 101
acknowledgement reads and 101 receipt writes instead of the required two each.
The corrected [focused native run](acknowledgement-focused-results.json) passed
five cases with retries disabled: partial and full receipt replay, uppercase
UUID replay, and the two previously failing latest-row cases. The three replay
variants assert exact rows, receipts and nonempty native QueryFinish coverage,
with read/write counts of 2/2, 2/1 and 2/0 respectively.

The [full interim run](acknowledgement-full-interim-results.json) passed 17 cases
and timed out after 30 seconds in the partial-replay case. That result is not a
green full-suite qualification. Read-only query logs showed slow synchronous
fixture cleanup, but do not establish the precise timeout phase. No retry or
timeout was increased. Final full-suite qualification remains required.

These fixtures use local ClickHouse 26.9.19.9; production remains on 26.6.1.1193.
The batched lookup selects the UUID column directly. An earlier same-name
`toString(event_id) AS event_id` projection failed native receipt matching;
ClickHouse documents [alias substitution across clauses](https://clickhouse.com/docs/reference/syntax#expression-aliases).
The correction removes that cast and alias without changing database settings.
This local evidence does not establish production drain rate or catch-up.

## Candidate scan regression, original source

The [native scan regression](candidate-scan-red-results.json) seeded 8,192 rows
and applied 101 disjoint scopes in two bounded chunks. Exact deleted and
preserved row IDs passed before the read bound failed. Both actual tombstone
queries had matching QueryFinish records: 827,492 and 16,585 rows read, totaling
844,077 against a bound of 49,152. Earlier fixture setup and row-assertion
failures were corrected before recording this read-bound failure; those are
not counted as the performance reproduction. This run still used the original
UNION ALL candidate SQL.

The [fixed-source profile](candidate-scan-fixed-results.json) reads 16,484 and
16,585 rows, totaling 33,069: approximately 25.5 times fewer than the original
run, with the same exact row-state checks and native query coverage. A separate
combined-scope fixture passes null, overlap, time-boundary, cross-scope pairing
and moved-identity checks. The [combined interim run](combined-native-interim-results.json)
passes 24/25 cases, including original pruning and nanosecond precision checks;
the partial-101 replay case still times out at 30 seconds. This is a local
read-work reduction, not a production throughput multiplier or a passing full
qualification. No retry, timeout or database setting was changed.

## Clean sink qualification after phase observation

The [clean full sink run](sink-native-clean-results.json) subsequently passes
18/18 with retries disabled and the original test limit. The partial-101 case
takes 15.86 seconds. An earlier timed run also passes 18/18: assertions finish
in 0.59–1.42 seconds, with complete cases taking 17.25–21.46 seconds including
synchronous cleanup. These observations do not establish the cause of the
previous timeouts. Temporary markers were removed; the native file and helpers
are byte-identical to their pre-observation versions. No fixture lifecycle,
timeout or production behavior change was made to obtain this result.

All seven identity cases passed in the preceding combined run. Qualification
through the real publication owner, whole-repository checks, CI and production
rollout remain pending. These passing local results do not establish catch-up.

## Validation environment update

The local full unit/mobile process ended without a completion report. A
standalone 1,823-event owner comparison terminated with `Connection terminated
unexpectedly` from its local PostgreSQL client before producing comparative
results. Neither attempt counts as passing evidence. Docker was subsequently
unavailable locally; its socket was absent. The operator directed that local
Docker remain stopped and validation continue through the existing
[GitHub CI workflow](../../../.github/workflows/ci.yml).

Required unit/mobile, native publication-owner and EOF/error regressions remain
merge gates in CI. The standalone comparison remains incomplete; no owner-level
speedup is claimed. Post-release observations must verify actual production
batch work and sustained net drain. No new benchmark runner, workflow, timeout,
retry or production recovery action was added to replace the interrupted probe.
