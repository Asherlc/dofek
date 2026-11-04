# Task 2 raw input checkpoint

2026-11-04 UTC. **DONE WITH CONCERNS, scoped checkpoint only.**

Source BASE: `aa7d08533c46ff0b1a773de3ad5e163feb4c7186`.
Source commit: `e320e175843e91096a54e8a55483b0ee3de9c3c2`, pushed to `origin/dull-baboon` (remote advanced aa7d08533 → e320e1758; push exit 0).

No branch switch, dependency/env addition, Docker/Compose/production/lifecycle operation, HTTP listener, native-consumer change, registration optimization, or 350-message optimization was performed. Existing private current-schema fixtures and the root-provided pinned ClickHouse/768 MiB and Postgres/1 GiB runtime were used unchanged. Database slot is returned to root after this report; all actual test work settled and fixture cleanup completed.

## Production change and guarantees

`ClickHouseCommandClient.command` accepts optional `values: Readable`. The canonical factory privately routes present input (including an empty stream) through the **same installed official SDK exec**, forcing `http_wait_end_of_query=1`, `send_progress_in_http_headers=0`, `async_insert=0`. It consumes the response, retains no body bytes, requires empty output, and returns no consumed stream. The no-input branch delegates to ordinary SDK command unchanged. Query/insert/close are explicitly bound to the same native instance, not spread from its prototype. Factory unit tests and real-engine fixtures qualify the actual route.

Source-row INSERT uses `input(explicit schema) FORMAT JSONEachRow` for raw values, source ID, timestamps, nullable fields, source version/generation, point and opaque metadata. It creates a fresh stream for each application/replay. Existing namespace wrappers rewrite only SQL and forward payload identity; embedded `analytics.`/`ingest.` words, Unicode, quotes and newlines round-trip unchanged. DateTime64(6/9) expressions, Float32/nullable/vector conversions, signed version above JS safe integer, point normalization/absence, account fence and deleted-row/current-generation conditions remain explicit. The owned ingestion timestamp is unchanged; real owner timestamps have PostgreSQL microsecond precision and are compared through the retained precision-9 parsing expression, rather than claiming arbitrary nanosecond owner-state generation.

**Limited query-text privacy:** account UUID and provider identifier deliberately remain constant parameters and remain visible in retained SQL. All other raw input markers tested are absent from the exact owned INSERT's retained `query` and `formatted_query`. Query IDs, QueryFinish/exception records and read/write/memory/duration observability remain present. This is neither whole-row privacy nor all-log privacy.

No owner behavior changed: its existing command forwarding waits for the private adapter's fully validated result. Unexpected nonempty HTTP 200, response-stream failure and lost response remain generic uncertainty (no fabricated ClickHouseError), retain the first registered ID and pending intent, block second requests/callback success, and block same/replacement intents. Official consumed server errors retain existing terminal-error semantics. Unexpected production errors retain the existing Sentry path; no production error suppression or logger change was introduced.

## Native full-row attempt and root ruling

1. Full-row input with correlated `max(generation)` returned successful empty output but inserted **zero rows** for generation 0 when no generation pair existed. `raw-input-engine-correlation.log` records the executable `stored=[]` failure. The original constant lookup's mapped-value test passed before this candidate.
2. Explicit `coalesce(correlatedScalar,toUInt64(0))` restored empty-set semantics and passed exact data/query-text privacy. It then read **20,002 rows** against 20,000 unrelated generation records plus the exact fixture row/input.
3. `raw-input-engine-plan-select.log` retains the native EXPLAIN: optimizer-generated right ANY SpillingHashJoin; aggregation keys user_id/provider_id; generation PrimaryKey `Condition: true`, all 2/2 parts and 3/3 granules. No whole-table join was authored, but the engine decorrelated into one. This failed the bounded-read assertion.
4. Root explicitly selected constant user/provider parameters with remaining payload fields in the body. Duplicate user/provider body fields were removed. No optimizer flags, materialized whole-table join, unsupported fallback, preflight-only fence, log disable/masking or transport pivot was introduced. The final test enforces bounded read rows below the 20,000 unrelated-row baseline and no join in its actual SELECT plan; same-user/different-provider and different-user/same-provider collision controls also pass. Initial limited-input seven-case evidence measured 1–3 read rows per owned INSERT; that earlier numeric observation is not a new throughput claim or a paired host-budget verdict.

