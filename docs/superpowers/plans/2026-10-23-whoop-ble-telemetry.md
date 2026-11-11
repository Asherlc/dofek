# WHOOP BLE Capture and Upload Telemetry

**Execution:** Implement and validate the native, server, and mobile components separately, review their integration, and complete the final verification before committing.

**Goal:** Distinguish absent capture, delayed uploads, lost buffers, broker publication, and delayed server visibility using correlated diagnostics.

**Architecture:** Extend existing native buffer statistics and retain one bounded metadata checkpoint across launches. Add authenticated/versioned mobile log context and per-stream scheduling/upload events. Correlate upload requests with server receipt/publication through a batch UUID. Use existing sink/read-model diagnostics for downstream visibility; do not create another data store or ingestion path.

**Tech Stack:** Existing TypeScript/React Native, Swift/Foundation, tRPC, Sentry and OpenTelemetry logging, Vitest and SwiftPM tests.

**Spec:** Record five stages: capture progress; buffer age/counters and restart checkpoint; scheduling decisions; upload acknowledgment/confirmation; server acceptance/publication and documented raw/serving visibility checks. Common identity includes authenticated account, device, app/build/OTA/runtime context, buffer instance and batch IDs. This extends the [existing uploader](../../../packages/mobile/lib/background-whoop-ble-sync.ts), [native module](../../../packages/mobile/modules/whoop-ble/README.md), and [broker/sink runbook](../../metric-stream-redpanda-r2-runbook.md). Correlation follows [OpenTelemetry log context](https://opentelemetry.io/docs/concepts/context-propagation/). Checkpoints must not depend on a final termination callback ([Apple lifecycle guidance](https://developer.apple.com/documentation/uikit/uiapplicationdelegate/applicationwillterminate(_:))).

## Global Constraints

- Preserve sample capture, erasure, upload concurrency, grouping and peek/confirm behavior.
- Log counts, identifiers and timestamp ranges, never raw sensor values or payloads.
- No new dependencies, environment variables, retry/timeout knobs or database schema changes.
- Persist one diagnostic checkpoint only; sensor samples remain memory-only.
- Previous native checkpoints lack authenticated identity; label provenance unknown, never attribute them to the current account as proven history.
- Keep native checkpoint writes bounded to 30-second capture intervals and explicit diagnostic/lifecycle boundaries.
- Server upload success describes broker acknowledgment, not ClickHouse or chart visibility.
- This is native capture instrumentation; no web capture surface exists. Shared server telemetry applies to every client.

## Review Focus

- Overflow and confirmed removals must be counted independently, including cursor movement during upload.
- Out-of-order samples must have correct timestamp bounds; snapshots must not cause per-sample disk writes.
- Logout and account switches must remove stale telemetry identity, including caller-supplied IDs.
- Failed and skipped uploads must retain buffered data; acknowledgment must precede confirmation.
- A pending motion upload must remain visible in periodic snapshots while realtime continues independently.
- Zero/all-filtered uploads must not claim broker publication when no metric rows were published.
- A checkpoint across launches is last-observed evidence, not proof of an exact number of lost samples or a particular termination cause.

## Task 1: Native capture and retained-buffer diagnostics

**Files:** native WHOOP Swift module/buffer/tests and `modules/whoop-ble/index.ts`.

**Interface:** `getDataPathStats().buffers` contains `bufferInstanceId`, `bufferCreatedAt`, `checkpointAt`, `imu`, `realtime`, `previousCheckpoint`. Each stream has count, oldest/newest timestamps, received/confirmed/overflow/erasure/clear/legacy-drain counts and lastConfirmedAt. Previous checkpoint has the same shape without nested history. Top-level capture fields include last notification, last parsed IMU/realtime, and last valid HR timestamps. IDs are UUIDs, dates ISO strings or null.

- [x] Write failing tests for out-of-order ranges, actual confirmation counts after overflow, explicit discard reasons, new-instance checkpoint restoration, bounded capture checkpointing, and erasure clearing history.
- [x] Extend the locked native buffer without changing sample/confirmation semantics; expose the typed bridge payload.
- [x] Run `swift test --package-path packages/mobile/modules/whoop-ble`; verify buffer tests and existing protocol tests.
- [x] Review native diagnostics and bridge changes for concurrency, performance and provenance.

## Task 2: Server upload receipt and publication

**Files:** WHOOP/IMU routers, a focused shared telemetry helper and colocated tests.

**Interface:** Both upload mutations accept optional `telemetry: {batchId: UUID, bufferInstanceId?: UUID}`. Other motion clients legitimately omit it. Preserve existing response shape. Emit `upload_received`, `upload_published`, `upload_failed` with authenticated account/device/version, batch/buffer IDs, true min/max timestamps, input/accepted/filtered sample counts, published row count and elapsed time. Empty/no-row requests must identify that no broker publication occurred.

- [x] Write failing tests for request correlation, deferred publisher acknowledgment, filtered samples, empty/no-row requests, and failure reporting with original error propagation.
- [x] Add bounded structured events around existing awaited publication; do not log raw samples or create exact sink receipts.
- [x] Run affected unit suites/typechecks and review publication boundary correctness.

## Task 3: Authenticated mobile telemetry context

**Files:** mobile `telemetry.ts`, its tests, and necessary shared SDK mocks.

**Interface:** Every emitted mobile log/error has canonical authenticated `userId` when present and appVersion/assetsVersion/appBuild/runtimeVersion/runtimeId. `identifyUser` and `resetUser` also update/clear Sentry identity. Caller attributes cannot override canonical identity.

- [x] Write failing tests for identity setting/switching/reset, caller spoofing, native build/OTA/runtime context, and existing route/error behavior.
- [x] Reuse existing Expo version/dependency APIs and add no new configuration.
- [x] Run telemetry tests and review identity lifecycle/privacy boundaries.

## Task 4: Mobile scheduling, batch and HTTP diagnostics

**Files:** mobile WHOOP uploader, a focused diagnostics model and colocated tests, dependency consumers/test fixtures, and transport boundary if required.

**Interface:** The native diagnostics dependency is required for actual uploader consumers. Each grouped upload carries the server telemetry metadata; events track worker start/join/end, skipped reason, request start/acknowledgment/failure and native confirmation. Periodic/startup/state-change snapshots flatten allowlisted native counters/ranges and active-worker/pending-request ages. Previous checkpoint is reported once per observed buffer instance with unknown account provenance.

- [x] Write failing public-interface tests for correlated batch events, pending uploads in periodic snapshots, confirmation ordering, skipped/failed uploads, and one-time checkpoint reporting.
- [x] Implement bounded structured diagnostics without altering upload permissions, concurrency, requests or confirmations.
- [x] Capture actual HTTP status/duration at the existing transport boundary with batch correlation; verify auth headers and unbatched behavior remain intact.
- [x] Run focused uploader/transport/lifecycle tests, mobile/server TypeScript, native tests, lint, spellcheck and full unit/mobile suite.
- [x] Update the WHOOP diagnostic runbook and incident baseline with emitted fields, account/device/time-range queries, validation and native-build rollout requirements.
- [x] Complete independent review and address material findings with regression tests.

## Validation and review record

- Full unit/mobile suite: 20,330 tests passed, 19 skipped; 1,318 files passed, 2 skipped. Native SwiftPM: 133 passed. Server/mobile/module TypeScript, strict SwiftLint, sandbox lint, canonical spellcheck and diff checks passed.
- Canonical ad-hoc Release simulator build passed, including both architectures of the changed Expo bridge; incremental rebuild with last-known device identity also passed. The generated compile artifact predates runtime 1.13 regeneration and is not a release artifact.
- Component review corrected identity at the authoritative auth-state boundary, including pending/rejected logout and account-switch races. Final review corrected JavaScript confirmation labels to `requestedConfirmationCount`/`requestedErasureDiscardCount` and made nested metadata selection explicit. Covering regressions failed first; scoped re-review approved the fixes.
- Runtime 1.13 is required because the JavaScript consumes expanded native diagnostics. Physical-device capture/termination validation and rollout remain separate from implementation verification. Previous-workout recovery remains unresolved.
- Final PR verification: 20,451 unit/mobile tests passed (19 skipped), 145 WHOOP Swift tests and 40 background-refresh Swift tests passed, full lint/spelling and root/server/web/mobile TypeScript passed. A fresh runtime 1.13 Release simulator build passed for both architectures. Review added full native-payload validation, valid device-clock bounds, terminal-confirmation checkpoints, and safe telemetry attribution across retired requests, without changing retry or timeout policy.
