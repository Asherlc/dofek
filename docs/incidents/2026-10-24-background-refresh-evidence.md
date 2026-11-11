# Background-refresh diagnostic validation evidence — October 24, 2026

These retained command excerpts support the
[incident baseline](../production-incident-baseline.md#2026-10-24--added-retained-native-background-refresh-diagnostics).
The raw log names identify the captured local transcripts. Absolute workstation
paths are omitted; the app path in the signature output is replaced with
`<Release simulator app>`. No sensor samples, account identifiers or credentials
are included.

## Local validation before the main merge

Source: `dofek-background-refresh-full-tests.log`. The captured command disabled
retries and ran both Docker-free test projects:

```text
$ vitest --project unit --project mobile --run --retry=0
 Test Files  1325 passed | 2 skipped (1327)
      Tests  20482 passed | 19 skipped (20501)
   Start at  16:39:06
   Duration  760.78s (transform 445.68s, setup 772.24s, import 2120.21s, tests 1723.63s, environment 1231.56s)
```

Focused command output captured before the complete run:

```text
pnpm exec vitest run --project mobile packages/mobile/modules/background-refresh/index.test.ts packages/mobile/lib/background-refresh-diagnostics.test.ts packages/mobile/lib/mobile-account-purge.test.ts packages/mobile/app-tests/_layout.cleanup.test.tsx
 Test Files  4 passed (4)
      Tests  47 passed (47)

swift test --package-path packages/mobile/modules/background-refresh
 Executed 47 tests, with 0 failures (0 unexpected) in 2.386 (2.448) seconds
```

Source: `dofek-background-refresh-full-lint.log`. Full lint includes analytics SQL;
its SQLFluff stage finished after three existing large-file skip warnings naming
`activity_route_identity.sql`, `activity_sensor_summary_rows.sql`, and
`deduped_activities.sql`:

```text
$ pnpm lint:sandbox && pnpm lint:analytics-sql
All dependency versions are exact.
Checked 3647 files in 24s. No fixes applied.
Review scenario coverage passed with 6 web and 6 mobile scenarios.
=== [dbt templater] Project Compiled.
All Finished!
```

Sources: `dofek-background-refresh-spellcheck.log` and
`dofek-background-refresh-boundaries.log`:

```text
$ cspell --no-progress
CSpell: Files checked: 2869, Issues found: 0 in 0 files.

✔ no dependency violations found (1862 modules, 7021 dependencies cruised)
```

## Signed Release simulator build

Selected fields from `dofek-background-refresh-build-result.json`, produced from
the completed Xcode result bundle:

```json
{
  "actionTitle": "Build \"Dofek\"",
  "destination": {
    "architecture": "arm64",
    "deviceName": "iPhone 17e",
    "osVersion": "26.5",
    "platform": "iOS Simulator"
  },
  "errorCount": 0,
  "errors": [],
  "status": "succeeded",
  "warningCount": 128
}
```

The direct build command exited 0, as captured by its command runner. The
result JSON above independently records success and the warning/error counts;
it does not establish physical-iPhone scheduling or BLE recovery. Inspection of
all 128 warning records found zero source references to the background-refresh
native files.

Source: `dofek-background-refresh-final-codesign.log`, from strict recursive
verification of the final app:

```text
<Release simulator app>: valid on disk
<Release simulator app>: satisfies its Designated Requirement
```

Read-only inspection of the same built app returned the following output from
`lipo -archs`, then `PlistBuddy` queries for `UIBackgroundModes` and
`BGTaskSchedulerPermittedIdentifiers`:

```text
x86_64 arm64
Array {
    bluetooth-central
    fetch
}
Array {
    com.dofek.accelerometer-refresh
}
```

A subsequent incremental build for the native threading review stopped in the
EXConstants script because the operator omitted an existing build prerequisite:

```text
EXPO_PUBLIC_SENTRY_DSN is required to configure native Sentry.
```

The corrected invocation supplies the same nonsecret example DSN used by the
earlier successful build. See [PR 3070's native build checks](https://github.com/Asherlc/dofek/pull/3070/checks)
for validation of the reviewed native edits. No production setting, repository
configuration or new environment variable was added for this repair.

The [UserDefaults reference](https://developer.apple.com/documentation/foundation/userdefaults)
describes immediate updates to the in-memory value and asynchronous disk writes.
Consequently, retaining metadata in UserDefaults does not guarantee that the
last disk write survives abrupt process termination.

## Validation after merging main

Source: `dofek-refresh-merge-tests.log`. This is the changed unit/mobile tier
after merging main, rather than a second complete-suite run:

```text
$ vitest run --changed origin/main --project unit --project mobile --retry=0
 Test Files  174 passed (174)
      Tests  2970 passed (2970)
   Start at  17:57:33
   Duration  23.84s (transform 15.80s, setup 16.11s, import 68.73s, tests 52.68s, environment 50.96s)
```

All four merged-main typecheck commands exited 0, captured by the command runner.
The logs preserve minimal or silent compiler output; the exit status is not
printed in those log files:

| Scope | Captured log | Complete stdout/stderr content | Captured exit status |
| --- | --- | --- | --- |
| Root | `dofek-refresh-merge-root-typecheck.log` | `$ tsc --noEmit` | 0 |
| Server | `dofek-refresh-merge-server-typecheck.log` | Empty | 0 |
| Web | `dofek-refresh-merge-web-typecheck.log` | Empty | 0 |
| Mobile | `dofek-refresh-merge-mobile-typecheck.log` | `$ tsc --noEmit` | 0 |

Source: `dofek-refresh-merge-lint.log`. The command exited 0. The same three
SQLFluff large-file warnings remained:

```text
$ pnpm lint:sandbox && pnpm lint:analytics-sql
All dependency versions are exact.
Checked 3648 files in 6s. No fixes applied.
=== [dbt templater] Project Compiled.
All Finished!
```

[Hosted CI run 40148771601](https://github.com/Asherlc/dofek/actions/runs/40148771601)
was still running when checked. The read-only `gh run view` result was:

```json
{
  "conclusion": "",
  "headSha": "af3abe5e4d44c2e7c8dc7dfce281dc33fa6caae4",
  "status": "in_progress",
  "updatedAt": "2026-10-25T01:00:29Z"
}
```

These local checks do not assert a completed hosted CI result, a TestFlight
rollout, or production delivery of the new native diagnostic events.

After the threading review fix, the changed unit/mobile tier passed 127 tests
across nine files (`dofek-refresh-review-tests.log`), the Swift package passed
47 tests (`dofek-refresh-review-swift-tests.log`), and strict SwiftLint passed
for the two edited native files. The command runner also captured exit status 0
for full lint and root/server/web/mobile typechecks. UIKit and Expo files remain
outside the SwiftPM target; the signed iOS build separately compiles those files.

## Executed Axiom query

The following read-only query was executed against the live `dofek-logs` dataset
with `axiom query --format json --no-spinner`, emission bounds
`--start-time 2026-10-24T08:00:00Z --end-time 2026-10-25T08:00:00Z`, and the literal
placeholder `ACCOUNT_ID`. The command runner captured exit status 0; stdout in
`dofek-refresh-axiom-query.json` was `[]` and stderr was empty. This verifies that
the complete published query parses and executes against the dataset schema.
The placeholder intentionally matches no account; this is not evidence of
diagnostic delivery or an account-specific event count.

```apl
['dofek-logs']
| where ['service.name'] == 'dofek-mobile'
| extend d = ['attributes.custom']
| where tostring(d['event']) == 'native_background_refresh_event'
| where tostring(d['userId']) == 'ACCOUNT_ID'
| extend eventId = tostring(d['eventId'])
| summarize arg_max(_time, d) by eventId
| extend nativeAt = todatetime(d['nativeOccurredAt'])
| where nativeAt >= datetime(2026-10-24T08:00:00Z) and nativeAt < datetime(2026-10-25T08:00:00Z)
| project nativeAt, emittedAt=_time, nativeEvent=d['nativeEvent'], taskId=d['taskId'],
    nativeSessionId=d['nativeSessionId'], processId=d['processId'], success=d['success'],
    reason=d['reason'], backgroundRefreshStatus=d['backgroundRefreshStatus'],
    lowPowerModeEnabled=d['lowPowerModeEnabled'], earliestBeginAt=d['earliestBeginAt'],
    errorDomain=d['errorDomain'], errorCode=d['errorCode'], errorDescription=d['errorDescription'],
    historyOverflowCount=d['historyOverflowCount'], diagnosticAccountProvenance=d['diagnosticAccountProvenance']
| sort by nativeAt asc
```

The earlier wildcard form returned API 400,
`Cannot group and aggregate on the same field: _tmp15`. The corrected form uses
an explicit metadata argument to
[`arg_max`](https://axiom.co/docs/apl/aggregation-function/arg-max).
