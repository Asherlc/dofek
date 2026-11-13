# Continue manual Apple Health sync in the background

## Intent and agreed direction

When a person taps Sync, continue the Apple Health operation after they leave
the app where iOS permits it. Preserve acknowledged progress and make unfinished
work resumable after interruption. The user approved this direction on
2026-11-12. This document proposes the concrete implementation for review.

[DOFEK-MOBILE-19](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-19)
records a manual `healthKitSync.pushRunningStepSamples` upload starting before
the app moved to the background and failing with `The network connection was lost` on return.
The current manual pipeline treats that rejection as terminal and has no native
continued-processing lifetime. This establishes the client failure mode, not
the exact native cause of the connection loss or a server outage.

## Approaches

- **Foreground pause/resume only:** smallest change, but postpones work whenever
  the person leaves the app. Rejected in favor of background continuation.
- **Native continued processing with interruption recovery (selected):** use
  Apple's existing execution and progress facilities around the existing sync
  pipeline. Requires Swift bridge changes, lifecycle handling, and a native
  release, but covers both queries and network work.
- **File-backed background uploads:** appropriate for transferring prepared
  payloads while suspended, but does not run subsequent HealthKit queries.
  Replacing this pipeline with an upload spool is unnecessary for this scope.

Apple describes [continued processing](https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados)
as foreground-started, user-initiated CPU/network work with system progress and
cancellation. [Background URLSession](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background)
transfers uploads from files independently of app execution.

## Native lifetime

Extend the existing `modules/background-refresh` Expo module with the small
Apple Health task surface; keep periodic refresh scheduling separate. Use
`BGContinuedProcessingTask` on iOS 26+, preserving the current iOS 16.4 minimum.
Submission follows a foreground Sync/Resume tap and uses `.fail` rather than
queuing a second job behind an operation that JavaScript has already started.
Start HealthKit work only after the native launch handler grants the task.
Registration, submission, and bridge failures surface specific errors; they do
not silently run without the requested background protection.

Keep one manual operation per authenticated account. Native completion,
expiration, bridge teardown, and late JavaScript results must complete a task
at most once. Use the existing module's completion ownership pattern without
introducing a general job framework or another scheduling dependency.

