# WHOOP pending reconnect implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Dofek's connection timer from abandoning passive WHOOP reconnection before Bluetooth connects.

**Architecture:** Preserve automatic pending Core Bluetooth requests and their owning peripheral/state. Bound explicit caller waits as before and arm the existing discovery/subscription timeout once a passive connection succeeds.

**Tech Stack:** Swift, Core Bluetooth, XCTest, existing Expo module and Vitest application tests.

**Spec:** [Approved design](../specs/2026-10-24-whoop-pending-reconnect-design.md).

## Global Constraints

- Preserve the ten-second timeout value, alert policy, public Swift/Expo APIs, sample buffering, explicit cancellation and upload behavior.
- No dependencies or configuration are added.
- Continue on the existing isolated `strong-eagle` branch; no branch switching.
- Native changes need a new iOS build; physical background recovery remains a release verification requirement.

## Review Focus

- An automatic reconnect that takes longer than ten seconds must retain its peripheral and reconnect intent.
- Foreground find/retry must preserve a pending connection and accept its later connection callback.
- Explicit connect callers must still receive a bounded timeout and exactly one completion.
- Restored pending connections must accept a later callback; restored connected peripherals must retain bounded discovery.
- Stale callbacks, intentional cancellation and successful subscription must settle or cancel only the owning attempt.

Checkboxes record progress at the commit that contains them. Subsequent build
and hosted validation results are tracked in [PR 3072](https://github.com/Asherlc/dofek/pull/3072).

### Task 1: Native reconnect lifecycle and regressions

**Files:**
- Modify: `packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager.swift`
- Modify: `packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager+CoreBluetooth.swift`
- Modify: `packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager+Discovery.swift`
- Create: `packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager+Handshake.swift` — timeout, completion and abort ownership extracted from the manager.
- Test: `packages/mobile/modules/whoop-ble/Tests/WhoopBleConnectionManagerTests.swift`
- Create: `packages/mobile/modules/whoop-ble/Tests/WhoopBleConnectionManager+HandshakeTests.swift` — corresponding handshake regressions, including the existing tests moved with their production responsibility.

**Interfaces:** Consume the existing `connect`, `findWhoop`, `retryConnection`, native callback handlers, and `startHandshakeTimeout`; preserve their public contracts.

- [x] Add regressions proving passive pending reconnect survives the configured deadline; explicit connect still cancels with `TIMEOUT`; discovery and subscriptions after connection remain bounded; stale timers cannot cancel a replacement attempt; explicit cancellation settles once. Review concrete foreground find/retry and restoration ownership paths and record the physical test boundary.
- [x] Run `swift test --package-path packages/mobile/modules/whoop-ble`; observe the new behavioral regression fail before implementation.
- [x] Apply the smallest lifecycle fix using existing completion ownership/state and timeout handling. Do not add a public policy flag or retry loop.
- [x] Run the complete Swift suite and strict SwiftLint over owned tracked Swift files; expect zero failures or violations.
- [x] Independent review checkpoint: verify approved behavior, timer ownership, stale callbacks and restoration against the complete native diff.

### Task 2: Documentation, app compatibility and delivery

**Files:**
- Modify: `packages/mobile/modules/whoop-ble/README.md`
- Modify: `docs/whoop-ble-protocol.md`
- Modify: `docs/production-incident-baseline.md`

**Interfaces:** Consume Task 1's unchanged public API and final native behavior.

- [x] Document pending automatic connections, bounded setup, diagnostic replay and native release verification with primary-source citations.
- [x] Run focused mobile sync/diagnostic tests, including the existing explicit-connection timeout upload fallback; expect all tests to pass.
- [x] Run full repository lint, root/server/web/mobile/module TypeScript checks, and a signed iOS Simulator compile when available; report the physical-device validation boundary accurately.
- [x] Final review checkpoint: independent whole-change review, address material findings with regression coverage.
- [x] Commit and push the completed change on `strong-eagle`; report root cause, fix, validation and native build requirement.

### Task 3: Restore mobile CI coverage for nested native modules

**Files:**
- Modify: `scripts/detect-ci-changes.ts`
- Test: `scripts/detect-ci-changes.test.ts`
- Document: `scripts/README.md`, `docs/production-incident-baseline.md`

**Interfaces:** Preserve the detector's public CLI/output contract and existing shared-workspace propagation. Consume the current `packages/mobile/` ownership boundary, including Expo local modules.

- [x] Add a failing public detector regression using a nested WHOOP native Swift path; cover another local module or bridge/test path without adding redundant cases.
- [x] Run the focused detector test before implementation; expect `mobile=false` to contradict the required `true`.
- [x] Include non-documentation `packages/mobile/` paths in mobile scope while preserving documentation-only and transitive workspace behavior.
- [x] Run the complete detector suite and invoke the public CLI with the exact failing native path; expect mobile checks enabled.
- [x] Independent scoped review checkpoint: inspect the small CI diff and regression coverage, then run lint/typechecks/relevant tests, commit and push.
- [ ] Observe the fresh hosted detector output and existing native jobs; do not treat skipped mobile checks as native validation.

### Task 4: Route native mutation testing to the owning Swift package

**Files:**
- Create: `scripts/run-swift-mutation.ts`, `scripts/run-swift-mutation.test.ts`
- Modify: `.github/workflows/test.yml`
- Create: `packages/mobile/muter.conf.yml` and package-local configuration symlinks for all eight native Swift packages.
- Replace: `packages/mobile/modules/health-kit/muter.conf.yml` with the canonical configuration symlink.
- Modify: `packages/mobile/targets/DofekWatch/Package.swift` to exclude the added tool configuration from its root source target; ignore generated sibling mutation clones in `.gitignore`.
- Document: `scripts/README.md`, `docs/testing.md`, `docs/production-incident-baseline.md`

**Interfaces:** Public CLI `pnpm tsx scripts/run-swift-mutation.ts --base origin/main`. Consume Git changed paths, owning `Package.swift`, SwiftPM description JSON and Muter 16. Preserve Muter exit semantics; no new score threshold or framework.

- [x] Add public CLI fixture tests for affected WHOOP and HealthKit packages, a real divergent Git history proving merge-base selection, package-relative files, excluded test/Expo bridge files, empty selection, tool failures including 255, missing configuration and invalid/missing reports.
- [x] Run the focused runner suite with `--retry=0` before implementation; observe RED.
- [x] Implement the smallest runner using SwiftPM source inventory, per-package working directories, a shared configuration and absolute JSON reports; propagate all nonzero exits.
- [x] Replace the hardcoded HealthKit workflow commands and exit-255 success branch with the runner; upload all package reports. Validate YAML using the existing schema/lint tooling rather than static configuration tests.
- [x] Run the runner suite and a real WHOOP mutation run; inspect actual discovery and report results.
- [x] Independent scoped review checkpoint: review runner, workflow, configuration and tests; run required pre-push checks, commit and push.
- [ ] Observe real hosted native mutation execution and completion; distinguish its report from ordinary unit and build results.
