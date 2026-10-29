# WHOOP durable upload implementation plan

**Goal:** Preserve native WHOOP samples until server acknowledgment and deliver them through iOS background transfers.

**Architecture:** A transactional SQLite queue owns realtime and IMU samples, account ownership, and stable batch reservations. A native background uploader consumes that queue; the Expo bridge configures it from existing authentication and native BLE arrivals.

**Tech stack:** Swift, system SQLite, Foundation URLSession, Expo Modules, TypeScript, XCTest, Vitest.

**Spec:** [Design](../specs/2026-10-28-whoop-durable-upload-design.md).

## Global constraints

Preserve PR 1585's ordinary-fetch background guards, PR 3053's independent streams and retired-lifetime protection, and existing erasure ownership. No branch switching, duplicate credential persistence, competing WHOOP upload consumers, or runtime fallback to memory-only capture. Tokens remain in memory; the existing credential store is canonical. Native storage failures must be visible.

## Review focus

Account changes during an in-flight request; relaunch after OS acceptance but before local acknowledgment; missing upload body files; tRPC errors inside HTTP responses; capture before auth configuration or while erasure is active.

## Tasks

- [x] 1. Write failing native tests for a durable queue, then implement `WhoopBleSampleStore.swift` and its colocated XCTest file. Commit/reopen storage, reserve device-scoped 500-row batches, acknowledge exact IDs, retain failed batches, purge on owner change, and apply erasure cutoffs. Verify real SQLite semantics.
- [x] 2. Write failing tests for native transfer orchestration, then implement background uploader and Expo lifecycle adapter. Verify independent streams, success parsing, failure retention, restored task reconciliation, file regeneration, cancellation, and stale callbacks. Review queue/uploader interfaces together.
- [x] 3. Write failing mobile tests for authenticated native configuration and sign-out/erasure; wire serialized native capture into the canonical queue and replace JS WHOOP upload consumers. Preserve connection handling and existing diagnostics; ensure standalone Swift export excludes app-specific Expo adapters.
- [x] 4. Run native/mobile suites, typechecks, owned-file lint, standalone export and signed native build. Review the complete diff for ownership, concurrency, acknowledgment and history regressions, then correct material findings. Update current docs and incident baseline with actual validation limits; commit and push changes.

## Working notes

The user explicitly approved the implementation direction and requested history review. The current isolated branch is `pumped-mayfly`. History review found deliberate ordinary-fetch restrictions rather than a reverted durable native uploader. Review checkpoints are queue tests, transfer tests, auth/erasure tests, and independent whole-branch review. Do not claim hardware validation from macOS or Simulator tests.

## Verification ledger

- Queue checkpoint: six real SQLite tests pass, including close/reopen, more than 86,400 rows, concurrent appends/rollback, stale acknowledgments, owner/server rotation, and persistent cutoffs. Independent store review approved.
- Transfer checkpoint: 14 native uploader tests pass. Review regressions first reproduced scoped cancellation, restored-token rejection, and completion-registration races; fixes pass independent re-review.
- Authentication checkpoint: native disable happens synchronously; credential cleanup proceeds even if native purge fails and still reports/rethrows cleanup errors. Mobile auth, bridge, diagnostics, and lifecycle checks pass.
- Whole suite: 22,630 unit/mobile tests pass (19 skipped); native WHOOP and exported standalone package each pass 145 tests. Repository sandbox lint, canonical spellcheck, mobile typecheck, export-tool tests, and strict SwiftLint of all 49 repository-owned WHOOP Swift files pass.
- Native embedding: Expo prebuild and CocoaPods installation complete; generated provider includes the new upload subscriber. The final ad-hoc signed iOS Simulator build succeeds and passes strict recursive signature verification. No physical WHOOP test has been performed.
- Ruling: retain the existing server filtering/acknowledgment semantics rather than interpreting inserted count as selected-row count. Root storage only acknowledges exact batch/generation identities.
- Ruling: use the repository's existing RNSentry dependency and binary Sentry distribution. A transient intermediate Sentry/Core dependency failed resolution because the existing binary distribution has no Core component; the canonical dependency resolves successfully.
- Ruling: background URLSession automatically follows redirects; configured server origins are trusted endpoints that must serve mutations directly. Final-origin validation protects acknowledgment, not pre-redirect disclosure. This is an inherent Apple API constraint, documented in the current runbook.

- Final packaging review approved extraction of Dofek's bootstrap/reporter and URLSession adapter from the standalone SwiftPM target. The exported package passes 145 tests; no app-only Sentry dependency leaks into the protocol library.
- Periphery completed against the freshly rebuilt actual Swift index path (.build/out); the CLI's default .build/debug/index/store does not match this local SwiftPM backend. Only six existing Expo-only connection diagnostic members remain reported, each consumed by the signed app's excluded Expo bridge. No suppressions or gate changes were added.
- A directory-wide SwiftLint probe followed a workspace node_modules symlink and reported vendor violations. The repository-owned file inventory passes all 49 WHOOP Swift files with strict lint; dependencies were not modified.
- Final iOS compilation caught four wrong argument labels in iOS-only file-protection calls that macOS tests could not compile. Correct API labels and a refreshed CocoaPods source inventory pass the actual iOS build. No signing, SDK, lint, retry, or timeout gate was disabled.

## PR review checkpoints

- [x] Reproduce and fix erasure persistence after body cleanup failures, independent stream submission, and full-batch progress after projection cleanup failures. Real filesystem failures and SQLite reopen assertions verify these boundaries.
- [x] Reproduce and fix duplicate React teardown ownership and user-visible initialization errors, including partial listener cleanup and retired-lifetime suppression. Verify single discovery during foreground re-entry and exact native callback wiring.
- [x] Verify fractional erasure boundaries and cross-origin acknowledgment retention. After reviewing PR 1385 and confirming timestamp-identity collisions, the operator approved faithful device-time serialization instead of clamping. Keep fractional ticks, IMU offsets, CRC checks, and per-sample server filtering; test exact early/future values and mixed valid/future batches.
- [x] Review the combined corrections independently; all 153 native tests and the clean 22,642-test unit/mobile tier pass. Repository lint, root/server/web/mobile typechecks, and the signed iOS Simulator build with strict signature verification pass.
- [x] Add an app-hosted Expo XCTest harness using Expo's testing helpers, reproduce capture-failure reconnect/readiness behavior, then implement the native guard and verify through the real Expo runtime. The operator explicitly selected this test-first direction over a build-only exception. Six actual simulator regressions failed before the guard; seven tests including successful reconfiguration pass afterward. Module registration stays separate from the private connection handlers, and readiness publication rechecks capture after the device snapshot.
- [ ] Run the harness and affected checks, review the final diff, push, resolve the remaining PR review thread, and confirm hosted checks. Physical WHOOP background/overnight behavior remains a release-validation requirement.
