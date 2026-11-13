# Kafka deletion-batch throughput implementation

Spec: [approved direction and invariants](../specs/2026-11-13-kafka-deletion-throughput-design.md).

User direction: “Fix it” following the recommendation to optimize deletion
batches while preserving publication ownership, order and erasure safety.
Continue in the existing isolated branch; no branch switch/rebase is authorized.
Execution uses sequential implementation and independent safety/quality review.

## Global constraints

No ad hoc production pause, offset reset, ownership recovery, lock change, retention
change, retry, timeout, new dependency or schema change. Use stock SQL/client
batching in `src/metric-stream/clickhouse-sink.ts`. Keep every touched TypeScript
file at most 1,000 lines through ordinary test-table deduplication if needed.
No test exports or helper-only runtime branches. Preserve related workspace edits.
Use the physical workspace Compose wrapper and generated environment for tests.
Never print credentials; prefix commands with RTK. Workers must not delegate.

## Task 1: Reproduce and fix acknowledgement request amplification

Files: `src/metric-stream/clickhouse-sink.ts`, its colocated unit test and its
existing integration test. Existing production exports remain unchanged.

- Add a real ClickHouse fixture with 101 adjacent same-revision V3 deletes,
  actual affected/unaffected rows and per-request native query IDs. Assert the
  correct tombstones and all 101 receipts. Require two acknowledgement reads and
  two receipt writes, with nonempty native QueryFinish evidence for every request.
  Observe RED on existing per-event work. Separately verify exact-ID partial
  redelivery and all-acknowledged replay with no writes.
- Batch acknowledgement lookups for V3 runs using Array(UUID) and bounded
  groups of 100, returning the exact acknowledged IDs. Preserve no-query legacy
  handling and existing V2/V1 behavior; do not expand optional interfaces.
  Preserve native UUID equality when comparing returned canonical IDs with
  valid differently cased UUID inputs; cover actual receipt replay.
- After a deletion chunk succeeds, send its acknowledgement rows in one native
  JSONEachRow command. Acknowledgement write failure still rejects the batch.
- Update/add focused unit behavior tests: partially acknowledged runs, fully acknowledged
  redelivery, a failed second deletion chunk acknowledging only the first 100,
  failed acknowledgement insertion blocking following rows, revision and row
  boundaries. Existing same-file tests may become `it.each` tables to stay below
  the line limit; preserve their exact options, ordering and outcome assertions.
- Run focused unit and real integration suites GREEN; record RED/GREEN commands
  and request counts. Commit the task and push it automatically.

## Task 2: Remove repeated candidate scans in each bounded deletion chunk

Files: same existing sink and integration test; reuse Task 1 interfaces.

- Seed 8,192 current rows for one fresh user/provider with varied external IDs
  and at least 100 disjoint deletion scopes lacking time bounds. Profile the
  actual tombstone INSERT SELECT using native query IDs. Verify final scoped
  deletion and unrelated preservation, and require native read_rows no greater
  than six times the fixture row count. Observe RED from repeated scope scans.
  Use deterministic query/read metrics, not runtime timing thresholds. If native
  table granularity requires a fixture adjustment, explain and verify it before
  weakening a bound; do not disable indexes or change production settings.
- In `markMetricStreamDeleteCommandsInClickHouse`, use one candidate SELECT with
  parenthesised OR scope predicates and one identity-tuple GROUP BY. Preserve
  every scope's AND constraints, the complete latest-row tuple aggregation,
  latest-scope predicate, account fence and revision/version expressions.
- Reuse existing tests for moved latest identities, nullable external IDs,
  cross-route revisions and legacy replay; extend real fixtures where the
  combined predicate needs positive/negative correctness evidence. Include
  `clickhouse-sink-identity.integration.test.ts` and retain its existing pruning
  bound and nanosecond latest-row cases. Add rows before multi-scope deletion to
  cover null/non-null external IDs, inclusive start/exclusive end, overlapping
  matches, latest identities moving out of all scopes or into another scope,
  and unmatched cross-scope pairs (A/X plus B/Y must preserve A/Y and B/X).
- Run focused suites GREEN and record before/after native read_rows, query
  count and exact row/receipt outcomes. Every profiled query must have a nonempty
  QueryFinish record; never allow an empty aggregate to satisfy the read bound.
  Commit and push automatically.

## Task 3: Qualify, document, review and release

Operator validation update: the local standalone owner comparison lost its
PostgreSQL connection and produced no result. The operator then directed that
local Docker remain stopped and validation continue through GitHub CI. Use the
existing CI publication/owner regression suites and post-release production
observations; retain the incomplete standalone comparison as a limitation.
Do not add a replacement benchmark workflow or claim an unmeasured owner-level
speedup. The original intended comparison below is not recorded as completed.

- Qualify a synthetic 1,823-delete run matching the observed batch size, with
  real ClickHouse and the real ownership adapter where feasible. Compare native
  reads/requests and elapsed time against the original source; preserve a clean
  baseline/restoration and identify which boundary the fixture actually covers.
  Preserve and collect the ownership adapter's assigned query IDs rather than
  overwriting them. Run existing publication integration, runtime/consumer and
  owner suites, including late-error and EOF tests.
- Run `pnpm test`, full `pnpm lint`, root/server/web TypeScript checks, spelling
  and `git diff --check`. Integration must load the generated environment for
  its workspace Compose fixture and use the existing native test schema instead
  of replaying historical migrations. The isolated qualification fixture uses
  `.env.deletion-qualification.local`; full lint still uses `.env.local`.
- Add a concise unresolved/fixed incident entry to the production baseline and
  a safe dated receipt containing only operational metadata and synthetic data.
  Cite native receipts and official platform guidance. Do not copy raw payloads.
- Independent reviewer checks actual diff and native evidence, including all
  ordering/failure boundaries and absence of lock/recovery weakening. Correct
  findings and re-review before shipping.
- Open the PR, inspect all feedback, wait for exact-head CI and merge/release
  through the authorized canonical path. No auto-merge or gate bypass.
- After release, confirm all normal replicas/health, fresh live/history commits,
  R2 archive zero lag and measured net drain versus new arrivals. Report actual
  progress and any remaining analytics lock bottleneck; do not declare caught-up
  from a passing build or a single short-window sample.

## Review focus

Partial acknowledgement redelivery; failed tombstone/ack commands; mixed
revisions and rows between deletes; moved/nullable identities; array metadata
and scope bounds; full EOF/ownership safety; deterministic native read metrics.
