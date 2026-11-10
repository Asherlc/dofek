# Responsive session cleanup implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline, with TDD and independent final review.

**Goal:** Prevent rejected-session native cleanup from blocking JavaScript while preserving account isolation and completed deletion.

**Architecture:** Use stock Expo AsyncFunction for `disableUploads`, `configureUpload`, `flushUploads`, `getDataPathStats` and `getDeviceSummary`, the actual callers that perform disk work or wait on the uploader queue. Keep the existing native serialized uploader and JavaScript session-persistence queue. Do not add aliases, coordinators, retries or timeouts.

**Tech Stack:** Expo Modules, Swift, SQLite, TypeScript, Vitest, XCTest.

**Spec:** [Approved design](../specs/2026-11-10-mobile-session-cleanup-design.md). The operator explicitly approved this design in the task conversation.

## Constraints and review focus

- Session writes must not overtake pending native cleanup; reserve the existing persistence queue position before yielding.
- Native and credential failures both remain reportable; all credential deletions must still be attempted.
- Retired async startup must not connect or configure a later account; late diagnostics retain their originating lifetime.
- Foreground/background flush failures must be awaited and reported.
- Disk cleanup must actually finish, remove samples/reservations and preserve generation/cutoff semantics. UI responsiveness alone is insufficient.
- Native-specific bridge change; no web behavior depends on it. No dependency or deployment changes are required for this implementation.

## Task 1: Make the existing bridge asynchronous end to end

**Files:** `packages/mobile/modules/whoop-ble/ios/WhoopBleModule.swift`, `ios/BridgeTests/WhoopBleModuleTests.swift` and `test-helpers.swift`; `packages/mobile/modules/whoop-ble/index.ts` and `index.test.ts`; `packages/mobile/lib/auth.ts` and `auth.test.ts`; `background-whoop-ble-sync.ts` and its test; `whoop-ble-sync-types.ts`, `whoop-ble-test-helpers.ts`, `packages/mobile/test-setup.ts`; `WhoopSensorDetails.tsx` and its test; actual affected app tests/fixtures.

**Interfaces:** The five named bridge methods return Promises in TypeScript. Native methods use `AsyncFunction` on Expo's worker queue. Existing synchronous capture durability stays unchanged. Independent review identified the catalog's aliased `getDeviceSummary` import as an additional live queue wait; include it in the same approved async boundary.

- [x] Write and run RED auth tests: a pending native disable prevents credential deletion and a subsequent session write until settlement; rejection still attempts all credential deletions and preserves both failures.
- [x] Write and run RED background-lifetime tests: pending configuration cannot reconnect a retired session; additionally verify delayed diagnostic/flush rejection reporting. Remove teardown's guaranteed-retired snapshot request.
- [x] Write and run RED Expo bridge test: occupy the existing BLE queue, call disable from real Hermes, then evaluate unrelated JavaScript before releasing the queue. Verify the returned Promise remains pending and subsequently resolves. Preserve native stage/error tests using Promise outcomes. Extend RED/GREEN verification to the aliased device-summary caller.
- [x] Implement the five stock asynchronous methods and update wrappers/types/mocks/real callers to await results. Reserve auth's existing serialized persistence operation immediately; await native settlement inside it before credential work. Preserve all-failure aggregation and native ownership/cutoff behavior.
- [x] Run focused mobile/auth/bridge tests GREEN and mobile typecheck. Review the actual diff for lifecycle races, unhandled Promise rejection and changed erasure ordering.

## Task 2: Qualify real deletion and release

**Files:** Existing `WhoopBleSampleStoreTests.swift` / `WhoopBleBackgroundUploaderTests.swift`, module README, incident ledger and baseline. Reuse existing real-SQLite fixtures; add only missing behavioral coverage.

- [x] Run real Swift store/uploader tests and a representative backlog cleanup qualification. Verify rows, reservations and retired identities are removed, generation changes, cutoff protection remains, and cleanup returns. The unchanged store completes the synthetic 3.47-million-row backlog; no deletion strategy change is needed.
- [x] Run the app-hosted Expo bridge suite through `pnpm --dir packages/mobile test:ios:bridge` after the documented prebuild. No Metro/HTTP server is needed. Observe the native regression fail before the bridge fix and pass afterward; rerun the generated Xcode test scheme for the review correction.
- [x] Update API usage documentation with the Expo AsyncFunction citation and record measured validation/remaining device risk.
- [ ] Run full lint, root/server/web/mobile typechecks, relevant tests, spelling and diff checks. Independent reviewer checks the actual branch diff and evidence. Commit and push all completed work.
- [ ] Release through canonical CI/deploy and verify online startup on the affected iPhone. Keep the current freeze open until it succeeds.
