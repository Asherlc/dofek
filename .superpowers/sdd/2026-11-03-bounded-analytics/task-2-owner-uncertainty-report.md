# Task2 owner unknown-outcome correctness checkpoint

**DONE_WITH_CONCERNS:** the scoped correctness fix passed its engine suite;
full Task2, native ACK and resource qualification remain open.

BASE `38e6f84ff`. Source checkpoint
`b86fe246c744231d37a9ca7be6e872bcbff4a4dc`, committed and pushed to
`origin/dull-baboon`; this report follows separately. Provider protocol source
is unchanged during its independent review. Root-owned human docs are excluded.

## Cause and fix

The existing request executor correctly retained `query_terminal=false` after a
generic client error, but its finally block cleared `inFlight`. A callback could
catch that error and issue another request. The next request overwrote the
uncertain query ID, and its success could incorrectly establish quiescence. A
callback that simply swallowed the error could return success and clear the
pending intent despite the unknown request outcome.

`analytics-query-owner.ts` now checks its existing private terminal state before
request registration/dispatch and before callback success can clear the intent.
An unknown outcome rejects both paths with an actionable verified-recovery
error. The first query ID, `query_terminal=false`, pending intent and
`quiescent=false` remain intact. The same helper serves write and read-only
owners. No public recovery flag, new state column, SQL, extra PostgreSQL request,
retry, timeout, cap or registration optimization was added. Definitive official
`ClickHouseError` handling is unchanged.

## Test-first evidence

The new parameterized engine test starts an actual synchronous local ClickHouse
INSERT that emits 30 rows over a deliberately long server request. It observes
that exact persisted query ID in `system.processes` before injecting a generic
client-boundary response error. The callback catches it and either attempts
another owned command or returns a success value. The test checks rejection,
exactly one dispatched ID, unchanged durable owner state, and blocked admission
for both the same intent and a replacement. Its finally block awaits the actual
server request before database cleanup. The 30 inserted rows are verified, and
replacement remains blocked after that late write completes. This is an actual
late-write proof, not an assertion based on process absence or a mocked database.

An additional control catches a real definitive server rejection and then
successfully reads `7` through the same owner. The fix does not classify every
rejection as an uncertain request.

All logs are in this plan workspace. Engine invocations use the existing private
runner, one worker, `--retry 0 --bail 1`; root released the DB slot after its
40-delivery measurement. No runtime lifecycle or production actions occurred.

| Command / evidence | Observed result |
| --- | --- |
| `rtk proxy pnpm tsx .superpowers/sdd/2026-11-03-bounded-analytics/run-database-tests.ts src/analytics/analytics-query-owner.integration.test.ts -t caughtUnknownOutcomeBlockssecond --retry 0 --bail 1` | **RED**, `owner-uncertainty-second-red2.log`: second request succeeded rather than rejecting (`secondCaught` undefined), 1 failed / 8 skipped, 6.19s. Actual late request was awaited before cleanup. |
| Same runner/file with `-t caughtUnknownOutcomeBlockscallback --retry 0 --bail 1` | **RED**, `owner-uncertainty-return-red.log`: returned `{value:'swallowed failure'}` instead of an error, 1 failed / 8 skipped, 6.13s. |
| Same runner/file without a case filter, `--retry 0 --bail 1` | **GREEN 10/10**, `owner-uncertainty-green.log`, 12.99s, 30 observed HTTP requests, no resource fatal. Includes cooperative handoff, pending-intent timestamp retention, PostgreSQL session loss, uncertain-response blocking, both new continuation regressions, definitive rejection/replay/continuation, read-only receipt protection and late-write/session-loss blocking. |
| `rtk proxy pnpm typecheck` | Passed, `owner-uncertainty-typecheck.log`. |
| `rtk proxy pnpm exec biome check src/analytics/analytics-query-owner.ts src/analytics/analytics-query-owner.integration.test.ts` | Passed with no fixes, `owner-uncertainty-biome-checkpoint.log`. |
| `rtk proxy git diff --check` | Passed before commit. |

An initial misspelled case filter (`caughtUnknownOutcomeblockssecond`) selected
zero cases; `owner-uncertainty-second-red.log` retains that skipped-only run. It
is not counted as RED/GREEN evidence. The corrected filters above ran before any
production change. The final runner exited0 and no test worker remained; each
actual late request had already completed before its fixture was dropped.

This slice is verified through its full real-engine owner suite. It does not
claim a project-wide unit/integration pass, native ACK qualification, general
crash recovery or a resource/throughput pass. Root's local query-log candidate
remained active; limits and source fixtures were unchanged.

## Self-review and remaining work

- Removing the request-admission check makes the second-request case fail;
  removing the callback-finalization check makes the swallowed-return case fail.
  Both checks are needed even when a caller catches the new guard error.
- The error is checked before query-ID registration and after the existing
  in-flight callback check. Legitimate in-flight requests retain serial-request
  behavior; heartbeat/session checks can still observe the original active
  owner without admitting another ClickHouse request.
- Definitive server rejection remains terminal, preserving cooperative replay
  and same-owner continuation. Unknown completion remains operator-recovery
  work even after this fixture independently observes the late write finish.
- Source changes are limited to the owner and its colocated integration suite.
  No schema, dependency, environment or diagram changes were needed.
- Atomic guarded query registration/roundtrip reduction is deliberately absent
  and requires its own review. The unchanged provider1001-effect test remains
  OPEN at its original30-second deadline; it was not retried here. Provider
  protocol review fixes, protected-index bootstrap/erasure, native adapter/ACK,
  Task5 execution and host/resource gates remain separate mandatory work.

Retrospective: preserving a durable uncertain state was insufficient without
guarding both request admission and callback finalization. Observing a real
server request before losing the client boundary exposed both paths clearly.
Future owner changes should retain this two-boundary regression and the explicit
late-request cleanup pattern in the test runbook. Systematic-debugging, TDD and
verification-before-completion remain the useful skills for similar changes.
