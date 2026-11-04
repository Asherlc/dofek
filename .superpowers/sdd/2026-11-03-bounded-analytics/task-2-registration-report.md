# Same-Q7 atomic request registration checkpoint

**DONE_WITH_CONCERNS — scoped implementation verified, ready for review.**
BASE `2b141dfa3`; source checkpoint
`c75b77dbaa170820e123c3f3074a1a953ee500b1` is committed and pushed.
Intervening root documentation `bd432d7b9` is separate from the two source files
in this slice. No root human docs were staged. Owner uncertainty, provider fix1
and private legacy fixture had already passed their independent scoped reviews.
Full Task2 and its performance/resource/release gates remain incomplete.

## Change and preserved boundaries

An owned request previously awaited active SELECT → registration UPDATE → active
SELECT → terminal UPDATE. Its admission did not compare the exact pending intent
or terminal predecessor; updates did not prove an affected row. The earlier
unknown-outcome guard also became uncertain only after registration returned,
so a committed PostgreSQL registration with a lost response could be caught and
followed by another request or callback success.

`analytics-query-owner.ts` now:

- Captures the exact admitted `intent_id` from the existing owner-admission
  `RETURNING` row, including receipt mode's retained pending intent.
- Checks local closed/session-error and previous unknown-outcome state before
  request admission. It sets local uncertainty **before awaiting registration**.
- Registers with one atomic guarded UPDATE RETURNING: exact resource, owner,
  nonquiescent state, admitted intent (`IS NOT DISTINCT FROM`) and terminal
  predecessor. It requires exactly one affected row and exactly one returned
  owner/intent/query identity, then checks local session state before dispatch.
- Uses one shared guarded terminal UPDATE after the fully consumed successful
  response or official definitive `ClickHouseError`. This checks exact resource,
  owner, query, admitted intent, nonquiescent and nonterminal state, and validates
  the affected/returned row. Only then, after another local session check, does
  local uncertainty become terminal.

There are **two PG exchanges per ordinary owned CH request**: registration and
completion. Session/advisory lifecycle, queued cooperative handoff, serial
in-flight admission, public active checks, callback-finalization uncertainty
guard and operator-recovery requirements remain. No journal, manifest, receipt,
raw, frontier, checkpoint or broker-ACK boundary was omitted or moved. There is
no new schema/state store, recovery boolean, retry, limit, timeout, batching
strategy, dependency or environment variable.

The registration-to-dispatch distributed gap remains uncertain until verified
operator recovery if its executor is lost. Neither this atomic statement nor
an absent process grants takeover authority. Zero-row or unknown PG exchanges
fail closed; they do not publish quiescence or clear another pending intent.

## Actual test-first evidence

All logs live beside this report. Tests use a local facade around the real
checked-out pg session and delegate actual SQL through it; no module mocks or
fabricated DB results. Failure injection occurs only around real query
responses or actual row mutations. ClickHouse requests are real. The facade
recognizes exchange boundaries for injection; assertions inspect actual
dispatch, durable rows and results rather than SQL substrings.

Engine command prefix for all runs:

```sh
rtk proxy pnpm tsx .superpowers/sdd/2026-11-03-bounded-analytics/run-database-tests.ts src/analytics/analytics-query-owner.integration.test.ts
```

| Suffix / log | Observed result before implementation |
| --- | --- |
| `-t oneOwnedRequestUsesTwo --retry 0 --bail 1` / `registration-exchange-red.log` | **RED1**,15 skipped: actual one-request PG calls were4 rather than2 (3.26s). |
| `-t lostCommittedRegistration --retry 0 --bail 1` / `registration-lost-response-red.log` | **RED1**,15 skipped: callback caught the lost committed response, continued and returned `'swallowed registration failure'` rather than rejecting (3.15s). |
| `-t registrationRejectsChangedAdmittedIntentForwrite --retry 0 --bail 1` / `registration-zero-row-red.log` | **RED1**,18 skipped: changed actual pending intent did not block request admission (3.09s). |
| `-t terminalUpdateRequiresExactIntentAftersuccess --retry 0 --bail 1` / `registration-completion-red.log` | **RED1**,18 skipped: changed actual pending intent did not prevent successful completion (3.11s). |

