# WHOOP BLE collection and upload gap — November 14, 2026

## Scope and conclusion

Read-only investigation on `investigate-ble-collection-gaps`, based on
`cbb93f026ab5e5307a8756c058501b6dc00b6692`. No application behavior, production
configuration, queue, credential, offset or deployment was changed.

The overnight WHOOP heart-rate/raw-record delivery gap is confirmed, but its
complete root cause remains unresolved. Evidence identifies three separate
boundaries: unfinished account cleanup before capture configuration; captured
samples waiting in the native upload queue after backgrounding; and a background
native session starting with no Bluetooth central or collection connection.
These must not be collapsed into a Kafka backlog or a disconnected-strap diagnosis.

## Evidence and timeline

Times below are Pacific Standard Time (UTC minus eight hours). Queries cover
November 13 at 6:48:08 PM through November 14 at 6:48:08 AM unless noted.
Native connection history is persisted and replayed: use `nativeOccurredAt`,
not its later log emission time. Multiple emissions of one native event do not
represent multiple connection attempts. Cleanup operations are grouped by
`operationId`; those logs deliberately have no account attribution.

- **November 13, 10:35:23 PM:** native session starts idle with its central
  uninitialized. At 10:35:24 PM, one cleanup operation records `ble_suspend`,
  `disconnect` and `uploader_bootstrap`. At 10:35:42 PM it reaches
  `uploader_disable` and `store_commit`. No completion for this operation was
  returned in the bounded Sentry log search. These stage logs report native
  release `0c6735b15`; absence of a completion log alone does not prove a crash.
- **November 14, 5:51:03 AM:** another native session starts idle. Cleanup
  suspends capture at 5:51:04 AM. The same operation's next recorded stage,
  `uploader_disable`, is at 6:20:55 AM: an observed 29m51s interval at the
  uploader-bootstrap boundary. It reaches `store_commit`, with no returned
  completion. Time suspended or without execution is included in that interval;
  it is not a measured 29-minute CPU or SQLite operation.
- **6:20:48–6:21:14 AM:** persisted background-refresh diagnostics show a
  task dispatched to JavaScript, then expired and completed unsuccessfully.
  This establishes a missed wakeup budget, not which individual task caused it.
- **6:26:54 AM:** another native session starts. Its cleanup records
  suspension/bootstrap at 6:26:55 AM and completes at 6:27:10 AM, including
  `store_vacuum`. Current-release cleanup logs report `3cdb5f70e`.
- **6:27:10–6:27:11 AM:** the initial queue snapshot is empty. Discovery,
  connection and subscription complete, and the native state becomes streaming.
- **6:27:52 AM:** app-state snapshots change to inactive/background while
  streaming. Native counters show 4,100 received IMU samples and 41 each for
  realtime and raw-record streams. Acknowledged counts are 3,500 / 32 / 32;
  queued counts are 600 / 9 / 9. No upload error or blocked stream is recorded.
- **6:38:11 AM:** a new native session and JavaScript runtime start while the
  app is backgrounded, with a different process ID. The durable queue generation
  is unchanged. Counters now
  show 65,900 received IMU samples and 1,264 each for realtime/raw records,
  with acknowledgments still 3,500 / 32 / 32. Queued counts are
  **62,400 / 1,232 / 1,232**, with three active uploads, no blocked stream and
  no recorded upload error. Newest queued timestamps reach about 6:38:09 AM.
  Thus capture continued after backgrounding and survived recreation in SQLite.
  The new connection state is idle; central state is uninitialized, with no
  observed new connection/restoration/retry event through the searched window.
- **6:48:08 AM backend observation:** ClickHouse contains 32 distinct WHOOP
  heart-rate rows, 29 R-R rows and 32 raw records, with sample times only
  6:27:10–6:27:42.815 AM, stored at 6:32:45 AM.
- **7:00:42 AM follow-up:** the same bounded aggregate, extended through that
  observation, returns the same counts and latest timestamps.

