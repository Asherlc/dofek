# Sentry triage — November 1, 2026

Reviewed all 29 issues returned by the organization-wide `is:unresolved`,
30-day search at approximately 15:30–15:37 UTC. Each row below has a latest-event
review, a comparison with current source, and a proposed disposition. Issue
details can include lifetime occurrences while the search counts a time window;
neither count measures lost samples. All issue statuses remain unchanged during
this triage. Implementation and production mutations have not started.

The [live search](https://east-bay-software.sentry.io/issues/?query=is%3Aunresolved)
may change after this snapshot. The reviewed source is commit `320005300`.

## Findings across all 29 issues

Last-event times are UTC. “Fixed in source” and “recovered” describe different
evidence: a deployed correction does not itself prove a successful affected
request. The 15 rows marked **closure review** have an existing correction,
retirement, or observed recovery; the other 14 still need diagnosis, implementation,
or an account action. Closure review is not a claim that all 15 are ready to close.

| Issue | Last event | Evidence and classification | Proposed next action |
| --- | --- | --- | --- |
| [MOBILE-28](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-28) | Nov 1 05:29 | **Active defect.** A 14.2–15-second hang on native release `984572ea4`. Main thread waits for `WhoopBleUploadRuntime.shared`'s lock; thread 12 holds the initialization path while SQLite opens. | Move runtime initialization and background-session attachment off the main thread, preserving one runtime and durable initialization failures. Reproduce with a populated queue before and after. |
| [MOBILE-29](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-29) | Nov 1 04:46 | **Active disk-write investigation.** MetricKit attributes 17,179.875 MB of writes to the sample-store transaction under `submitAvailable`, on `984572ea4`. This release already contains the acknowledgment correction in `1d37be0c5`. | Measure reservation, body-file, append, and checkpoint writes separately with synthetic data. Do not claim the earlier acknowledgment fix solved this event. |
| [MOBILE-27](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-27) | Oct 29 17:42 | **Related disk-write investigation.** MetricKit reports 4,294.973 MB under the append transaction on `cf421b73a`; this is a capture path rather than the later reservation path. | Investigate with MOBILE-29, retaining separate capture/upload measurements and durable-before-return semantics. |
| [SERVER-76](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-76) | Nov 1 15:30 | **Active account prerequisite.** Current official theCrag sync rejects saved metadata that fails its scope/authorization/account-ID contract. Current production has 19 failed overall syncs in the checked window. The event does not identify which metadata field failed. | Reconnect the account with an official personal API key and verify a successful sync. Inspect names/validity only if needed; do not rewrite old identity metadata or invent a key. Investigate repeated scheduling only after confirming the intended reconnect-state behavior. |
| [SERVER-77](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-77) | Nov 1 02:00 | **Closure review: recovered.** Tension omitted empty logbook tables on `ad7ca14e9`; `2eb7ebef0` removes the erroneous table-presence requirement. Nineteen later climbing and overall syncs succeeded. | Close with the deployed fix and post-release sync evidence below. |
| [SERVER-6E](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-6E) | Nov 1 02:00 | **Closure review: same Tension incident.** Its consecutive-failure warning names the identical omitted-table error. | Close alongside SERVER-77; retain the generic consecutive-failure monitoring. |
| [SERVER-75](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-75) | Oct 30 23:30 | **Closure review: obsolete path.** The public theCrag reader received a processing redirect (302). `5796f7a30` replaces that reader with the official personal-key API. | Close the retired public-reader failure with a cross-reference to active SERVER-76; do not claim the current account syncs successfully. |
| [MOBILE-1G](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-1G) | Oct 28 23:28 | **Unresolved, multiple historical causes.** Latest event is a non-JSON HTTP 408 from `healthKitSync.pushQuantitySamples`. Earlier events include maintenance 404s and proxy timeouts. | Correlate each response class with proxy/server request evidence and retained HealthKit progress. Fixing the maintenance response alone cannot resolve this whole group. |
| [MOBILE-19](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-19) | Oct 28 22:28 | **Unresolved transport/reporting gap.** Latest event is a lost connection with source `apple-health-sync-log`, after `4824942a5`. That source does not match the current background classifier's explicit source list. | Trace the actual reporter and retained sync progress. Decide whether this known background outcome should use the existing operational counter; do not treat classification as proof of delivery. |
| [SERVER-74](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-74) | Oct 28 04:04 | **Closure review: fixed in source.** Hiking rejects a null `activity_name` on `9943a1fe7`. `eb918bf3d` accepts null and supplies the activity-type label; an executable database regression covers it. | Verify the affected request on the deployed release, then close. No new schema workaround is needed. |
| [SERVER-73](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-73) | Oct 28 04:03 | **Closure review: fixed in source.** Running pace rejects a null `name` on `9943a1fe7`. `72ed9dc5e` fixes it; the current integration suite retains unnamed-run coverage. | Verify a deployed pace request containing an unnamed run, then close. |
| [SERVER-6T](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-6T) | Oct 27 19:00 | **Closure review: recovered upstream failure.** Mountain Project returned HTTP 503 and an onX maintenance page. Nineteen later overall and climbing syncs succeeded. | Close as recovered upstream maintenance with the observed success window. |
| [MOBILE-26](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-26) | Oct 27 16:36 | **Unresolved maintenance response defect.** Source `auth-bootstrap-error-json` parses a plain-text error response during the same deployment as MOBILE-25. Current `fetchCurrentUser` still tries JSON on every unsuccessful non-auth response. | Define and verify the maintenance HTTP contract and corresponding client handling together; preserve the actual status and actionable error. |
| [MOBILE-25](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-25) | Oct 27 16:36 | **Same maintenance incident.** Auth bootstrap receives HTTP 404 during the documented stop-web/migrate/restart window. Endpoint availability later recovered, but that does not correct the deployment response. | Investigate with MOBILE-26; distinguish maintenance from an invalid session. |
| [MOBILE-24](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-24) | Oct 26 00:55 | **Closure review: reporting correction.** HealthKit route upload was cancelled. The event predates `4824942a5`; current background classification covers this source and final cancellation shape. | Verify reporting on the current mobile runtime, then close the exception-noise issue. Independently inspect persistent delivery failures. |
| [MOBILE-23](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-23) | Oct 25 17:55 | **Closure review: reporting correction.** The explicit offline error predates `4824942a5`; the shared classifier now records that shape as a handled outcome. | Verify current-runtime reporting, then close. Offline classification is not a network repair. |
| [MOBILE-22](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-22) | Oct 25 17:44 | **Insufficient evidence.** Lost connection, no application stack, and filtered source. Background-only classification cannot be assumed. | Recover the operation/source from retained logs or a recurrence before selecting a code change or closing. |
| [SERVER-6X](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-6X) | Oct 24 19:32 | **Closure review: synthetic duplicate removed.** This issue is the diagnostic's manufactured Zepp sign-in exception. `4824942a5` retains lifecycle logs/counters without manufacturing a second exception. Earlier logs show HTTP 303 but do not prove the vendor's rejection reason. | Close the removed synthetic diagnostic; do not claim Zepp account authentication recovered. |
| [SERVER-5K](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-5K) | Oct 24 03:32 | **Unresolved verification of historical DB incident.** Session lookup failed acquiring a `pg-pool` connection on `4179f298c`. It shares the billing/climbing failure window. | Verify current pool metrics and representative timings against the existing SQL corrections. Historical saturation and all sources of contention remain unproven. |
| [SERVER-72](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-72) | Oct 24 03:32 | **Same DB incident.** Climbing query wrapper has nested `timeout exceeded when trying to connect`; this is not evidence of SQL syntax failure. | Investigate with SERVER-5K and SERVER-71; retain the existing origin-aggregation corrections. |
| [SERVER-71](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-71) | Oct 24 03:31 | **Same DB incident.** Billing access lookup has the same nested pool acquisition timeout. | Verify shared DB recovery rather than changing billing query semantics or increasing timeouts. |
| [MOBILE-21](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-21) | Oct 23 23:11 | **Closure review: known incompatible OTA.** JavaScript calls a native collection-notification method absent from the installed binary. The baseline records the signed rollback and subsequent fingerprint compatibility fix. | Verify the current physical-device runtime and method availability, then close. Do not add an optional-method compatibility shim. |
| [MOBILE-20](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-20) | Oct 23 00:56 | **Insufficient native evidence.** Apple sign-in reports `ERR_REQUEST_UNKNOWN`, native code 1000, on runtime 1.11. The native domain is filtered; the code alone does not identify credentials, entitlements, or an Apple outage. | Reproduce on a current signed physical-device build and retain safe native error/callback context. |
| [SERVER-70](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-70) | Oct 22 16:01 | **Closure review: historical Garmin denial.** HTTP diagnostic for the permissions 403; SERVER-6Z reports the same request. The October 24 baseline later verifies a successful reconnect and saved Health/Activity permissions. | Close the historical connection failure after confirming that the recorded successful reconnect covers the affected account; do not equate authorization with webhook delivery. |
| [SERVER-6Z](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-6Z) | Oct 22 16:01 | **Closure review: same Garmin denial.** The callback's error follows successful token exchange and identity lookup. New safe stage diagnostics already exist. | Review/close with SERVER-70; no speculative OAuth endpoint or scope change. |
| [SERVER-6W](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-6W) | Oct 21 14:30 | **Closure review: retired provider.** AllTrails HTTP 403 diagnostic for the same interactive verification failure as SERVER-6V. `7868f6ac7` removes this provider. | Close as retired functionality; do not restore or bypass the vendor challenge. |
| [SERVER-6V](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-6V) | Oct 21 14:30 | **Closure review: same retired AllTrails incident.** Explicit human-verification rejection. | Close alongside SERVER-6W. |
| [SERVER-6S](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-6S) | Oct 16 06:00 | **Closure review: recovered upstream failure.** Polar sleep endpoint returned HTTP 500. Nineteen later sleep and overall syncs succeeded. | Close as recovered upstream error with the observed success window. |
| [MOBILE-1W](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-1W) | Oct 8 05:00 | **Insufficient evidence.** Native fetch timeout, no application stack, filtered source. | Recover operation context before applying source-specific handling. Age alone does not establish resolution. |

Current-source checks: [runtime initialization](../../packages/mobile/modules/whoop-ble/ios/WhoopBleUploadRuntime.swift),
[sample transactions](../../packages/mobile/modules/whoop-ble/ios/WhoopBleSampleStore.swift),
[upload submission](../../packages/mobile/modules/whoop-ble/ios/WhoopBleBackgroundUploader.swift),
[theCrag prerequisites](../../src/providers/thecrag/provider.ts),
[board completion handling](../../src/lib/aurora-board-client.ts),
[running](../../packages/server/src/repositories/running-repository.ts),
[hiking](../../packages/server/src/repositories/hiking-repository.ts),
[background transport classification](../../packages/mobile/lib/health-kit-errors.ts),
[shared classification](../../packages/telemetry/src/handled-failure.ts),
[auth response parsing](../../packages/mobile/lib/auth.ts), and
[provider lifecycle diagnostics](../../src/lib/provider-diagnostics.ts).

## Production evidence collected in this triage

The running worker's OCI revision is
`320005300c32024572a3978b1560f2f60030aaa9`, with image digest
`sha256:b0466ea84b9bd85fcfd253367119648a4cf916c2f52011a941cbf13fc038a748`.
Read-only Swarm inspection found worker 1/1 and web 2/2.
[Release run 41277052040](https://github.com/Asherlc/dofek/actions/runs/41277052040)
has successful server-stack and OTA jobs but a failed iOS Deploy Check, with
archive/upload skipped. Sentry records the server release deployed at
06:14:16.591 UTC. The newest observed mobile issue release is `984572ea4`;
successful server deployment is not proof of a matching native upload.

Following the [Postgres diagnostic procedure](../../deploy/README.md#postgres-statement-diagnostics),
the following query ran inside `BEGIN READ ONLY`, with a 10-second local
statement deadline, and ended with `ROLLBACK`. It returns no account identities,
credentials, health records, or upstream payloads:

```sql
SELECT provider_id, data_type, status, count(*) AS runs,
       min(synced_at) AS first, max(synced_at) AS last
FROM fitness.sync_log
WHERE synced_at >= '2026-11-01 06:14:17+00'
  AND provider_id IN ('tension', 'thecrag', 'polar', 'mountain-project')
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
```

| Provider | Rows observed for each listed type/status | First–last overall sync, UTC |
| --- | --- | --- |
| Tension | 19 successful `climbing_activity`; 19 successful `sync` | 06:30:23.892–15:30:27.066 |
| Mountain Project | 19 successful `climbing_activity`; 19 successful `sync` | 06:30:52.968–15:30:41.592 |
| Polar | 19 successful rows each for `sleep`, `exercises`, `daily_activity`, and `sync` | 06:30:03.734–15:30:03.542 |
| theCrag | 19 failed `sync` rows | 06:30:19.793–15:30:23.912 |

These are aggregate observations across the selected providers, not per-account
recovery proof. Bounded worker logs also showed theCrag's reconnect-required
message throughout the current worker lifetime. Tension success is established
by persisted sync results, not merely the absence of new Sentry events.

## Implementation direction proposed after triage

1. Address the WHOOP startup lock first. Preserve a single owner and error
   propagation while moving database opening, schema/index work, and runtime
   attachment off the UI callback path. Test concurrent creation and background
   completion ordering with slow initialization. Apple's guidance explicitly
   recommends avoiding immediate main-thread file I/O:
   [file-system performance](https://developer.apple.com/documentation/foundation/improving-performance-and-stability-when-accessing-the-file-system).
2. Measure and reduce WHOOP write amplification using the existing SQLite
   implementation. Append currently commits per notification; reserve stores
   bodies and updates sample reservations, and submission writes a file-backed
   body. The samples stack is causal evidence for the affected path, not a
   measurement of each operation's contribution. Preserve transaction durability,
   exact acknowledgments, and account erasure. Use Apple's
   [disk-write investigation guidance](https://developer.apple.com/documentation/xcode/reducing-disk-writes)
   and SQLite's [WAL/checkpoint documentation](https://www.sqlite.org/wal.html).
   Do not lower synchronous durability or buffer uncommitted samples as a shortcut.
3. Verify existing fixes and recovered incidents before changing Sentry statuses.
   Reconnect theCrag through its documented
   [official key flow](https://www.thecrag.com/en/article/logbookreadapi).
   The user supplies the account key through the application, not chat.
4. Investigate maintenance HTTP behavior, remaining HealthKit transport evidence,
   and current DB timings as separate groups. Their unknowns do not justify
   retries, larger timeouts, or broad error suppression.

No new dependency, schema migration, production restart, or resilience setting
is proposed by this triage. No regression tests were run in this documentation-only
pass; references to prior tests describe checked-in coverage and the linked
historical validation records, not fresh execution.

## Retrospective

Live MCP access, the second native thread, historical incident records, and
read-only sync history produced useful distinctions between shared failures,
implemented corrections, and observed recovery. The main investigation gap is
physical-device write profiling and current-runtime verification for older
mobile errors. The original CI token's 403 cost an avoidable access investigation.

Proposed runbook additions, for review: document MCP OAuth as the first triage
access path, inspect every relevant thread in a hang, and record provider success
windows before closing provider failures. Reuse systematic debugging, production
log inspection, the loading-performance runbook, and native performance profiling
for the corresponding follow-up groups. Existing instructions were sufficient
for the fix gate; a standard per-issue evidence/disposition table would make
future sweeps easier to audit.

Related records: the [October 27 sweep](../production-incident-baseline.md#2026-10-27--sentry-sweep-verified-analytics-recovery-other-causes-remain-open),
[October 23 database investigation](../production-incident-baseline.md#2026-10-23--postgres-connection-timeouts-and-slow-calendar-requests),
[empty-board fix](../production-incident-baseline.md#2026-10-31--empty-aurora-family-logbooks-incorrectly-fail-sync),
and [Garmin reconnect evidence](../production-incident-baseline.md#2026-10-24--garmin-reconnect-succeeds-while-the-provider-summary-contradicts-sync-history).

## Approved implementation follow-up

After approval, Sentry confirmed eight resolved status updates: SERVER-77,
SERVER-6E, SERVER-6T, SERVER-6S, SERVER-6W, SERVER-6V, SERVER-75, and SERVER-6X.
Each activity entry records the deployed correction, retirement, or observed
recovery used for closure. A fresh 30-day unresolved search returned 21 issues.
The original triage table above remains the historical pre-implementation snapshot.

The branch contains startup correction `982cef3a8` and grouped-notification
commit `0358f3e30`. The latter reduces synthetic SQLite page writes while
preserving durable-before-return capture. These changes have not yet established
physical-device recovery, so the WHOOP issues remain open. The
[incident baseline](../production-incident-baseline.md#2026-11-01--whoop-notification-streams-committed-in-redundant-transactions)
records measured scope and validation limits.

### Validation follow-up

- Root and server TypeScript checks pass. Focused provider/worker/escalation suites
  pass 221 tests with retries disabled; user-status suites pass 28 web and eight
  mobile tests. Strict SwiftLint, focused Biome/spelling, and the production import
  boundary check pass (148 modules, 390 dependencies).
- The complete standalone native suite passes 199 tests. After restoring the
  Infisical session, canonical Expo prebuild succeeds and the real UIKit/Expo
  bridge result bundle reports **Passed: 8, Failed: 0, Skipped: 0**.
- The initial bridge build printed an error-looking `SwiftCompile` console line.
  It was stopped prematurely; its structured build record had no failed tasks
  and its test result was cancelled/unknown. The same test command resumed against
  existing output with unchanged settings and passed. Console wording alone did
  not establish an Expo compiler defect; no SDK workaround was introduced.
- The first complete Docker-free test run returned 23,828 passes, 17 failures,
  and 19 skips across 1,459 files. Its ten failing suites were
  `cdc-health-state`, `check-ota-manifest`, `collect-clickhouse-ci-diagnostics`,
  `dependency-cruiser-command`, `exact-versions`, `integration-diagnostics-reporter`,
  `stack-service-image`, `archive-erasure`, `early-msw-setup`, and `garmin-dump`.
  Failures were deadlines, missing child-runner events, or timed-out child status;
  the Garmin parser explicitly exceeded its unchanged ten-second child deadline.
  A focused rerun passed six suites, then all four remaining suites passed
  sequentially (42 tests), without source or deadline changes. A direct repeat of
  the malformed-config CLI returned its expected status in 364 ms. Host load
  readings exceeded 130 during validation, but these observations do not identify
  every initiating resource constraint. The final complete run,
  `pnpm test --maxWorkers 1 --retry 0`, passed **23,845 tests across 1,457 files**,
  with 19 tests skipped in two files, in 814.54 seconds. No source, assertion,
  test deadline, CI setting, or runtime resilience setting changed for that run.

The provider reporting correction is commit `60d80dbcb`. User-facing failed-sync
states and the existing persistence escalation remain intact. No application
release or physical-device performance recovery is implied by these local checks.