After the fix, the same runner without a case filter and with `--retry 0 --bail 1`
passed **19/19**, `registration-owner-green.log`,12.83s,34 observed HTTP requests,
no resource fatal. Runner38187 exited0, cleanup completed and no test worker
remained. Root's exclusive DB slot was returned; no subsequent DB run was made.

The nine added cases cover:

1. One real owned request uses exactly two checked-out-session PG exchanges.
2. A committed registration followed by a lost response cannot dispatch a
   second request, return callback success, clear the intent or replace the
   first query ID. Actual durable state remains nonterminal/nonquiescent and
   same-intent replay is blocked.
3. Changed admitted intent blocks dispatch for both write and receipt owners;
   the failed registration leaves actual rows/IDs untouched.
4. Completion requires the exact intent after both successful CH response and
   definitive server rejection; zero-row proof cannot become terminal locally.
5. Registration cannot replace a durable unterminated predecessor query.
6. A real PostgreSQL backend termination after committed registration is
   observed through the actual session error event before dispatch, which stays0.
7. An overlapping owned request is rejected as nonserial while the first can
   still finish and the owner can complete cooperatively.

Both two-mode items contribute two cases each. The existing ten owner cases also
pass: pending-intent timestamp retention, queued cross-stream handoff, real PG
session loss, uncertain CH outcomes, caught unknown continuation/return while
an actual late insert completes, definitive-error replay/continuation, receipt
read-only protection and late-write blocking after lost PG session. Actual late
requests are awaited before fixture database removal.

Other verification:

- `rtk proxy pnpm typecheck`: passed, `registration-typecheck.log`.
- `rtk proxy pnpm exec biome check src/analytics/analytics-query-owner.ts src/analytics/analytics-query-owner.integration.test.ts`:
  passed with no fixes, `registration-biome-checkpoint.log`.
- `rtk proxy git diff --check`: passed before source commit.

This is the complete focused real-engine owner suite, not a claim that all
project unit/integration suites ran. Root's matched local query-log candidate
remained active; no Docker lifecycle, image, global setting or cap changed.

## Measurement boundary and self-review

The prior attributed root baseline remains
`sink-roundtrip-pg-baseline.json`:40 accepted synthetic sink API deliveries,
13880.67ms,1400 CH calls,6479 checked-out-client PG calls,40 visible output rows.
It excludes broker/source/native ACK throughput and does not qualify the host.
This slice proves4→2 PG exchanges for one owned request; it does **not** claim a
new40-delivery latency/rate,3679-PG measurement, reduction in35 CH calls per row
or whole-host throughput. Root owns the finite post-review measurement.

Self-review: the two removed SELECTs are replaced by predicates in the same
statement that registers the next query. The exact admitted intent is captured
for receipt owners, rather than inferred from an absent input field. Both
successful and definitive-error paths share exact terminal proof; local state
cannot become terminal if the completion exchange is lost or matches zero rows.
Unknown registration is latched before its await, so callback catches cannot
reopen the admission path. No public API was added for the test facade, and no
existing durability traversal was simplified to achieve the count reduction.

The original1001-effect and350-delete workloads/deadlines remain OPEN and were
not rerun. They require review and root-scheduled post-change validation. Two
legacy cases remain unrun after that350 timeout. Native adapter/ACK,
bootstrap/readiness/erasure barriers, Task5 execution and host/resource gates
remain mandatory; fullTask2 is not complete.

Retrospective: the attributed call count identified an avoidable exchange pair,
but the real lost-registration-response test also exposed an independent unsafe
local-state boundary. Keeping actual SQL/response failure tests beside the
roundtrip count made that distinction reviewable. Future ownership work should
test registration and completion responses separately and reuse TDD,
systematic-debugging and verification-before-completion.