The final native checkpoint proves queued captured data, not its later delivery,
loss, or an entire overnight local history. Queue statistics reset at account
cleanup. There is no retained snapshot here establishing pre-cleanup queue size
or the reason cleanup first became necessary.

## Server attribution and coverage limits

PostHog structured web logs resolve the earlier 16 un-attributed console upload
pairs into 13 IMU batches, one realtime batch and two raw-record batches. Six
IMU batches contain older November 11 samples (29,957 total); seven contain
3,500 current samples. Realtime published 61 metric rows from 32 samples;
raw-record batches published 16 rows each. No failure appears in these returned
upload pairs. This does not cover requests rejected before route telemetry.

WHOOP IMU uses the shared
[IMU route](../../../packages/mobile/modules/whoop-ble/ios/WhoopBleSampleStore.swift)
and [repository](../../../packages/server/src/repositories/inertial-measurement-unit-sync-repository.ts),
which currently writes `provider_id=apple_motion`, `source_type=api` and ignores
`deviceType` for attribution. Consequently the `whoop_ble OR source_type=ble`
ClickHouse query covers WHOOP realtime/raw records, **not every WHOOP IMU row**.
The six historical IMU batches cannot be attributed to WHOOP from stream/bounds
alone. No provenance migration is part of this investigation.

## Current implementation and history review

- [WHOOP session initialization](../../../packages/mobile/lib/background-whoop-ble-sync.ts)
  awaits upload configuration before capture. After its initial flush, it
  returns when the app is not active. Its existing regression explicitly
  expects background initialization to defer discovery until foregrounding.
- [Account cleanup recovery](../../../packages/mobile/lib/whoop-upload-session.ts)
  awaits the persisted cleanup fence before configuration. Native
  [disable](../../../packages/mobile/modules/whoop-ble/ios/WhoopBleModule.swift)
  suspends capture before waiting for uploader bootstrap and purge.
- The Bluetooth central is created lazily by
  [discovery/connect/retry](../../../packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager+Discovery.swift).
  The [app-delegate subscriber](../../../packages/mobile/modules/whoop-ble/ios/WhoopBleUploadAppDelegateSubscriber.swift)
  handles background URLSession events, not Bluetooth launch restoration.
  The delegate has restoration handling, but it requires central creation.
- [Native upload transport](../../../packages/mobile/modules/whoop-ble/ios/WhoopURLSessionTransport.swift)
  already uses file-backed background URLSession, launch events and
  `isDiscretionary=false`. Apple nevertheless makes transfers started while
  backgrounded discretionary; waiting uploads alone cannot prove a defect.
