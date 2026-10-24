# Background Refresh Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Establish where native background refresh stops before WHOOP uploads.

**Architecture:** Retain bounded native scheduler/task metadata, expose it through
the existing Expo module, and replay validated events through mobile telemetry.
Follow the existing WHOOP journal pattern; add no dependency or scheduling change.

**Tech Stack:** Swift/Foundation/UserDefaults, Expo Modules, TypeScript/Zod,
existing logger/Sentry, XCTest and Vitest.

**Spec:** `docs/superpowers/specs/2026-10-24-background-refresh-diagnostics-design.md`

## Global Constraints

- Metadata only: no sensor samples, account identifiers, tokens, or credentials in native storage.
- Keep 64 native events plus an overflow counter; reads do not consume history.
- Preserve scheduling, upload triggers, completion behavior, expiration policy, retries and timeouts.
- Existing mobile telemetry supplies authenticated context; native history has unknown account provenance.
- Use current libraries and the existing UserDefaults journal pattern; add no dependencies or env vars.
- Run tests first; no test-only exports, static source-string tests, or new files under mobile `app/` except routes.
- Keep new classes focused; update module/docs references with primary-source citations.
- Stay on the existing branch; commit and push every new commit.

## Review Focus

- A native task arrives before a JS listener: record the failure without changing completion policy.
- Expiration races with JS completion: record actual completion exactly once and distinguish late requests.
- Process/module recreation: retained IDs/timestamps survive; replay does not falsely assign historical ownership.
- Malformed or extra native payload fields: validate before telemetry; never spread unknown metadata into logs.
- Account cleanup and session replacement: clear history and detach reporters without retaining the old identity.

### Task 1: Implement the diagnostic path from native scheduling to telemetry

**Files:**
- Create `packages/mobile/modules/background-refresh/ios/BackgroundRefreshDiagnostics.swift` and its focused Swift test.
- Modify native `BackgroundRefreshModule.swift`, `BackgroundRefreshAppDelegateSubscriber.swift`, and `BackgroundRefreshTaskCoordinator.swift` with their existing tests.
- Modify `packages/mobile/modules/background-refresh/src/BackgroundRefreshModule.ts` and `index.ts`, with `index.test.ts`.
- Create `packages/mobile/lib/background-refresh-diagnostics.ts` and its colocated test.
- Integrate in `packages/mobile/app/_layout.tsx`, `app-tests/_layout.cleanup.test.tsx`, `lib/mobile-account-purge.ts` and its colocated test.
- Update shared test/story mocks only where the native contract requires it.
- Update module README and `docs/whoop-ble-protocol.md` with the emitted contract and Axiom queries.

**Interfaces:**
- Native public APIs: `getDiagnostics()` returns `{ events, overflowCount }`, `clearDiagnostics()` clears retained history, and `recordRefreshReceived(taskId)` records JS receipt. Export wrappers through module `index.ts` only.
- Required event fields: `eventId`, `occurredAt`, `nativeSessionId`, `processId`, `event`; optional lifecycle fields: `taskId`, `taskIdentifier`, `earliestBeginAt`, `success`, `reason`, `backgroundRefreshStatus`, `lowPowerModeEnabled`, `errorDomain`, `errorCode`, `errorDescription`.
- Event names cover `registration_result`, `schedule_requested`, `schedule_succeeded`, `schedule_failed`, `task_launched`, `listener_changed`, `bridge_dispatched`, `js_received`, `completion_requested`, `task_completed`, `task_expired`.
- JS reporter: a focused factory owns replay IDs, validates native payloads, and reports on initial setup/foreground/handler receipt and settlement. Logs use category `background-refresh`, `event=native_background_refresh_event`, `nativeEvent`, `nativeOccurredAt`, `diagnosticAccountProvenance=unknown`, and `historyOverflowCount`; copy only known fields.
- Existing coordinator methods remain production entry points; add diagnostic injection without making required production dependencies optional or changing task outcomes. Report unexpected scheduling/bridge failures to Sentry.

- [x] Write failing native tests for retained history across recreation, nondestructive reads, overflow and clearing, actual completion reasons including missing listener/expiration/late completion.
- [x] Write failing mobile tests for received/settled handler instrumentation, replay deduplication, exact safe telemetry fields, malformed input error reporting, foreground subscription teardown, and account-purge clearing.
- [x] Run the tests and record the expected missing-behavior failures before implementation.
- [x] Implement the native journal and boundary recording using the existing pattern; avoid external callbacks while native state locks are held.
- [x] Expose the typed bridge and wire the focused reporter to the authenticated app lifecycle and refresh callback; clear native history through existing cleanup ownership gates.
- [x] Run focused Swift/mobile tests, mobile typecheck and strict SwiftLint on changed native files; document public contract, queries and native-build boundary.
- [x] Self-review, commit, push, and write the report with exact commands/results and remaining validation limits.
- [x] Independent task review: spec compliance and code quality; resolve material findings before completion.

### Task 2: Validate and record the complete change

**Files:** Documentation/working notes and any minimal reviewer-directed fixes in Task 1's files.

**Interfaces:** Consumes Task 1's report and committed implementation. Produces verified branch, native build evidence and incident follow-up.

- [x] Run the repository's Docker-free unit/mobile tier once and appropriate typechecks/lint; reuse focused check evidence unless code changes invalidate it.
- [ ] Build the iOS app to compile the Expo bridge using existing signed simulator procedures; distinguish compile/runtime evidence from physical-device scheduling.
- [x] Perform a whole-branch independent review after task review and verification.
- [ ] Append the incident baseline with direct observability fix, validation results, physical rollout boundary, and short retrospective; keep this plan's review checkpoints current.
- [ ] Commit/push remaining documentation and fixes; report the diagnostics added, checks, and new-native-build requirement.