Two diagnostic-query mistakes were corrected without changing production behavior: aliasing `max(read_rows)` back to `read_rows` caused native aggregate alias substitution (`ILLEGAL_AGGREGATION`); EXPLAIN INSERT rejected because this engine supports SELECT for that EXPLAIN mode. Corrected EXPLAIN SELECT produced the retained plan above. Their failed logs remain separately named `raw-input-engine-plan.log` and `raw-input-engine-plan-corrected.log`.

## RED / GREEN evidence

All engine invocations used the existing command prefix:

```sh
rtk pnpm tsx .superpowers/sdd/2026-11-03-bounded-analytics/run-database-tests.ts
```

The runner uses one worker, existing `.env.local`, current private schemas and `TEST_DATABASE_URL`; every invocation below explicitly supplied `--retry=0 --bail=1`. It did not start ordinary integration dependencies.

- Adapter RED: `rtk pnpm exec vitest run --project unit src/db/clickhouse.test.ts --retry=0 --bail=1`; `raw-input-adapter-red.log`: premature command completion observed (`completed=true`, expected false). Five preceding tests passed; bail stopped the remaining cases.
- Initial engine RED: runner + `src/metric-stream/source-effects.integration.test.ts --retry=0 --bail=1`; `raw-input-engine-red.log`: exact mapped fields passed, owned INSERT log `leaked=1` (expected 0). Its first written-row expectation was corrected from 1 to 2 because the existing source-placement materialized view contributes an additional written row; privacy failure remains valid.
- Correlated/default/bounded REDs: same source file and flags; `raw-input-engine-correlation.log`, `raw-input-engine-empty-semantics.log`, `raw-input-engine-plan-select.log` retain the independent empty-generation and bounded-cost failures described above. The corrected plan run additionally used `-t 'insert-time stale'`.
- Final focused units: `rtk pnpm exec vitest run --project unit src/db/clickhouse.test.ts src/metric-stream/clickhouse-row.test.ts src/metric-stream/clickhouse-sink.test.ts --retry=0 --bail=1`; **35/35**, three files, exit 0, 434 ms in `raw-input-unit-green.log` (21 factory/adapter, 3 row mapping, 11 sink).
- Final combined engine GREEN, **single canonical invocation**:

```sh
rtk pnpm tsx .superpowers/sdd/2026-11-03-bounded-analytics/run-database-tests.ts src/db/clickhouse.integration.test.ts src/metric-stream/source-effects.integration.test.ts src/metric-stream/clickhouse-sink-recovery.integration.test.ts src/analytics/analytics-query-owner.integration.test.ts --retry=0 --bail=1
```

`raw-input-vertical-isolated.log`: **45/45 across all four files, 29.72 s, exit 0**. Per-file: recovery 12 tests / 1,016 HTTP / 0 errors; source input 8 tests / 94 HTTP / 0 errors; HTTP adapter 5 tests / 17 HTTP / **2 intentional network-failure observations**; owner 20 tests / 38 HTTP / 0 errors. Total 1,165 observed HTTP requests. No unexpected resource fatal error occurred. HTTP error counts are transport diagnostics and exclude the expected officially consumed SQL rejections.

The final cases cover malformed-input rejection/no write, actual buffered native failure from a 5,000-row input with positive retained read_rows proving work started, successful empty response, unexpected nonempty 200, stream failure, lost response, first-ID/pending-intent retention, same/replacement-intent exclusion, continued requests and swallowed callbacks, source data equivalence, missing/current/stale generation and tombstone allowance, erasure after preparation blocking live/tombstone rows, substantial unrelated history, real sink failure before receipt/frontier publication, and the existing owner/recovery regressions. Native input INSERT is observed in `system.processes` under its persisted query ID before PostgreSQL session termination; all 30 rows subsequently appear, and replacement remains blocked. The ordinary command variant is still tested.

## Qualification mistakes corrected

The initial combined invocation (`raw-input-vertical-green.log`) failed because a new intentional-uncertainty sink case poisoned the shared fixed source resource before another case. Reordering alone (`raw-input-recovery-green.log`) then correctly exposed that the prior definitive failure still retained a pending intent. Both new sink cases now own fresh existing private database/ClickHouse contexts, wait for their actual work, and clean those contexts; no owner reset or application workaround was added. The **final combined** invocation passes without order-dependent fixture state.

