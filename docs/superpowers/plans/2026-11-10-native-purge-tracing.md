# Native purge tracing implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved diagnostic extension inline. Keep one final independent review.

**Goal:** Identify the last entered SQLite cleanup boundary and its native thread on the affected iPhone.

**Architecture:** Pass the uploader's existing stage callback through store purge and its existing transaction helper. Reuse the current Sentry operation ID, duration and failure reporting; add native thread identity. Preserve SQL, ordering, lock scope, rollback, generation and erasure semantics.

**Tech stack:** Swift, SQLite, existing Sentry logger, XCTest and the current Hermes bridge host.

**Approval:** The operator approved extending cleanup tracing through lock acquisition, deletion and commit, including thread identity, followed by another TestFlight release. See the [failed device acceptance evidence](../../incidents/2026-11-10-sentry-remediation.md#device-acceptance-failed-on-build-1794347190).

## Constraints and review focus

- No new dependency, profiler, heartbeat, retry, timeout, database algorithm or authentication policy.
- Stage callbacks log metadata only and must not re-enter the locked store.
- A stage names the operation about to run; completion is emitted only after successful commit. SQLite defines the [transaction boundaries](https://www.sqlite.org/lang_transaction.html).
- Failed deletion must identify the failed stage, retain the original error and roll back prior writes.
- Thread metadata must be captured at each callback, since cleanup crosses queues; Apple explains the distinction between [main-thread work and a hang](https://developer.apple.com/documentation/xcode/understanding-hangs-in-your-app).
- A signed diagnostic release provides evidence; it does not by itself close the mobile incident.

## Task 1: Store and bridge diagnostics

**Files:** `WhoopBleSampleStore.swift`, `WhoopBleBackgroundUploader.swift`, `WhoopBleModule.swift`, their existing XCTest files and module README under `packages/mobile/modules/whoop-ble/`.

- [x] Extend the existing uploader stage test to require inner store stages, and observe RED with `swift test --filter WhoopBleBackgroundUploaderTests`.
- [x] Add real SQLite deletion and deferred-constraint commit failures to the store tests. Require the last stage to name the failed operation, original failure propagation and rollback of counters, binding and samples.
- [x] Add the smallest callback forwarding through `purge(onStage:)`, `purgeLocked(onStage:)` and `transaction(onStage:_:)`, defaulting to the existing no-observer behavior for other callers. Emit lock wait, begin, counter reset, sample deletion, batch deletion, binding deletion, generation rotation, commit and completion boundaries.
- [x] Extend the real Hermes cleanup test to require correlated inner stages and native thread metadata; observe RED before adding the metadata. Preserve responsiveness and actual Promise completion assertions.
- [ ] Run the complete standalone Swift suite and Hermes bridge suite, tracked-source SwiftLint, repository lint/typechecks and the canonical unit/mobile tier. Review the actual diff and evidence once.
- [ ] Update the module reference and incident baseline, commit and push on the current branch, open a PR and complete canonical CI/release. Request an affected-device reproduction only once the new signed build is available.

Execution continues under the operator's existing inline method and approval; no additional implementation-method question is needed.