- Git history already includes [#3276](https://github.com/Asherlc/dofek/pull/3276)
  (async cleanup and suspended capture), [#3286](https://github.com/Asherlc/dofek/pull/3286)
  (interrupted cleanup recovery), [#3308](https://github.com/Asherlc/dofek/pull/3308)
  (retry only after configuration), and [#3309](https://github.com/Asherlc/dofek/pull/3309)
  (purge compaction/recovery). Source release `3cdb5f70e` includes the latter
  fixes; `0c6735b15` predates them. Native stage release and OTA asset identifiers
  differ during the window, so release labels alone do not prove every installed
  native symbol. The 6:27 cleanup's `store_vacuum` stage confirms that path ran.
- [MOBILE-2H](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-2H)
  is a handled MetricKit disk-write diagnostic (~1.07 GB) through WHOOP
  disable/checkpoint. [MOBILE-2J](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-2J)
  is a handled CPU diagnostic through HealthKit transport. Neither is proof
  of termination or the cause of a native session restart.
- Main [CI 43562021205](https://github.com/Asherlc/dofek/actions/runs/43562021205)
  and [production release 43564535570](https://github.com/Asherlc/dofek/actions/runs/43564535570)
  succeeded at `cbb93f026`. Backend recovery is separate from phone collection.

## Minimum next step and validation

Recommended implementation scope, **pending user alignment**: restore the
existing native Bluetooth central/connection lifecycle after a successfully
configured authenticated background launch, preserving cleanup and account
fences. Reuse existing native restoration/retry ownership rather than adding
a timer, another uploader, JavaScript drains, or infrastructure. A single call
to retry is not sufficient proof: it can see Bluetooth before powered-on and
return false. Startup must honor readiness and avoid duplicate ownership.

This targets the observed idle background restart; it is not claimed to explain
the entire overnight gap or repair background-transfer scheduling. It trades
additional permitted Bluetooth work for collection continuity. Apple requires
recreating managers for restoration, and relaunch eligibility depends on the
termination reason and current iOS rules.

Before changing behavior, write a failing regression for configured background
startup, asynchronous Bluetooth readiness, retirement/sign-out during startup,
and a background refresh arriving before configuration. Preserve flush without
a strap, account isolation, queue durability and existing reconnect ownership.
Native/bridge changes require their Swift/bridge suites and an iOS build.
On a physical iPhone/WHOOP, validate lock/background capture, system-driven
process recreation, notification resubscription and eventual acknowledgment of
the same queue generation. Test force-quit separately; it has different OS rules.

For the unresolved upload delay, inspect existing task state/completion logs
and actual eventual acknowledgments on that device before changing transport.
For the bootstrap interval, obtain a symbolicated real-device stack/profile
while stalled and per-boundary timing; current stage timestamps do not identify
the blocking SQLite statement, lock, or suspension period. Do not bypass cleanup,
delete the queue, or recommend reconnect/sign-out as a speculative remedy.

## Sources and reproducibility

- [Native cleanup search](https://east-bay-software.sentry.io/explore/logs/?project=4511073386627073&logsQuery=operation%3AdisableUploads&start=2026-11-14T02%3A48%3A08Z&end=2026-11-14T14%3A48%3A08Z).
- PostHog services discovered: `dofek-mobile` and `dofek-web`. Explicit window
  above; mobile returned 825 logs, including 145 WHOOP logs and five capture
  snapshots. Web `sensor-upload` returned 32 logs in 14:26–15:01 UTC.
  Queried only operational attributes; no sensor values, credentials or headers.
- ClickHouse read-only aggregate filters `is_deleted=0`, provider/source as
  above, and either sample or ingestion timestamp after 02:48:08 UTC; groups
  provider/source/channel with `uniqExact(id)` and timestamp bounds.
  Follow-up budget: 15 seconds, one thread, 256 MiB query memory.
- [Apple: Core Bluetooth restoration](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html),
  [relaunch rules](https://developer.apple.com/documentation/technotes/tn3115-bluetooth-state-restoration-app-relaunch-rules),
  and [background transfer discretion](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/isdiscretionary).
- Timestamped operator-local receipts remain under `/tmp/opencode/ble-*`.
  These temporary files are not durable published evidence. This record retains
  their aggregate findings without personal identifiers or sensor values.

## Review and retrospective

Separate self-review checks evidence attribution, native occurrence versus
emission time, MetricKit versus crashes, current implementation/history, and
scope. No independent reviewer was authorized for this diagnostic assignment.
The existing mobile lifecycle/account-cleanup suites passed **36/36** using
`pnpm exec vitest run --project mobile packages/mobile/lib/background-whoop-ble-sync.test.ts packages/mobile/lib/whoop-upload-session.test.ts`.
They confirm current behavior; no failing new regression or real-device
restoration check ran. Full lint/typechecks are unnecessary for this prose-only
change. Local Markdown targets and whitespace are checked before commit.

What worked: combining persisted native events, queue counters and structured
server uploads separated capture from delivery. Investigation needed special
care around replayed history, OTA/native identity and shared IMU attribution.
Proposed runbook improvement for user approval: require these three boundaries
and native-occurrence clocks in the processing-status BLE checklist. The
existing `check-logs` workflow covers server discovery; no new skill or custom
diagnostic framework is needed.