The first failed combined bail run also reported next-file `server.listen(): server is already listening` at `early-msw-lifecycle.ts:13`, setup line 8. The clean combined run has no duplicate-listen failure after fixing the originating fixture failure; it is recorded as a secondary bail cascade, not a proven independent lifecycle defect. No shared MSW lifecycle/config/resilience change was made.

The first HTTP fixture incorrectly used the old `onUnhandledRequest` property and a second setupServer. Installed MSW uses `onUnhandledFrame`; it now uses the existing `createIntegrationMswFixture` and never listens/closes itself. The first late-error state assertion incorrectly expected quiescent=false; existing definitive terminal errors correctly leave quiescent=true while retaining intent. The corrected assertion agrees with existing ownership semantics. `raw-input-http-boundary.log` preserves that assertion failure; `raw-input-http-boundary-corrected.log` passed four selected cases with one intentionally unselected diagnostic before the final all-five pass.

## Confirmed OPEN privacy / release gates

A one-time native malformed UInt64 input diagnostic confirmed: exact ExceptionWhileProcessing query-ID record count 1, INSERT query text marker leaks 0, **server exception marker leaks 1**, SDK error message echo true, **default SDK logger echo true**. Final diagnostic output contains only these counts/booleans. Root explicitly scoped this checkpoint to query-text separation and retained all-log handling as Task 7/release work. The steady test asserts required failure/no write/exact query-ID evidence and query-text privacy; it does **not** assert that leaking is desired behavior or silently claim all-log privacy.

The original transient malformed-input RED log contained only synthetic fixture data but default SDK/MSW diagnostics echoed its body. It was overwritten with a sanitized command/code/count evidence record at `raw-input-http-red.log`; **the original raw log is not retained and its original hash was not captured before removal**. No live personal payload was used. Final test captures only the specifically expected synthetic SDK error output, restores the spy immediately, and throws on unexpected output; production logs remain unchanged. No raw response/error bytes are retained by the adapter or emitted in final diagnostic artifacts.

Account/provider identity attribution, server exception/text/query-log erasure, SDK/telemetry copies, metadata-writer barriers, full Task 7 erasure, native consumer/ACK qualification, CDC parity, host/resource/soak gates and archive/bootstrap gates remain OPEN under parent ownership. This patch does not claim 350-message performance, full Task 2 completion or release readiness. Root's earlier 1,001-source qualification was not rerun or reinterpreted. Full repository lint/unit/integration suites and benchmarks were not run; the authorized finite slice above was verified.

## Static checks and review

- `rtk pnpm typecheck`: exit 0, `TypeScript: No errors found`, final `raw-input-typecheck-reviewed.log`.
- `rtk pnpm exec biome check src/db/clickhouse.ts src/db/clickhouse.test.ts src/db/clickhouse.integration.test.ts src/metric-stream/source-effects.ts src/metric-stream/source-effects.integration.test.ts src/analytics/analytics-query-owner.integration.test.ts src/metric-stream/clickhouse-sink-recovery.integration.test.ts`: exit 0, seven files / no fixes, `raw-input-biome-reviewed.log`.
- `rtk git diff --check`: exit 0. Self-review checked explicit SDK binding, absent/present payload routing, no returned exhausted stream, settings override precedence, body-free generic nonempty rejection, timestamp/version serialization, original fences and untouched deletion INSERT SELECT path.
- Initial Biome findings (double type assertions, direct console diagnostics and formatting) were fixed properly: partial typed factory mocks, only structured count diagnostics, expected-specific error capture, no suppressions or rule changes.

Independent review remains a root-owned next checkpoint. Source commit is pushed; report is committed separately after the source checkpoint.

Retrospective: factory and real-engine tests supplied decisive evidence quickly; correlation default/decorrelation and shared pending-intent fixtures required investigation. Next time, carry the installed SDK tag, constant-key generation requirement, query-text-versus-exception scope, current MSW `onUnhandledFrame`/shared-fixture API, and fresh context for intentional Q7 uncertainty into the handoff. Proposed documentation improvement for root approval: add these specific fixture/HTTP-boundary requirements to the integration testing guide or analytics owner runbook. Reuse TDD, integration-tests-ready, systematic-debugging and verification-before-completion; no new skill or human documentation edit was needed here.
