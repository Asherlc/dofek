# Exact cooperative completed-intent retirement — fix round 1

Source checkpoint **aa6a05e4454307793d11b58def597ca212a67277**, pushed to dull-baboon. Exact BASE **c616f5790ae7a5413dbfda43bde4ee7e76617e12**. Mandatory carry-forward fix round **1/5**, awaiting root's independent whole-fix review. The known cooperative replay gap is implemented and its desired progress regression is GREEN; **full Task 2 and all other parent gates remain OPEN**.

The Important finding was: **Known post-frontier failure can strand pending intent A after successful replay of A, blocking B.** Its original desired-B-success repro was RED on both the predecessor BASE and successor implementation; see [owner-successor report](task-2-owner-successor-report.md), owner-successor-known-gap-repro.txt and both original gap logs. This report records the approved same-owner correction, not uncertain-owner recovery.

## Binding contract and implementation

Read the dispatched cooperative-intent brief, assessment and owner-successor review. The root ruling refines the unreleased internal receipt contract: unrelated pending B must never be cleared by A replay, while freshly verified completed A must be able to finish a known cooperative handoff. Unknown request/executor state still requires the existing external Q7 proof. No new mode or strategy was selected.

The existing specialized receipt-owner callback now must return Promise<{ completedIntentId: string }>; its public result is Promise<void>. Void/no-op callbacks are invalid in the types and runtime schema validation. There is no compatibility fallback, success boolean, minimum-query heuristic, branded token or arbitrary public clear method. Generic lifecycle tests now use write ownership or explicit failed receipt verification; none fabricate a matching verified result merely to retain an old test.

The sole production verifier remains coordinateAnalyticsDelivery. It computes the unchanged canonical identity once using stream plus metricStreamPositionIdentity(position), uses it for write admission, and returns it from receipt replay only after a fresh processed-frontier check, complete exact receipt traversal, and final transport-active check. All prior domain observations and CH queries remain. The result's string identifies the subject of the trusted verifier's proof; it does not independently authenticate that proof. The generic owner does not import journal/domain logic and cannot detect arbitrary callback fabrication. The canonical production callback and real-engine regressions establish that domain obligation.

The owner separately retains its captured admitted intent in all registration/final-terminal predicates. After rejecting in-flight/unknown requests, confirming the final exact terminal query proof, and confirming active ownership, successful receipt verification may retire only a non-null captured intent equal to the verified completed intent. Initially null or unrelated B skips retirement and preserves ingestion time. Matching retirement uses one guarded PG UPDATE RETURNING on exact resource, owner, admitted intent, nonquiescence, terminal state and exact current query identity (NULL comparison included). Exactly one returned owner/query identity with intent NULL is required.

Before awaiting retirement, the existing local terminal/release latch becomes uncertain. Only validated RETURNING plus a connected session restores it. Precommit failure, zero rows, malformed proof, lost response or session loss rejects and prevents outer success/quiescence. A response lost after actual commit can leave intent NULL, but nonquiescence still blocks write and receipt admission. There is no retry, owner reset or inference from process absence. Retirement does not change ingested_at, stream ownership, frontiers, raw data or CH receipts.

Production edits are confined to analytics-delivery.ts and analytics-query-owner.ts. Test changes add a focused coordinator suite, extract the existing real PG session facade into a shared test helper, tighten old generic receipt controls to the required verifier contract, and strengthen the existing completed-A/pending-B sink replay with direct pending-intent/timestamp observations. No schema/store/lock, environment variable, dependency, domain runtime import in the owner, production test hook, timeout/retry change, service operation, listener, transport setting change or recovery shortcut was introduced.

## TDD and investigations

All engine commands used the root-granted exclusive DB slot, unchanged CH 768 MiB/PG 1 GiB overlays, existing private runner, one worker, retry zero and bail one. No normal integration-start wrapper, Docker/Compose command, production action, broker, 350/1001 workload or benchmark was run. Originals were captured under fresh names, preserved without sanitization/overwrite, then hashed; see cooperative-intent-evidence-sha256.txt. No secrets or raw bodies appear in this report. Existing SDK configuration WARN and intentional synthetic native error diagnostics remain visible in the original engine logs; these are not warning-free engine runs. Static Biome cleanliness is a separate result.

