# WHOOP BLE collection and upload gap — November 14, 2026

## Confirmed background-transfer scheduling limitation

The native background transport is a plausible cause of the observed 6:27 AM
delivery stall, not an established cause of the missing completions. The
confirmed finding is a scheduling-class mismatch for continuous live delivery.
The background `URLSession` transport was introduced
**October 28, 2026, at 10:06 PM PDT** in
[PR #3147](https://github.com/Asherlc/dofek/pull/3147), commit
`cf421b73aaec8e637e2a8085ed2f10490d5a118b`. This changed delivery to file-backed
OS-managed background transfers. Its configuration sets
`isDiscretionary = false`, but Apple explicitly
[ignores that value for transfers started while the app is backgrounded](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/isdiscretionary):
those transfers are scheduled at the system's discretion. This is a delivery
semantics mismatch for continuous live publication, not evidence that the flag
was accidentally enabled.

Authenticated physical-device logs establish the scheduling-class change:

- The app is foregrounded at 6:27:10 AM PST. The uploader's background session
  attaches to process 73130 at the same time as its initial queue snapshot.
- Tasks 1–10, created from 6:27:16 through 6:27:48 AM, are classified
  `non-discretionary`; all ten complete successfully, the last at
  6:27:49.134 AM. This matches the current-sample server upload burst and the
  queue's final acknowledgment counters.
- The app becomes not visible at 6:27:52.716 AM. Tasks 11–13, created at
  6:27:53.930, 6:27:58.953 and 6:28:14.964 AM, are classified
  `discretionary (opt-in: 0)`. None has a recorded completion in the returned
  session history. Native statistics independently show three active tasks,
  queued samples and no upload error.
- At 6:38:10.486 AM the client disconnects as the CPU-fatal report records
  process termination. The same OS session subsequently attaches to process
  73283; the new process is suspended at 6:38:20 AM. Thus the pre-kill delivery
  stall precedes, and is distinct from, the HealthKit CPU termination.

The WHOOP transport is the only background `URLSession` configuration in the
repository's mobile modules. The session's app/process identity, initialization
time, task counts and completion bounds corroborate attribution. OS task UUIDs
are different from persisted batch identities; private log fields do not expose
a per-task mapping to the three individual streams. The precise discretionary
condition delaying each task, such as a particular power/network condition, is
not established and must not be invented. The evidence establishes the forced
scheduling class and the absence of a returned completion, not an HTTP failure
for these three tasks.

The original [durable upload design](../../superpowers/specs/2026-10-28-whoop-durable-upload-design.md)
explicitly accepted eventual OS scheduling, so the complete overnight incident
must not be attributed to a single new merge. Earlier November 3 HTTP 401s and
unfinished cleanup remain separate boundaries. The exact introducing commit of
the background-transfer scheduling choice is now established; changing the
same discretionary flag, adding retries, or increasing timeouts cannot remove
Apple's override.

Candidate correction for continuous live delivery: use ordinary native `URLSession` delivery for
live samples while the BLE collector is executing, and retain the canonical
SQLite reservations/account generations. The existing contract also requires
process-independent delivery, so preserve a background-transfer fallback without
introducing a second outbox or competing batch owners. Simply replacing every background
session would change that existing durability/delivery contract. This is a
native transport change requiring native regression checks and a new iOS build;
it is not part of the already-merged JavaScript collection-start correction.
Separately, reuse one invocation-local formatter in the proven HealthKit CPU
path described below.

The candidate is not a verified remedy for the observed stall. A physical
comparison must first establish whether an immediate native path removes the
wait under the same account/queue conditions. Required validation for a transport
correction: live background capture must
create immediate-path requests and continue receiving server acknowledgments
after locking the phone; reserved batches must survive process recreation;
restored/fallback tasks must reconcile without double ownership; credential
rotation, sign-out and erasure must fence both paths; and failed or malformed
acknowledgments must retain rows. Preserve existing deterministic replay
identities and bounded batching. Physical validation can use existing operational
queue counters and server telemetry rather than more administrator log captures.

Collection notes below describe the observed collector build, rather than
guaranteeing behavior across versions. The
20 MiB capture's ordinary logs started at 9:17 AM; 128 MiB reached only 7:41 AM.
The last authenticated capture retained ordinary logs from 6:20 AM through
10:48 AM. Inspection was filtered to the WHOOP session, known task identities
and Dofek network-control metadata, excluding credential/payload messages.
The broader temporary archives were removed; only filtered operational evidence
and metadata remain outside Git. The user permits no further administrator
authentication. No phone launch, transport retry, queue mutation, instrumentation
profile, production change or runtime fix was performed by this investigation.

### Collector method and primary observations

The collection host was macOS 27.0.1, build `26A434`. The archive recorded
`OSLoggingSupportVersion: 1966.4`, `OSLoggingSupportProject:
libtrace-1966.40.15.0.2` and archive version 6. The initial historical command
was the following; the paired-device name and temporary output path are elided.
It is a record of the completed investigation, not an instruction to rerun it.

```sh
rtk proxy sudo /usr/bin/log collect --device-name '<paired-device>' \
  --last 12h --size 20m \
  --predicate 'eventMessage CONTAINS "app.dofek.whoop-ble.upload.v1"' \
  --output '<temporary-archive>.logarchive'
```

The collector's own output was `Warning: --predicate is ignored when collecting
from attached device`. Its `Info.plist` set each of `PersistSizeLimit`,
`HighVolumeSizeLimit`, `SpecialSizeLimit` and `SignpostSizeLimit` to 20,971,520
bytes. Stock `du -sk` measured the whole archive at 409,848 KiB. These primary
observations establish that the requested predicate was not applied during
device collection and that `--size 20m` was not a 20 MiB whole-archive bound.
The separately named stream-limit fields are why later captures reported their
limits per stream. They do not establish undocumented enforcement details.

After collection, stock `log show --archive ... --style json --info --debug`
applied the exact session/task filters locally. The final capture also included
signposts and Dofek CFNetwork control-plane labels while excluding credential
and payload terms. Archive `OldestTimeRef.WallTime`/`EndTimeRef.WallTime`
metadata established the retained windows quoted above. A shell `EXIT` trap
removed each later broader archive in the same privileged operation. Only
filtered operational results and metadata were inspected; those operator-local
receipts are not raw sensor records or credential evidence.

## Physical-device source attribution follow-up

The subsequent source investigation establishes a cause for the **6:38 AM
process death**, beyond the original MetricKit-only evidence: the phone's raw
`Dofek.cpu_resource_fatal-2026-11-14-063816.ips` explicitly records **Process
killed**, ending at 6:38:10.465 AM PST after 48 CPU seconds over 54 seconds.
The next logged native session starts at 6:38:11 AM. This does not identify the
earlier cleanup trigger or prove why already-submitted URLSession tasks had
stopped acknowledging before the process died.

The installed app build is `1794632551`. Its binary UUID
`616AC45C-8AE7-3690-9EBA-13423284F14E` exactly matches the dSYM from canonical
[release 43558976976](https://github.com/Asherlc/dofek/actions/runs/43558976976)
at `3cdb5f70e`. Stock `atos` resolves the killed process's heaviest application
frames to `HealthKitModule.swift:756`,
`HealthKitQuantitySeriesTransport.swift:37`, and its timestamp formatting at
lines 43–44. The transport constructs a new configured `ISO8601DateFormatter`
for each start and end timestamp of every expanded running-series observation.
Git blame attributes this entire path to **October 30, 2026, 12:04 AM PDT**,
[PR #3144](https://github.com/Asherlc/dofek/pull/3144),
commit `860c1029bb709b5bd144e5c993b7d0317cddf51f`.

A diagnostic benchmark on macOS formatted 10,000 synthetic timestamps with
the existing per-timestamp construction versus one invocation-local formatter.
Elapsed times were 3,497.97 ms versus 14.34 ms, with every output identical.
This supports the direct minimum correction: reuse one formatter within each
transport invocation, retaining fractional seconds and the current time zone.
It does not establish the corrected iPhone CPU budget. Apple also recommends
[reusing configured date formatters](https://developer.apple.com/library/archive/qa/qa1480/_index.html)
instead of constructing and discarding them for each value. No runtime change
has been applied during this follow-up.

Historical read-only backend aggregates also date the **earlier delivery
failure** more precisely: the same account's last normal WHOOP heart-rate
sample was November 3 at 4:45:14 PM PST, stored at 4:45:19 PM. There are no
subsequent stored WHOOP heart-rate rows until the November 14 burst. Sentry
[MOBILE-2B](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-2B) records
all three native upload streams returning HTTP 401 on November 3 at
10:02:43 PM PST in release `f02798b72`; the first events match the queue's
account, as do the later November 11 errors. The native 401 block and recovery
on reconfiguration were introduced by October 28's
[PR #3147](https://github.com/Asherlc/dofek/pull/3147). No main commit occurred
between the last normal delivery and the first 401, so those timestamps do not
identify a newly deployed introducing commit. Session metadata includes an
expiry at November 3, 8:45:07 PM PST, but request credentials were never read;
which session those rejected requests used remains unproven. Do not equate an
observed release label with an introducing commit or call intentional rejection
of invalid credentials itself a defect.

The current physical queue independently confirms 62,400 IMU and 1,232 each
realtime/raw records queued, with last confirmations at 6:27:49 AM for IMU and
6:27:43 AM for the other streams. All three streams retain reservations. The
database and WAL last changed at 6:38:10 AM and remain readable; raw sensor
values and credentials were not inspected. The app is no longer running.
The read-only database copy was checked through aggregate counters only.

At that checkpoint, remaining evidence for the **pre-kill native upload stall** was the system
URLSession daemon's task scheduling/completion history. App telemetry still has
only the five original checkpoints and no recorded upload error for these
tasks. Stock filtered device-log collection requires administrator
authentication and did not run: unprivileged `log collect` requires root, and
noninteractive `sudo` requires a password. No app launch, debugger attachment,
queue mutation, system setting, production change or credential inspection was
used to work around that boundary. The subsequent authenticated capture above
resolved the scheduling-class attribution. The raw device files remain operator-local;
only these derived operational facts are recorded here.

## Follow-up: background collection root cause and correction

The user subsequently requested root-cause analysis and a fix. The reproducible
collection defect is the app-state gate in
[`initBackgroundWhoopBleSync`](../../../packages/mobile/lib/background-whoop-ble-sync.ts):
after configuring uploads and flushing the queue, it returned unless the app
was active. The shared connection function also cancelled discovery/connection
when the app became inactive/backgrounded. A background-launched process could
therefore authenticate and schedule uploads while never creating its Bluetooth
central, matching the observed idle/uninitialized session at 6:38:11 AM PST.

Four regression cases reproduced the defect before production changes: initial
background startup never discovered the strap, and backgrounding during find,
connect or stream setup prevented collection or disconnected it. A fifth
regression showed background refresh could launch native retry during initial
discovery. The correction uses the existing readiness-aware discovery/connect
path regardless of app state and suppresses competing background retry while
that setup owns the connection. Authenticated-session retirement, configuration
failure and native cleanup remain the capture fences. No native API, timeout,
retry timer, transport, storage or production change is required.

This establishes and corrects the background-start collection failure. It does
not establish the original cleanup trigger, explain the bootstrap stage interval,
or prove why the operating system deferred the three queued uploads. Those
remain separate evidence gaps from the original investigation below. A phone
restart's cause is not inferred from MetricKit diagnostics. Physical-device
background restoration and eventual upload acknowledgment remain unverified.

Validation: the focused lifecycle/account/hook suites pass 43/43. The full
unit/mobile tier passes 24,609 tests (19 skipped), and all workspace package
typechecks pass. Repository source/policy lint passed; analytics SQL lint first
failed when local ClickHouse had no disk space. Stock build-cache cleanup freed
0 bytes and unused-image pruning reclaimed 1.532 GB, preserving running
containers and database volumes. Analytics SQL lint then passed without changing
checks, timeouts or source. The separate self-review found no remaining material
scope or correctness issue in the diff. No independent reviewer was authorized.

The following sections retain the original read-only investigation and its
then-pending recommendation; this follow-up describes the implemented correction.

PR review found a remaining ownership window while the initial upload flush
was pending. Two regressions reproduced background retry and foreground reentry
starting discovery before that flush completed. Startup now acquires the same
existing setup guard before flushing and retains it through discovery/connect;
there is no additional flag or retry mechanism. The focused lifecycle/account/
hook suites pass 44/44 after this correction, and mobile typecheck and source/
policy lint pass again. The unchanged unit and analytics SQL checks retain their
earlier successful results; the full mobile tier is rerun for this correction.

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

## Current-build follow-up — 1:30 PM PST

Read-only checks after the user reported another freshness gap separate backend
consumption, current native capture and native delivery. The paired phone has
TestFlight build `1794683328` installed. No app launch, debugger, administrator
authentication or production mutation was used.

At 1:27:19 PM, PostHog's metadata-only `capture_snapshot` records the app
`background`, connection `streaming`, notifications enabled and current sample
watermarks. It reports 508,500 IMU, 5,019 realtime and 9,749 raw records queued;
three uploads are active and no streams are marked blocked. For every stream,
received equals confirmed plus queued. All three last-confirmation timestamps
are about 1:07:11 PM. These are retained operational counters, not sensor values.
They establish current background capture and accumulated native delivery delay;
they do not establish the OS condition preventing individual task completions.

The backend's last observed WHOOP heart-rate/RR sample is 12:44:11 PM, stored
at 1:12:19–20 PM. Retained shared upload telemetry has its latest received and
published events at 1:07 PM; those plain-console events also cover IMU, so they
are not independently attributed per stream. At 1:30 PM the live sink and archive
both reach offset 14,340,223 with zero lag; history and its archive are also
caught up. The earlier growing lag was transient. A successful 510.67-second
dbt build ends just before sink completions resume at 1:12 PM, and read-only
PostgreSQL metadata confirms analytics owns the shared publication resource
during the next build. This is the existing serialization/pacing design, not
proof of a stuck or crashed sink. Preserve its owner, locks and offsets.

The [WHOOP routes](../../../packages/server/src/routers/whoop-ble-sync.ts)
return their acknowledgment after Kafka publication; they do not await analytics
or ClickHouse serving. Consequently, clearing Kafka cannot acknowledge a native
transfer that has not reached that API. The
[uploader](../../../packages/mobile/modules/whoop-ble/ios/WhoopBleBackgroundUploader.swift)
retains one reservation per stream and skips replacement submission while that
identity is active. The existing
[background transport](../../../packages/mobile/modules/whoop-ble/ios/WhoopURLSessionTransport.swift)
therefore remains the relevant candidate for the observed native wait. The
controlled live-path comparison described above is still needed before calling
a transport change a proven remedy.

A second physical CPU-fatal report is conclusive for the new process death:
`Dofek.cpu_resource_fatal-2026-11-14-132722.ips` records **Process killed** at
1:27:17.298 PM, with 48 CPU seconds over 50.55 wall seconds (95% average).
Its build and binary UUID `58F95ACC-6B35-3B7F-BEF9-75AE2D5D40CA` exactly match
[release 43629856022](https://github.com/Asherlc/dofek/actions/runs/43629856022)'s
dSYM. Stock `atos` resolves the hot application stack to
`HealthKitModule.swift:756`, `HealthKitQuantitySeriesTransport.swift:37`
and its start/end formatting calls at lines 43–44: the same formatter path
introduced by [PR #3144](https://github.com/Asherlc/dofek/pull/3144).
A new native process reaches streaming while backgrounded at 1:27:19 PM. This
validates background reinitialization on this launch; it does not prove why the
old transfers had waited since 1:07 PM.

The minimum direct CPU correction remains one invocation-local configured date
formatter, preserving every timestamp string and avoiding shared mutable
formatter state. Validate the existing running-series cases and exact timestamp
outputs, then a native release build and physical CPU-budget comparison. It is
not implemented by this diagnostic follow-up. Treat immediate native live upload
with durable background fallback as a separate, unverified transport correction;
preserve one outbox, reservation ownership, account fences and replay identities.

Two large live SQLite transfers failed near their final chunk. Both incomplete
local copies were deleted without querying them; no counter finding depends on
them. Smaller phone lifecycle metadata and existing PostHog operational logs
supplied the evidence instead. Six-hour Sentry search returned no events, which
did not rule out the physical CPU-fatal report. Proposed runbook refinement:
check existing cloud capture counters and accessible app-specific crash reports
before requesting a broad device archive. No further administrator capture is
authorized or needed for this follow-up.
