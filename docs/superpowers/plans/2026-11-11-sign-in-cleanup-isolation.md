# Sign-in Cleanup Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Track review checkpoints in the plan ledger.

**Goal:** Complete valid sign-in while native sensor cleanup is pending, retaining ownership and erasure fences.
**Architecture:** Put WHOOP disk-backed bridge calls on one serial module queue. Keep credential persistence ordered independently of native purge completion; cleanup still has an awaited, reportable result.
**Tech Stack:** Existing TypeScript, Swift, Expo, Vitest and XCTest/Hermes host.
**Spec:** [Approved design](../specs/2026-11-11-sign-in-cleanup-isolation-design.md).

## Global Constraints

- Work only on the current branch/workspace. No branch switches, dependency upgrades, new recovery machinery, ignored errors, retries or timeouts.
- Use RTK and pnpm. No recursive delegation. Workers do not commit/push until the lead has run the required pre-push checks; every new commit is then pushed immediately.
- No broad tests, heavy native build or disk-heavy benchmark without coordinator clearance. Focused tests are permitted. No production release or issue closure without actual device acceptance.
- Preserve native FIFO disable/configure ordering, successful purge before resumed capture, cleanup failure reporting, account-erasure leases/cutoff and late-ack isolation.

## Review Focus

- Replacement-token persistence and cache survive late cleanup completion.
- Credential deletion failure remains visible and cannot be mistaken for successful teardown.
- Native cleanup failure cannot enable a queued replacement configuration.
- Unrelated Expo async functions complete while WHOOP work is pending.
- A second cleanup/new login and account-erasure lease retain their ordering.

## Task 1: Native queue isolation and capture fencing

**Files:** `packages/mobile/modules/whoop-ble/ios/WhoopBleModule.swift`, `ios/BridgeTests/WhoopBleModuleTests.swift`, `ios/BridgeTests/test-helpers.swift` beneath the same module.
**Interfaces:** Existing five async methods and their payloads remain unchanged. One module-owned serial DispatchQueue orders disk-backed bridge work; existing native uploader/store continue owning data, generations and cancellation.

- [ ] Add a real Hermes bridge test: block the BLE queue, start disable, queue configure, and show an unrelated test Expo module's async probe completes before releasing cleanup. Configuration must remain pending until cleanup completes.
- [ ] Add a real failure fixture: failed native cleanup keeps capture suspended and rejects subsequent configure; a later explicit successful cleanup permits configuration again. Reuse existing native failure fixtures and test helpers, without test-only production APIs.
- [ ] Run focused bridge tests and record RED before implementation; coordinate build clearance first if compiling the native host is required.
- [ ] Add one serial module queue and dispatch getDeviceSummary, getDataPathStats, configureUpload, flushUploads and disableUploads on it. Retain a queue-confined cleanup failure only as needed to keep queued configuration fail-closed; clear it on successful explicit cleanup. Report architectural uncertainty rather than changing strategy.
- [ ] Run focused tests GREEN; self-review actual diff and hand it to the lead for task review.

## Task 2: Independent credential persistence

**Files:** `packages/mobile/lib/auth.ts`, its colocated tests, and auth-context tests for the actual login consumer. If responsibility/size constraints require moving existing persistence code, retain one canonical implementation and update production imports directly, without barrels or compatibility exports.
**Interfaces:** `clearSessionToken(): Promise<void>` continues to await all cleanup results. Existing session APIs retain types and results; credential serialization no longer waits for a bulk sensor purge.

- [ ] Replace the old pending-purge test with a stateful fixture proving old credentials are removed, a replacement token/user/nonce can persist before native completion, and late completion preserves the replacement token and its cache. Verify cleanup itself remains pending.
- [ ] Cover late native rejection, credential rejection aggregation, concurrent cleanup/login and the existing account-erasure lease. Add an auth-context regression exercising `onLoginSuccess` while prior native teardown is blocked.
- [ ] Run focused tests RED, then release credential serialization after credential deletion while separately awaiting native cleanup and preserving original failures. Remove late unconditional cache clearing that would erase the replacement session.
- [ ] Run focused tests GREEN and send actual diff/evidence for task review. Preserve the native sequencing established by Task 1.

## Task 3: Qualification and review

- [ ] Update current human-facing cleanup guidance and append exact incident evidence, replacing obsolete completion claims without rewriting historical records.
- [ ] Obtain coordinator clearance for necessary native build/broad validation. Run required lint, root/server/web/mobile typechecks, relevant tests, native bridge/standalone checks and native signing/runtime compatibility checks appropriate to the final diff.
- [ ] Review whole diff for security, races, prior reversions and minimum maintained code. Return mechanical corrections to the implementation worker.
- [ ] Commit/push after required checks, open the actual fix PR, and monitor its checks. Coordinate any later release separately; keep MOBILE-20 open until end-to-end signed-device acceptance.