The promoted progress regression uses real complete receipt/frontier observations and canonical replay, with no owner reset. It covers Kafka offset 9007199254740993 and qualified Pulsar coordinates above 2^53, then admits B at the next exact position. New RED cooperative-intent-progress-red.log (before production edits) shows A replay still retaining A instead of NULL; the earlier preserved original regression independently reached B's actual pending-intent admission rejection. The current final GREEN reaches B success and observes no repeated A preparation/control/application/effect acknowledgment. Retirement-uncertainty RED cooperative-intent-retirement-red.log also shows the old callback incorrectly succeeding instead of reaching/failing guarded retirement.

Exact RED command forms:

```text
rtk pnpm tsx .superpowers/sdd/2026-11-03-bounded-analytics/run-database-tests.ts src/analytics/analytics-delivery.integration.test.ts -t knownPostFrontierFailureReplaysAThenAdmitsB --retry 0 --bail 1
rtk pnpm tsx .superpowers/sdd/2026-11-03-bounded-analytics/run-database-tests.ts src/analytics/analytics-delivery.integration.test.ts -t retirementUncertaintyBlocksAllAdmission --retry 0 --bail 1
```

First coordinator GREEN: **19/19, 11.28s**, cooperative-intent-delivery-green-initial.log. Expanded owner/coordinator attempt passed 65 cases then exposed a fixture timing mistake: session termination happened before new receipt-owner admission, correctly preserving the former quiescent state rather than creating an uncertain admitted owner. Moved the test termination after the actual admission UPDATE returned, so it exercises the requested admitted pre-proof window. Focused owned-proof failures then passed **4/4, 4.50s**, cooperative-intent-proof-failure-green.log.

The owner/coordinator/sink recovery checkpoint passed **85/85 across 3 files, 46.84s**, cooperative-intent-focused-green.log. This retained all 45 owner cases and the existing sink replay boundary while adding actual observation of B's unchanged intent and ingestion time during A-only replay. The eventual coordinator suite has 30 finite cases.

Later finite controls exposed two further fixture problems; no production behavior was relaxed:

- Session loss immediately before retirement correctly rejected with PG's actual message, Client has encountered a connection error and is not queryable. The assertion originally matched only retirement/session and was widened to include connection. The actual uncertainty/persisted-state requirements were retained. cooperative-intent-combined-green.log records that failed assertion plus secondary already-listening MSW suite-start failures after bail. No MSW/production lifecycle change was made.
- The receipt in-flight fixture requested max_block_size inline while readonly=1 was enforced. CH rejected code 164, Cannot modify 'max_block_size' setting in readonly mode. cooperative-intent-final-failures-green.log retains this error and its unhandled fixture rejection. A combined attempt was launched before fully inspecting that focused failure and reproduced the same fixture error in cooperative-intent-combined-final.log; this was redundant failed evidence, not independent verification. Removed the fixture's setting, attached and checked the real request outcome immediately, and always awaited it in finally before fixture cleanup. Production readonly/protocol settings were unchanged. Isolated corrected control: **1/1, 6.77s**, cooperative-intent-inflight-green.log.

An early typecheck caught an implementation-edit placement error (value referenced outside callback scope), cooperative-intent-typecheck-initial.log; corrected before the first engine GREEN. A Biome single-letter test variable error was fixed by renaming it descriptively. Final typecheck/Biome checks pass without suppression. No resource fatal occurred in any attempt, and no cap/deadline/retry increase or blind resource retry occurred.

## Final verified gate

