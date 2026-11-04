# Existing-owner successor registration qualification

Scoped source checkpoint **7e15af803efdb3e22054ae0653621ca4e8befe59**, pushed to dull-baboon. Exact BASE **6e2e61a58e2ea4fdc77d1120b11dc8b22c2751af**. This records implementation and engine qualification evidence for the existing-owner request transition only; independent review is pending. **Full Task 2 remains OPEN**, including a separately reproduced load-bearing post-frontier cooperative-replay gap below. No latency, native broker ACK, 350-message deletion, 1001-effect, production, privacy/erasure, CDC, host or R2 gate is closed by this report.

## Contract and review checkpoint

Read the dispatched brief, cost assessment, README/AGENTS/RTK, analytics guidance and executing-plans, TDD, systematic-debugging, integration readiness and verification skills. No CodeGraph index exists; its exploration command confirmed that. Worked inline as the single DB-slot owner. Root owns independent review and subsequent measurement/production gates.

The owner retains only its exact acknowledged query ID and live terminal execution evidence. First registration requires exact resource/owner/admitted intent, nonquiescence, NULL query ID and terminal=true. Successor registration requires that same identity plus the exact locally terminal predecessor ID and durable terminal=false. Both latch uncertainty before awaiting actual UPDATE RETURNING proof. One exact returned identity and a live session are required before dispatch. No broad terminal-state OR was introduced.

A fully consumed successful response or the existing official ClickHouseError classification establishes local terminal evidence; generic transport/parse/client failures remain unknown. Queries still consume result.json() within ownership, command/insert retain synchronous insert settings, and the raw-input adapter was not changed. No CH query, journal scan, receipt verification, phase check or persisted-data observation was removed or cached.

The final terminal UPDATE is required on callback success and known-terminal callback failure. It latches uncertainty before awaiting proof, runs while admission remains closed, and precedes intent clearance/quiescence. A failed final proof prevents outer success even when its PG update committed. Application/server failure stays the primary rejection if finalization also fails; the finalization failure follows the existing Sentry release-error path. Unknown outcomes and unawaited requests cannot release the durable owner. Cleanup waits for real in-flight operations before session/fixture disposal. Zero-query callbacks do not create a synthetic request proof. Receipt mode retains the admitted intent and readonly=1.

**Intentional private promise-boundary change:** a request can resolve while PG still conservatively records its query as nonterminal. A crash loses that executor's local terminal fact. Positive external terminal/executor evidence under Q7 is still required; neither lock availability nor a missing process authorizes recovery. An actual receipt/frontier may commit before final owner flush; failed flush still prevents broker-facing outer success and blocks read-only replay.

Request PG exchanges are N+1 for N>0 and zero for N=0. Three actual serial requests now use four request exchanges rather than six; both write and receipt modes cover 0/1/3 requests and intermediate conservative rows. Lifecycle PG statements are excluded from that request count. No elapsed-time claim follows from this arithmetic.

Only analytics-query-owner.ts, its integration suite, and a separate executor test helper changed. No new durable state/store/schema/lock, dependency, environment variable, production flag/hook, timeout/retry change, recovery shortcut, server/listener or Docker lifecycle operation was added. The child fixture uses existing configuration over IPC and is killed at a controlled execution boundary; it is test infrastructure, not a production mode.

## RED, debugging and GREEN

All engine commands used the existing private runner with one worker, retry zero and bail one, the root-provided unchanged CH 768 MiB and PG 1 GiB runtime, and no ordinary integration-start wrapper. Prefix:

```text
rtk pnpm tsx .superpowers/sdd/2026-11-03-bounded-analytics/run-database-tests.ts
```

Raw command output was redirected into fresh named files. Original logs remain intact; no sanitization or overwrite occurred. All originals were hashed after completion; see owner-successor-evidence-sha256.txt. Logs can contain synthetic native server-error diagnostics from the unchanged SDK; raw bodies/secrets were not printed into this report/tool output. This does not qualify all-log privacy.

