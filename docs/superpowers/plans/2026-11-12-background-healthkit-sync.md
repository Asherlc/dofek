# Background HealthKit Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete user-started Apple Health sync in the background and preserve unfinished work safely.

**Architecture:** Extend the existing native background module, checkpoint semantic sync stages, and let an authenticated app-owned controller own manual sync. Manual and observer attempts share execution ownership; screens observe the same operation.

**Tech Stack:** Existing Expo Modules, Swift BackgroundTasks, React Native, SecureStore, Vitest, XCTest.

**Spec:** [Approved design](../specs/2026-11-12-background-healthkit-sync-design.md).

**Qualification (2026-11-12):** Implementation, code review, automated checks, browser-story inspection, and the current-head Release Simulator build are complete. Physical iPhone background, lock/unlock, cancellation, relaunch, and account-teardown acceptance remain unverified. A native binary release is required; no merge, deployment, or production recovery is claimed. See the [incident qualification](../../production-incident-baseline.md#2026-11-12--manual-apple-health-sync-fails-across-backgrounding-unresolved) and [Expo runtime compatibility](https://docs.expo.dev/eas-update/runtime-versions/).

## Global Constraints

- Use `BGContinuedProcessingTask` on iOS 26+, preserving the current iOS 16.4 minimum.
- Native task submission follows a foreground Sync/Resume tap; `.fail` submission strategy; await launch before work.
- One manual operation per account; manual and observer attempts serialize together; paused manual work releases ownership.
- Native expiration and process recreation require an explicit Resume tap; never restart a cancelled task automatically.
- Persist only account-bound request window, semantic stage, and resumption metadata. Keep samples in HealthKit/server and anchors native.
- No new queue, dependency, server endpoint/schema, retry timer, custom Live Activity extension, or generalized workflow engine.
- Check account/interruption ownership before each side effect; purge request state on sign-out/replacement/erasure.
- Work in the current branch and workspace. No recursive delegation. Write failing tests first, report RED/GREEN evidence. Commit only verified task changes and push every commit automatically.
- Prefix shell commands with `rtk`. Any HTTP server must have `/Users/asherlc/bin/paseo-quick-tunnel <port>` for its lifetime; report only its emitted `https://…trycloudflare.com` URL.
- Repository guidelines and approved spec govern details. Report architectural uncertainty before changing approach.

## Review Focus

- Late native grant after expiration/teardown cannot start stale work (Task 1).
- A partially successful stage cannot advance its checkpoint or skip remaining records (Task 2).
- Old-account async completions cannot overwrite or clear a new request (Task 3).
- Observer callback expiry while waiting does not discard its type's catch-up work (Task 3).
- Navigating list/detail during manual sync does not create a second owner (Task 4).

### Task 1: Native continued-processing lifetime

**Files:** Existing `packages/mobile/modules/background-refresh/{index.ts,src/BackgroundRefreshModule.ts,ios/BackgroundRefreshModule.swift,ios/BackgroundRefreshAppDelegateSubscriber.swift,Package.swift,README.md}`, `packages/mobile/app.json`; create focused Swift coordinator/adapter files and colocated tests under this module as needed.

**Interfaces:** Expose through module `index.ts`:
- `startHealthKitSync(taskId: string): Promise<{ supported: boolean }>` resolves only on native launch; older iOS resolves unsupported without submitting.
- `updateHealthKitSyncProgress(taskId: string, completed: number, total: number, message: string): void`.
- `completeHealthKitSync(taskId: string, success: boolean): void`.
- `addHealthKitSyncExpirationListener(callback: (event: { taskId: string }) => void): EventSubscription`.
- Use permitted task identifier pattern `com.dofek.app.healthkit-sync.*`, separate from periodic refresh, with each submitted identifier suffixed by its unique taskId. Register each exact request identifier once under iOS 26's continued-processing registration exception. Preserve taskId correlation across all native transitions. See Apple's [request identifier contract](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtaskrequest/init(identifier:title:subtitle:)) and [registration contract](https://developer.apple.com/documentation/backgroundtasks/bgtaskscheduler/register(fortaskwithidentifier:using:launchhandler:)).

- [x] Write Swift lifecycle tests for launch gating, rejection, expiration before grant, duplicate completion, teardown, and late launch. Write bridge tests for correlation and unsubscribe.
- [x] Run `rtk proxy swift test --package-path packages/mobile/modules/background-refresh` and `rtk proxy pnpm test:mobile -- packages/mobile/modules/background-refresh/index.test.ts`; record expected new behavior failing before implementation.
- [x] Implement Foundation-testable completion ownership and thin iOS 26 adapter inside existing module. Register appropriately per current Apple guidance; do not queue work after `.fail` rejection, invent background execution guarantees, or reuse periodic task IDs.
- [x] Make native progress reflect completed work; complete tasks at most once, reject abandoned pending starts, and surface specific failures. Keep existing refresh listener independent.
- [x] Rerun focused tests, `rtk proxy pnpm --dir packages/mobile typecheck`, and inspect config diff. Use iOS build during final integration to compile excluded bridge files.
- [x] Commit/push verified changes; report interface differences and exact checks before review gate.

### Task 2: Fixed-window staged sync and checkpoint storage

**Files:** `packages/mobile/lib/{health-kit-sync.ts,health-kit-sync-types.ts,health-kit-running-steps-sync.ts}` and matching tests; create `health-kit-manual-checkpoint.ts` with `health-kit-manual-checkpoint.test.ts`.

**Interfaces:**
- `ManualHealthKitCheckpoint` contains `requestId`, `userId`, fixed `startDate`/`endDate`, `nextStage` semantic identifier, and `requiresResume: boolean`.
- `loadManualHealthKitCheckpoint(userId: string)`, `saveManualHealthKitCheckpoint(checkpoint)`, and `clearManualHealthKitCheckpoint(userId: string, requestId: string)` use existing secure-store access and validate persisted input. Clear only the matching request.
- `purgeManualHealthKitCheckpoint(userId: string)` deletes that account's known key unconditionally for sign-out/erasure, including corrupt persisted input; it shares storage ordering with ordinary reads/writes/conditional clearing.
- Extend `SyncOptions` with a manual execution context: fixed window, next-stage cursor, awaited stage-completion callback, and async interruption/account check. Keep existing callers behavior-compatible through purposeful optional manual context; no test-only branches.
- Publish semantic stage IDs and total count only where the production controller consumes them. Keep type grouping compatible with existing manual flow.

- [x] Write failing tests for original fixed dates on resume; skip fully completed stages; replay unfinished stage; never checkpoint partial errors; interruption before query/upload/anchor; stored request recreation/account mismatch/stale clear.
- [x] Run focused mobile tests and retain RED evidence.
- [x] Refactor only the manual pipeline into semantic stages: additive/category, each raw type, workouts/routes, sleep, each clinical type, running steps. Checkpoint after successful stage, not array offsets; reuse existing native anchors. Pass interruption checks into running-step page boundaries and before anchor acknowledgement.
- [x] Keep required existing error semantics and erasure cutoff. Surface partial errors without advancing the failing stage. Do not add a generic task runner or duplicate sample store.
- [x] Confirm stable identity replay using existing executable server tests; add minimal real-engine coverage only if existing evidence does not establish replay safety. Read integration-tests-ready before database tests.
- [x] Run sync/checkpoint/running-step mobile tests and mobile typecheck. Commit/push; report RED/GREEN and replay evidence before review gate.

### Task 3: App-owned manual session and shared observer ownership

**Files:** Create focused `packages/mobile/lib/health-kit-manual-sync.ts` and test; create React context/provider integration if needed; update `apple-health-provider.ts`, `background-health-kit-sync.ts`, `app/_layout.tsx`, `mobile-account-purge.ts` and their matching tests.

**Interfaces:**
- Manual controller is owned by authenticated app lifetime, bound to userId and SyncTrpcClient; exposes observable state plus `start(syncRangeDays: number | null)`, `resume()`, and `dispose()`.
- Keep `start`/`resume` terminal results compatible with `Promise<SyncResult>` so existing manual callers can migrate without a parallel unowned sync path; root owns the operation even if a route unmounts. Use React's existing context/subscription primitives, with no new state framework.
- Each native start attempt gets a fresh taskId, distinct from the durable checkpoint requestId; Resume never reuses a native task identifier whose old grant could arrive late.
- State distinguishes idle/running/paused/error/complete and carries progress message and actual completed stage count. Both list and detail consume this single production state.
- Shared execution gate serializes manual attempts and existing observer attempts; preserve observer IDs/types through waits and native expiry. Dispose/retire breaks pending waits and prevents new old-account side effects.
- Acquire the gate for an executing data attempt and release it before waiting on a pause. Keep native grant ownership separate from gate ownership; an existing grant can cover automatic foreground recovery, but expiration requires a tap and a fresh native task.
- Distinguish resource disposal from account departure: effect replay or same-account reinitialization must retain durable paused intent, while sign-out/account replacement and explicit erasure purge it. Do not assume development effect replay is impossible. Purge already-queued old writes in order and do not let late cleanup erase a replacement request.
- Prefer the authenticated root's existing context/lifetime and explicit erasure caller. Do not add a global current-controller registry or additional post-acceptance purge plumbing without an actual caller requirement that the existing flow cannot meet; any shared teardown must match its owner rather than retiring an arbitrary replacement account.

- [x] Write failing tests proving grant before HealthKit, duplicate start rejection, pause ownership release, manual/observer serial ordering, expired observer catch-up, native expiry requiring Resume, process checkpoint restoration, sign-out and late account writes.
- [x] Test transport recovery only for known transient errors on requests crossing background state: wait for active+connected, retry once, surface a failed fresh attempt. Test actual HealthKit locked error separately; generic background state does not prove lock.
- [x] Implement with existing AppState/network lifecycle primitives and task bridge; use stock cancellation and promise mechanisms instead of timers. Native unsupported path pauses while in the background and resumes foreground work.
- [x] Root setup/teardown and existing erasure path retire controller, stop native work, remove listeners, and purge matching request state. Mounted route hooks subscribe rather than creating independent manual operations.
- [x] Erasure cleanup must strictly purge the checkpoint while the existing unattempted preparation still has `ownerUserId`, before `markMobileAccountErasureConfirmationAttempted` strips that identity. Stop the owned manual operation first and reuse the existing cleanup-lease checks. Do not add identifying fields to erased/attempted capability storage or a new key index. Test failure/crash ordering at this boundary and signed-out recovery. Modify concrete erasure callers as needed instead of blindly requiring an identity-free post-acceptance purge to discover the old account.
- [x] Record sync once at terminal successful/degraded/error outcome as appropriate; do not record a pause as success. A final logging failure must not replay accepted health data. Preserve existing unexpected-error Sentry reporting and actionable error messages.
- [x] Pause/interruption stays inside the app-owned operation; do not call a wrapper that records/captures an error for each interrupted data attempt. Guard final log writes by the current account too. Observers also need retirement checks at query/upload/anchor boundaries, in addition to serial gate admission.
- [x] Run controller, AppleHealthProvider, background HealthKit, account purge, and root lifetime tests; mobile typecheck/lint. Commit/push and report before review gate.

### Task 4: Shared provider presentation and final validation

**Files:** `packages/mobile/app/providers/index.tsx`, `components/providers/{use-provider-detail-actions.ts,provider-card.tsx,provider-card.stories.tsx,provider-detail-actions-card.tsx}` plus actual existing route/detail tests and stories; mobile/background-module READMEs and incident baseline. Route tests stay outside `app/`.

**Interfaces:** Existing provider cards accept a Resume action/label for paused Apple Health, while both list and detail render shared controller state. Use existing progress and disclosure controls.

- [x] Write failing interaction tests for running and duplicate prevention, route navigation retention, paused Resume preserving window, confirmed locked text, and specific server errors.
- [x] Implement running progress, “Apple Health sync paused” with Resume, and confirmed “Unlock your phone to continue Apple Health sync”. Add existing-style stories for each state; no custom status framework.
- [x] Inspect equivalent web sync/import paths and document why native lifecycle changes have no browser equivalent; do not make unrelated web edits.
- [x] Run focused UI/mobile/native tests, mobile typecheck, relevant lint, spelling and diff checks, then the Docker-free suite. Run iOS build with supported signing instructions; read ios-simulator-audit before simulator runtime work. Report exact external blockers without claiming device validation from compilation.
- [x] Review stories visually using existing tooling. If serving, run/retain quick tunnel and give only direct story URLs under its emitted HTTPS host.
- [x] Final fresh Architect review against approved spec and actual diff. Resolve important findings with regression evidence, then update incident baseline with actual verification and physical-device acceptance limitations.
- [x] Commit/push final reviewed changes. Do not merge/deploy without explicit instruction. Explain native release requirement and any unexecuted physical-device checks.
