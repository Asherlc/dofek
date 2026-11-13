# WHOOP cleanup restart recovery

Complete the tasks in order and review each result before continuing.

**Goal:** Recover WHOOP uploads after interrupted cleanup without making the app wait for sensor deletion.

**Approved design:** The operator approved the proposal in the [incident record](../../production-incident-baseline.md#2026-11-12--whoop-startup-blocked-by-retained-cleanup-intent-unresolved), with an explicit requirement to preserve responsive startup and login. Recovery belongs only to the existing asynchronous WHOOP initialization effect. Await the existing native disable operation, clear only the completed intent, then configure uploads. Keep native FIFO and erasure behavior. Expo supports [asynchronous module queue dispatch](https://docs.expo.dev/modules/module-api/#asyncfunction); [React effects](https://react.dev/reference/react/useEffect) start this work after rendering.

**Architecture:** Extend the existing upload-session module. Serialize cleanup-marker access locally so recovery cannot erase a concurrently persisted newer intent. Share one recovery Promise in the JavaScript lifetime to avoid duplicate automatic purges and repeated automatic attempts after failure. Preserve configuration-generation invalidation. Reuse the existing native queue, storage and error-reporting caller; add no dependencies, timers, retry loop or recovery service. Normal startup without a marker performs no cleanup.

**Scope:** Native mobile sensor ownership only; web has no equivalent native queue. No native implementation, authentication ordering, account-deletion gate, production release or Sentry-status change.

## Review focus

- A stalled cleanup never holds credential persistence, splash dismissal or navigation.
- Concurrent initialization shares recovery; failures retain the marker and reach existing exception reporting.
- Sign-out/erasure overtaking a SecureStore read or recovery prevents stale configuration.
- Comparing/deleting the recovered intent cannot erase a newer intent.
- Successful ordinary startup retains queued data; successful recovery finishes the already-requested destructive cleanup.

## Task 1: Recover pending native cleanup

Files: `packages/mobile/lib/whoop-upload-session.ts` and its colocated test.

- [x] Replace the restart-rejection test with a failing restart-recovery test. Add blocked recovery, concurrent initialization, original native/read/delete failures, no repeated automatic attempt, stale read, account cleanup during recovery and overlapping marker deletion/write cases.
- [x] Run the focused test file and observe the intended failures.
- [x] Implement local marker serialization and shared asynchronous recovery through the existing native disable function. Keep native failure and generation fences.
- [x] Run upload-session and auth-session tests; review the actual diff for account and erasure safety.

## Task 2: Prove startup independence and qualify

Files: `packages/mobile/lib/auth-context.test.ts`, `packages/mobile/app-tests/_layout.cleanup.test.tsx`, `packages/mobile/README.md`, and the incident baseline.

- [x] Exercise actual recovery with cleanup held pending while login completes; assert upload configuration remains blocked.
- [x] Render root navigation through a pending actual WHOOP recovery and verify splash dismissal, navigation rendering/route updates, and unrelated service initialization before releasing cleanup. Retain existing native bridge isolation evidence; no native dispatch changes are needed.
- [x] Run focused mobile regressions, mobile typecheck, source lint and spelling. Run required broader pre-push checks where available.
- [x] Update current README and incident evidence with actual results and physical-device limits. Obtain a fresh whole-diff review, fix substantive findings with regression tests, commit and push. Do not claim affected-device recovery without signed-device acceptance.

Qualification prerequisite: Metro CI requires the newly published Expo `58.0.25`
and development client `58.0.20`. Reuse the exact package-only correction from
`dae4865c8469a71131cddad7c82dc61760897a79` (PR #3284), after the active original
unit/mobile suite finishes. Verify frozen installation, the unchanged Expo
compatibility check, the mobile tier, lint and types; preserve all native patches
and validation gates. No recovery implementation change is needed for this
independent SDK prerequisite; see the incident baseline for the failing command
and first fatal diagnostic.