Manual and observer attempts share one account-scoped execution gate, because
both consume the running-step anchor. Hold it while an attempt executes and
release it when manual work pauses or finishes; a paused request does not block
observer work. Keep observer update IDs/types pending in the existing queue
while a manual attempt owns the gate. A delivery is acknowledged only after its
own queued observer processing succeeds, never merely because manual work ran.
Existing native observer expiration still completes callbacks exactly once;
retain the type's catch-up work even if its callback expires while waiting.
Do not extend observer deadlines. The existing
[observer completion contract](../../../packages/mobile/modules/health-kit/README.md#background-observer-completion)
remains authoritative. Test manual/observer overlap with uploads, deletions,
anchor commits, paused manual work, and expired pending observer callbacks.

Report actual completed sync stages to native `Progress` and use the existing
stage descriptions as the system task subtitle. Stage progress describes work,
not estimated record counts or bytes. Observer deliveries never submit a
user-initiated continued-processing request. Apple documents the
[iOS 26 availability, progress, and termination contract](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask).

## Interruption and resumption

Keep one account-bound pending manual request in the existing secure storage:
fixed requested start/end dates, the last fully completed semantic stage, and
whether resumption needs a tap. Store no HealthKit sample payloads, fabricated
anchors, credentials, or duplicate health facts in the checkpoint. Clear it on
success, sign-out/account replacement, and account erasure. The authenticated
app lifetime owns the operation, so navigating away does not cancel it.

Stages follow the existing pipeline: additive/category uploads, each raw
quantity type, workouts/routes, sleep, each clinical type, and running steps.
Advance the checkpoint only after all required work in that stage succeeds.
Resume at the unfinished stage; replay that stage using existing stable sample
identity and upsert/delete behavior rather than persisting array offsets that
could skip changed HealthKit results. Verify replay behavior before relying on
it. Preserve the existing rule that anchored pages commit only after uploads
and deletions succeed. A partial-error stage remains unfinished.

Continue while a native grant is active. If a known transient transport failure
occurs on a request spanning a transition to the background, retain the unfinished stage and
retry once after the app becomes active and connected. If that fresh attempt
fails, surface the error rather than looping. Ordinary active-app errors retain
their existing actionable failure behavior and telemetry.

If HealthKit reports its actual locked-data error, pause and wait for foreground
activation/unlock; do not infer a locked device from background state alone.
Do not claim continued processing overrides
[HealthKit data protection](https://developer.apple.com/documentation/healthkit/protecting-user-privacy).

Native expiration pauses work and requires a Resume tap. Apple uses the same
expiration callback for user cancellation and system expiration, so automatic
restart could override a person's cancellation. A relaunch after process death
also offers Resume rather than silently starting a new native task. The last
unfinished stage can replay; already accepted server records and committed
HealthKit anchors remain intact. Apple documents both cancellation and app-switcher
termination in its [continued-processing lifecycle](https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados).

On supported older iOS versions without this API, retain foreground sync with
explicit pause/resume when leaving the app. This is durable platform behavior,
not a temporary compatibility layer. Do not change the deployment target.

Check interruption/account lifetime before each query, upload, stage checkpoint,
and anchor acknowledgement. Stop scheduling new work on expiration or teardown;
an already accepted upload may finish. Retired operations cannot write a newer
account's checkpoint, report success, or continue uploading after account change.

## Presentation and scope

Use the same manual-operation state on the provider list and provider detail.
Show current progress while running, “Unlock your phone to continue Apple Health
sync” only after the locked-data error, and “Apple Health sync paused” with a
Resume action after native expiration or relaunch. Resume preserves the original
window. Starting a different window explicitly replaces the paused request.
Unexpected server/authentication errors retain their specific message.

Keep progress available after navigation and prevent duplicate manual starts.
Do not report a paused operation as a successful sync or discard its pending
request after degraded output. Native task completion includes required final
sync recording; a logging failure is reported separately without replaying
completed health-data work.

No new server queue, schema, upload endpoint, dependency, retry timer, custom
Live Activity extension, or generalized workflow engine. Browser imports and
server-owned provider sync do not share the iOS execution restriction; inspect
web parity, but make no unrelated web behavior changes. A native app release is
required; an OTA alone cannot add native APIs
([Expo runtime compatibility](https://docs.expo.dev/eas-update/runtime-versions/)).

## Acceptance and review checkpoints

1. Write failing Swift/TypeScript tests for grant-before-work, progress,
   completion/expiration races, unsupported OS behavior, single ownership,
   foreground recovery, and unexpected failures before implementation.
2. Test checkpoint recreation, fixed windows, partial-stage replay, anchor
   acknowledgement, cancellation without automatic restart, sign-out, account
   replacement, and erasure. Use real database tests if replay requires a
   server/query behavior change; do not assume duplicate safety from SQL text.
3. Review the actual diff for minimum custom machinery and existing observer
   behavior; run focused mobile/native tests, mobile typecheck, relevant lint,
   and an iOS build because SwiftPM excludes the Expo bridge files.
4. Use provider list/detail stories for running, paused/Resume, locked, and
   actionable-error states. Verify accessibility and navigation retention.
5. Physical-device acceptance: start a multi-batch sync, background past the
   previous failure window, return, and confirm completion and progress. Repeat
   with lock/unlock, system cancellation, relaunch, and account teardown. A
   simulator build cannot establish real background scheduling correctness.

Implementation names and stage grouping may follow existing production callers;
the behavior, ownership, checkpoint safety, and validation boundaries above are
fixed. Record validation limits in the incident baseline before claiming recovery.