- Test-first RED: owner-successor-red.log / owner-successor-red-count.log show intermediate query_terminal=true where the new contract requires false. owner-successor-red-four.log shows actual count 6 versus expected 4 for three real commands.
- First scoped GREEN attempt reached 15 passing cases, then the old uncaught server-error expectation failed: it expected completion error, while the approved contract preserves the original server error and reports the failed final proof separately. The exact blocked durable-row assertions remain; the expectation now matches that explicit contract.
- Expanded attempt reached 19 passing cases, then an unawaited-request fixture returned before registration acknowledged, so its private request correctly rejected closed. The fixture now observes an actual running server request before callback return and awaits that request before cleanup.
- A subsequent run reached 31 passing cases, then the existing lostPostgresLockDoesNotPermitAnotherPublication regression exposed a real implementation omission: callback success could bypass finalization when connectionError was set. Added an unconditional connected-session check for any successful outcome before finalization. The unchanged regression then passed.
- Owner suite GREEN: 43/43, 24.01s, owner-successor-green-owner-final.log. This includes the real late successor insert, both killed-executor cases, receipt/frontier-before-flush failure, row mutation and failure matrices.
- Additional exact-BASE backchecks (temporarily copied source only, no branch switch/rebase): exact successor row mutation incorrectly resolved; the frontier-before-flush test saw null before the old per-request flush; killed executor after consumed response persisted terminal=true instead of the new conservative false; final-flush escaped callback saw serial-request admission rather than closed admission. Each is a named RED original (base-successor/base-frontier/base-crash/base-closed-red.log). These are regression backchecks, not a claim that every expanded control was a new failing feature test before the first implementation edit.
- Candidate source was restored byte-for-byte after each comparison. The saved and restored SHA-256 are both 975dbc3d4671de19f6596a07905b544514d9a57a7621c6eb9f4fe0400f64d30b; owner-successor-restore-proof.log records both restorations.

Canonical combined command:

```text
rtk pnpm tsx .superpowers/sdd/2026-11-03-bounded-analytics/run-database-tests.ts src/db/clickhouse.integration.test.ts src/metric-stream/source-effects.integration.test.ts src/metric-stream/clickhouse-sink-recovery.integration.test.ts src/analytics/analytics-query-owner.integration.test.ts src/analytics/effect-journal.integration.test.ts src/analytics/analytics-work-store.integration.test.ts --retry 0 --bail 1
```

**GREEN 114/114 across 6 files, 61.07s**, owner-successor-green-combined.log. No resource fatal occurred. This retained raw-input fully consumed HTTP success/error/uncertainty cases, source effects, persisted receipt/journal proofs, work-store frontiers, exact transport positions/serialized IDs and existing completed-A/pending-B read-only replay coverage.

Two final additional controls ran separately, after that combined invocation, without production edits:

- finalFlushKeepsEscapedCallbacksClosed: baseline RED, candidate GREEN 1/1, 3.38s, owner-successor-final-closed-green.log. Both escaped query and assertActive reject while the actual final terminal UPDATE is being flushed. Admission is never reopened to finalize.
- zeroRequestFailuresRetainIntentWithoutSyntheticRequestProof: GREEN 1/1, 3.07s, owner-successor-zero-failure-green.log. Write and receipt application failures retain pending intent and quiescence, create zero request proof exchanges, and preserve ingestion time for same-intent replay.

The final owner file therefore contains 45 cases; the entire final 45-case file was not rerun after those two isolated additions. Evidence is the 43-case owner/114-case combined gate plus the two individually executed controls, not a fabricated single 116-case run.

The finite new matrix covers: 0/1/3 request counts in both modes; first/successor precommit and lost committed registration; actual malformed RETURNING rows; exact resource/owner/intent/query/terminal/quiescence mutations at first/successor/final boundaries; changed retained intent in receipt successor/final paths; lost/zero/malformed final proof after both success and server rejection; caught and uncaught definitive errors; application failure, ingestion-time retention and same-intent replay; escaped/closing/unawaited requests; existing session loss before dispatch and during actual late command/input writes; actual running successor insert whose response is lost and whose durable second ID cannot be replaced; real executor SIGKILL after full response and after successor registration but before dispatch; and actual completed receipt/frontier followed by failed final owner proof and blocked receipt replay. Every late CH request and child exit is awaited before fixture cleanup. No automatic recovery is exercised or introduced.

