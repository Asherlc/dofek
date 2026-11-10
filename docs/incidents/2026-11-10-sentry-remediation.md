# Sentry remediation — November 10, 2026

Initial organization-wide [unresolved search](https://east-bay-software.sentry.io/issues/?query=is%3Aunresolved) returned 52 issues over the available 90-day search window. This record tracks every issue; a source fix, a released fix and a verified successful operation are separate claims. Reviewed source starts at `9fcf7cb88`.

## Scope and review gates

The operator approved root-cause groups: analytics ownership, catalogue/queue failures, provider authentication, and mobile. Each behavior change requires a failing regression, the minimum correction, focused verification, diff review, and repository pre-push checks. Resolve only with evidence of recovery or an appropriately qualified release status. Preserve actionable errors, account-erasure ownership, original failures and existing limits.

The operator separately approved controlled analytics recovery after the ongoing [deployment](https://github.com/Asherlc/dofek/actions/runs/42868189291) finishes: stop publishers including web, establish executor/request termination, release only the exact abandoned owner, replay its pending intent, and restore original replicas/images. Follow the [existing recovery boundary](../plans/2026-11-09-erasure-safety-decisions.md#recovery-cutover-and-key-changes); no automatic owner clearance is authorized.

## Issue ledger

Times are UTC. Statuses reflect this working record and must be reconciled with Sentry before completion.

| Issue | Latest event | Group | Disposition and next evidence |
|---|---|---|---|
| [DOFEK-SERVER-83](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-83) | 2026-11-10 17:47 | Analytics ownership | Open — Controlled recovery approved; preserve the pending intent. Shutdown diagnosis remains open. |
| [DOFEK-SERVER-7S](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7S) | 2026-11-10 05:05 | Catalogue theCrag | Open — HTTP 302 transport remains separate from the deployed identity parser correction. |
| [DOFEK-SERVER-7F](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7F) | 2026-11-10 05:05 | Queue lifecycle | Open — Fix implemented with red/green regression tests; pending validation and release. |
| [DOFEK-SERVER-7T](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7T) | 2026-11-10 05:05 | Catalogue OpenBeta | Open — Rejected parent-area response; existing PR #3254 covers partial result retention. |
| [DOFEK-SERVER-7N](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7N) | 2026-11-10 05:05 | Catalogue OpenBeta | Open — Upstream HTTP 502; verify current catalogue replay independently of successful logbook sync. |
| [DOFEK-SERVER-7X](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7X) | 2026-11-10 05:05 | Catalogue OpenBeta | Open — Upstream HTTP 502; verify current catalogue replay. |
| [DOFEK-SERVER-7Q](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7Q) | 2026-11-10 05:04 | Catalogue theCrag | Open — HTTP 302 transport; preserve partial results through existing PR #3254. |
| [DOFEK-SERVER-7W](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7W) | 2026-11-10 05:04 | Catalogue Kaya | Open — Rejected search response; retain raw schema/GraphQL diagnostics before choosing a parser fix. |
| [DOFEK-SERVER-7R](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7R) | 2026-11-10 05:03 | Catalogue OpenBeta | Open — Invalid local-area discovery; inspect actual response and existing PR #3254. |
| [DOFEK-SERVER-7P](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7P) | 2026-11-10 05:03 | Catalogue OpenBeta | Open — Rejected climb response; inspect actual source identity and response. |
| [DOFEK-SERVER-7V](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7V) | 2026-11-10 05:02 | Catalogue Kaya | Open — Rejected authenticated climb details; distinguish credentials from schema rejection. |
| [DOFEK-SERVER-81](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-81) | 2026-11-09 20:35 | Catalogue theCrag | Open — Named-area identity fix merged in #3246; verify deployed parser separately from later redirects. |
| [DOFEK-SERVER-82](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-82) | 2026-11-09 20:34 | Catalogue 8a | Open — Upstream HTTP 429 during catalogue discovery; distinct from successful logbook sync. |
| [DOFEK-MOBILE-2B](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-2B) | 2026-11-09 19:55 | WHOOP native authentication | Open — Background upload HTTP 401 on native build f02798b; verify session invalidation and durable pending batches. |
| [DOFEK-SERVER-70](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-70) | 2026-11-09 19:30 | Provider authorization | Resolved — Resolved after 336 successful Zwift syncs for the affected account, including after the diagnostic. |
| [DOFEK-SERVER-6E](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-6E) | 2026-11-04 10:30 | Provider persistence | Resolved — Resolved after 333 successful Withings syncs; latest success follows the Nov 4 request timeouts. |
| [DOFEK-MOBILE-19](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-19) | 2026-11-04 01:03 | HealthKit transport reporting | Open — Sync-log reporter bypasses existing background transport policy; regression and fix implemented. |
| [DOFEK-MOBILE-27](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-27) | 2026-11-03 20:37 | WHOOP disk writes | Open — Grouped transaction fix already merged; native release and physical-device measurements still required. |
| [DOFEK-MOBILE-1G](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-1G) | 2026-11-03 20:06 | HTTP availability | Open — Mixed historical non-JSON responses including SSL 525; preserve individual causes. |
| [DOFEK-MOBILE-2A](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-2A) | 2026-11-03 19:45 | Native network error | Open — No stack; recover exact operation from event breadcrumbs/native diagnostics. |
| [DOFEK-SERVER-7D](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7D) | 2026-11-03 16:16 | Queue stalls | Open — Historical provider worker stalls; inspect subsequent execution and current lifecycle. |
| [DOFEK-SERVER-7Y](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7Y) | 2026-11-03 15:43 | Operator capacity | Open — 37 GiB currently free on production data disk; verify blocked operator workflow separately. |
| [DOFEK-SERVER-80](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-80) | 2026-11-03 14:47 | Operator Wahoo | Open — Failure followed SERVER-7Z. Routine Wahoo sync recovery does not prove that original file was imported. |
| [DOFEK-SERVER-7Z](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7Z) | 2026-11-03 14:47 | Wahoo FIT decode | Open — Retained FIT decode failure at byte 380170; inspect original bytes before changing decoder. |
| [DOFEK-SERVER-7M](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7M) | 2026-11-03 06:14 | Operator availability | Open — Historical resync stopped at website 503; verify current health and operator state. |
| [DOFEK-SERVER-7E](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7E) | 2026-11-03 05:22 | Database operation | Open — Inspect chained database cause and current image-work claim behavior. |
| [DOFEK-SERVER-7J](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7J) | 2026-11-03 03:33 | Analytics models | Open — Historical partial dbt failure; verify model output and complete replay. |
| [DOFEK-SERVER-7K](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7K) | 2026-11-03 03:16 | Queue stalls | Open — Historical analytics queue stall; correlate current replay and worker lifecycle. |
| [DOFEK-SERVER-6B](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-6B) | 2026-11-03 00:39 | Analytics models | Open — Historical parts/projection failure; verify current models and successful build. |
| [DOFEK-SERVER-7H](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7H) | 2026-11-02 23:14 | Operator Strava | Open — Full-history job failed; latest stored Strava overall sync is still an error. |
| [DOFEK-SERVER-7G](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7G) | 2026-11-02 23:14 | Queue stalls | Open — Historical unrecoverable stalled job; correlate worker termination before closure. |
| [DOFEK-SERVER-7B](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7B) | 2026-11-02 20:38 | Cycling publication | Open — Existing long-history request-body fix; verify current projector has no pending work. |
| [DOFEK-SERVER-7C](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7C) | 2026-11-02 19:54 | Operator prerequisites | Open — Historical CDC command lacked POSTGRES_PASSWORD; inspect current CDC state without exposing secrets. |
| [DOFEK-SERVER-7A](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-7A) | 2026-11-02 17:00 | Investigate | Open — Inspect event and current source. |
| [DOFEK-SERVER-79](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-79) | 2026-11-02 12:01 | Provider availability | Resolved — Resolved after 336 successful eight-a logbook syncs following the HTTP 503. |
| [DOFEK-SERVER-78](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-78) | 2026-11-01 23:02 | Provider Crimpd | Open — Existing verified token-response correction; confirm deployed account connection. |
| [DOFEK-SERVER-76](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-76) | 2026-11-01 19:00 | Provider authorization | Resolved — Resolved after 336 successful theCrag syncs for the affected account. |
| [DOFEK-MOBILE-28](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-28) | 2026-11-01 05:29 | WHOOP startup hang | Open — Asynchronous bootstrap correction already merged; verify signed device runtime. |
| [DOFEK-MOBILE-29](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-29) | 2026-11-01 04:46 | WHOOP disk writes | Open — Grouped transaction fix already merged; synthetic page-write improvement does not prove device recovery. |
| [DOFEK-SERVER-74](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-74) | 2026-10-28 04:04 | Hiking null names | Resolved in existing commit — Deployed repository returned 30 activities with string display names at 18:04 UTC. |
| [DOFEK-SERVER-73](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-73) | 2026-10-28 04:03 | Running null names | Resolved — Deployed repository returned five activities with string display names at 18:04 UTC. |
| [DOFEK-MOBILE-26](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-26) | 2026-10-27 16:36 | Auth response parsing | Open — Non-JSON failure parsed as JSON; red/green fix implemented, pending release. |
| [DOFEK-MOBILE-25](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-25) | 2026-10-27 16:36 | Auth HTTP availability | Open — Maintenance-window 404; verify current endpoint recovery without treating it as invalid credentials. |
| [DOFEK-MOBILE-24](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-24) | 2026-10-26 00:55 | HealthKit cancellation | Open — Existing reporting policy handles this source; validate current runtime. |
| [DOFEK-MOBILE-23](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-23) | 2026-10-25 17:55 | Offline session restore | Open — Existing offline reporting/session-preservation policy; verify current runtime. |
| [DOFEK-MOBILE-22](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-22) | 2026-10-25 17:44 | Lost connection on restore | Open — Source is auth-state-restore; inspect current handling before classification. |
| [DOFEK-SERVER-5K](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-5K) | 2026-10-24 03:32 | Database pool | Open — Historical connection acquisition timeout; verify current pool/request behavior. |
| [DOFEK-SERVER-72](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-72) | 2026-10-24 03:32 | Database pool | Open — Historical climbing connection timeout; verify current requests. |
| [DOFEK-SERVER-71](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-71) | 2026-10-24 03:31 | Database pool | Open — Historical billing/session connection timeout; verify current requests. |
| [DOFEK-MOBILE-21](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-21) | 2026-10-23 23:11 | Native/OTA mismatch | Open — Existing signed rollback and fingerprint compatibility correction; verify installed native methods. |
| [DOFEK-MOBILE-20](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-20) | 2026-10-23 00:56 | Apple sign-in | Open — Native code 1000 alone does not establish root cause; current signed-device reproduction needed. |
| [DOFEK-SERVER-6Z](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-6Z) | 2026-10-22 16:01 | Provider Garmin | Open — Historical permissions 403; verify authorization recovery for the affected connection. |

## Confirmed findings

- **Analytics recurrence:** The retained owner `eb0adc24-d562-4056-af14-1308f688c3b5` was admitted at 16:21:25.259032 UTC with `intent_id=analytics-build`, `quiescent=false`, `query_id=NULL`, `query_terminal=false`, and backend PID 3416350. The backend no longer exists. [Deploy 42853607885](https://github.com/Asherlc/dofek/actions/runs/42853607885) applied the quiesce overlay at 16:26 and verified writers stopped at 16:28. Axiom records the first replacement failure at 16:39:22.427. This establishes interruption during the ownership window; retained logs do not establish the old executor's exact exit signal. Live stop grace is ten seconds. Do not treat absence from `system.processes` alone as recovery proof.
- **Deleted-job logging:** The [worker failure handler](../../src/jobs/worker-events.ts) appends a Redis job log after BullMQ's `moveToFailed` has applied immediate removal. Catalogue jobs explicitly request `removeOnFail: true`. Skip that write only for a known terminal auto-removed job; preserve original exception/application logging and logs while retries remain. BullMQ documents [automatic removal](https://docs.bullmq.io/guide/queues/auto-removal-of-jobs).
- **Provider recovery:** A bounded read-only production query for the affected account found 336 successful overall syncs each for theCrag, Zwift and eight-a, and 333 for Withings in the preceding seven days. Last successes were November 10 at 17:30 UTC. Withings' latest failure was November 4; the other three had none in that window. These successful operations support four closures, without changing authentication or timeout policy.
- **Existing catalogue work:** [PR #3254](https://github.com/Asherlc/dofek/pull/3254) already preserves successful sources during partial catalogue failures, improves diagnostic presentation on both clients, and accepts OpenBeta's observed empty reference. Review and reuse that work without duplicating its implementation. Its partial-result behavior does not prove upstream outages or redirects are fixed.
- **Mobile reporting:** [Auth bootstrap](../../packages/mobile/lib/auth.ts) attempts JSON decoding of a plain-text HTTP error, generating an extra syntax exception. Gate error-body decoding by content type while retaining the HTTP failure. The [HealthKit classifier](../../packages/mobile/lib/health-kit-errors.ts) omits the observed `apple-health-sync-log` source from the existing transport-outcome policy; add that exact source while keeping schema/storage/unexplained errors reportable. See the [reporting policy](../sentry.md#handled-operational-failures).

## Validation and recovery record

- Queue regression first failed because the handler attempted a write for removed jobs; after correction all 37 worker-event unit tests passed. Existing retry/error-reporting cases remain enabled.
- Mobile regressions reproduced the plain-text JSON parse capture and omitted sync-log source. After correction all 148 focused auth, classifier, telemetry and provider tests passed.
- Full lint and root/server/web/mobile typechecks passed. The complete Docker-free run passed 24,301 tests (19 skipped), with zero retries. Focused spelling and diff checks passed. Independent review of the actual queue/mobile diff found no actionable issue. Production recovery remains pending.