```text
rtk pnpm tsx .superpowers/sdd/2026-11-03-bounded-analytics/run-database-tests.ts src/analytics/analytics-delivery.integration.test.ts src/analytics/analytics-query-owner.integration.test.ts src/metric-stream/clickhouse-sink-recovery.integration.test.ts src/analytics/effect-journal.integration.test.ts src/analytics/analytics-work-store.integration.test.ts src/db/clickhouse.integration.test.ts src/metric-stream/source-effects.integration.test.ts --retry 0 --bail 1
```

**Exit 0, 7 files / 146 tests passed, 77.07s**, cooperative-intent-combined-verified.log. This is one actual complete final invocation, including all 30 coordinator and 45 owner cases plus sink recovery, journal, work-store, raw input adapter and source effects. No test remained RED/skipped by an intentional code change, and no resource fatal or MSW startup failure occurred in this final invocation.

The coordinator cases cover exact A replay to B progress in both transports; no pending intent with unchanged time/frontier and no CH mutations; unrelated canonical B across epoch/topic/partition/transport with unchanged B timestamp; missing empty receipt/discovery, missing nonempty payload, wrong native serialized identity, freshly deficient frontier and final transport failure; exact resource/owner/intent/query/terminal/quiescence retirement predicates; precommit/lost committed/malformed retirement proof; session loss before retirement and after committed retirement; void/no-op verification result at runtime and the required callback type; actual running in-flight read-only receipt request with settled cleanup; lost registration/final completion proof; admitted pre-proof session loss; and definitive server rejection without falsely authorizing retirement.

Retained owner regressions cover late unknown actual server writes (including successor/native-input cases), exact first/successor/final proofs, live executor SIGKILL, closing, readonly enforcement and ingestion-time replay. Existing completed-A/pending-B sink behavior still passes, now with direct PG observations between A-only replay and B completion. No fixture clears/resets an owner to bypass Q7.

```text
rtk pnpm exec vitest run --project unit src/db/clickhouse.test.ts src/metric-stream/clickhouse-sink.test.ts --retry 0 --bail 1
rtk pnpm typecheck
rtk pnpm exec biome check src/analytics/analytics-delivery.ts src/analytics/analytics-query-owner.ts src/analytics/analytics-query-owner.integration.test.ts src/analytics/analytics-delivery.integration.test.ts src/analytics/analytics-query-owner-test-helpers.ts src/metric-stream/clickhouse-sink-recovery.integration.test.ts
rtk git diff --check
```

All exit 0. Units **32/32 across 2 files, 483ms** (cooperative-intent-unit.log); full TypeScript tsc --noEmit (cooperative-intent-typecheck-verified.log); Biome 6 files/no fixes/warnings (cooperative-intent-biome-verified.log); diff check empty (cooperative-intent-diff-check.log), and the staged diff was also checked before commit. cooperative-intent-exit-statuses.json records commands, observed tool exit statuses and named outputs, rather than treating a text-only tsc log as independently proving its exit status. Full repository SQL lint, native tiers and performance workloads were not run under this bounded handoff.

## Handoff, limitations and retrospective

The exclusive DB slot was returned to root after the final gate and all child/real-request cleanup. Source checkpoint is pushed; this evidence checkpoint follows separately. Root owns independent review against c616f5790, production/human-doc updates, native ACK, performance/350/1001, host resources, CDC, storage/restore, privacy/erasure, R2 and final Task 2 acceptance. Those holds remain unchanged. No full parent completion is claimed.

What went well: the two-axis matrix (processed A versus captured pending intent A/B/NULL) led to a small finalization-only correction, and actual PG lost-response tests kept retirement as strict as query finalization. Investigation was concentrated in fixture timing and readonly constraints; those exposed guard enforcement rather than a reason to weaken it. Useful next-time context is that a completed verifier result is a trusted domain callback contract, not independently authenticated identity proof. Proposed working-note refinement for root approval: state that contract and require the A/A, A/B, A/NULL and uncertain-owner matrix whenever receipt replay changes. Reuse executable-database TDD, systematic-debugging, integration readiness and verification-before-completion; no new skill or framework is needed. The predecessor's enlarged external crash-recovery burden remains explicit and unchanged.