Static/unit checks:

```text
rtk pnpm exec vitest run --project unit src/db/clickhouse.test.ts src/metric-stream/source-effects.test.ts src/metric-stream/clickhouse-sink.test.ts --retry 0 --bail 1
rtk pnpm typecheck
rtk pnpm exec biome check src/analytics/analytics-query-owner.ts src/analytics/analytics-query-owner.integration.test.ts src/analytics/analytics-query-owner-executor-test-helpers.ts
rtk git diff --check
```

Unit command: 32/32 across the two matching unit files (source-effects.test.ts has no matching file); owner-successor-unit.log. Final typecheck exit 0, tsc --noEmit; final Biome exit 0, 3 files/no fixes/warnings; final diff check exit 0/empty. Originals are owner-successor-typecheck-final-controls.log, owner-successor-biome-final-controls.log and owner-successor-diff-check-final.log. Full repository lint/unit/native tiers were not run under this bounded DB-slice handoff; no dependency or ignored check was used to make a failing check pass.

## OPEN: pre-existing known post-frontier cooperative-replay gap

Root identified this source path during the qualification and requested an isolated real-engine repro, not an implementation pivot. coordinateAnalyticsDelivery calls input.assertActive after completeAnalyticsDelivery commits the processed frontier. If that check throws a known cooperative error, the query owner can correctly flush terminal evidence, publish quiescence, and retain pending intent A. Replaying already-processed A takes the receipt-owner path, verifies its actual receipt, and intentionally does not clear the pending intent. Next delivery B then rejects pending intent A. The replay may return broker-facing success while B remains blocked. This is load-bearing Task 2 work, **not accepted partial completion**.

The desired regression privateKnownPostFrontierFailureReplayMustAdmitNextDelivery:

1. Use an isolated createAnalyticsTestContext and actual empty-delivery preparation/commit.
2. Make input.assertActive throw only after loadAnalyticsStreamState reports A processed. The first call rejects the known post-frontier cooperative failure.
3. Assert actual owner state terminal=true/quiescent=true/pending intent present.
4. Re-run the exact A with active callbacks: actual receipt replay succeeds.
5. Expect B to succeed. It instead rejects with the old pending intent and the existing replay-that-intent admission error.

The identical desired-B-success test is **RED on both exact BASE and this candidate**: owner-successor-known-gap-base.log and owner-successor-known-gap-repro.log. Repro source is owner-successor-known-gap-repro.txt. It was inserted solely for the isolated runs and then removed from the committed test suite; no test asserting that stranded A is intended behavior was committed. No row reset, recovery boolean, manual intent clear, new receipt mode or production fix was attempted. Root owns the next scope/approach decision and should promote this desired regression when fixing that gap.

This is distinct from **unknown final flush**: after lost final proof the owner remains nonquiescent and both receipt replay and replacement admission must stay blocked even if PG terminal=true. The committed coordinator regression verifies exactly that intentional fail-closed behavior with a real persisted receipt/frontier.

## Limitations, handoff and retrospective

Exclusive DB slot returned to root after all engine/child/late-query cleanup. No services were started/stopped/restarted, no HTTP server or tunnel was needed, no benchmark or original 350/1001/native ACK workload was run, and no production action occurred. Independent root review remains mandatory before attributed measurements. Human docs and production incident baseline remain root-owned; no human documentation was edited here.

What went well: the original exchange-count RED separated a real PG-roundtrip reduction from unchanged CH/data-proof work; existing session-loss coverage caught the finalization omission. Investigation centered on closing/final proof and the difference between live terminal evidence and persisted-data evidence. Useful next-time context is the private request-promise boundary and the exact known-versus-unknown post-frontier replay state. Suggested working-note improvement for root approval: add a row distinguishing (a) terminal/quiescent pending-A after known post-frontier failure, which must progress through exact A replay to B, from (b) unconfirmed final proof, which must remain Q7-blocked. Reuse executable-database TDD, systematic-debugging, integration readiness and verification-before-completion; no new skill is needed. Keep the private N+1 arithmetic and enlarged external crash-recovery burden explicit in the root review package.
