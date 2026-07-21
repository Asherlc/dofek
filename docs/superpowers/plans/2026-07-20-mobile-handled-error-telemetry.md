# Report Mobile Handled Errors TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every unexpected mobile error that is caught, logged, aggregated, or shown to the user is also reported to Sentry.

**Behavior:** Mobile handled-error paths call the canonical `captureException()` helper with useful source context; genuinely expected control-flow failures are modeled without catch-and-ignore blocks.

**Scope:** Fix production TypeScript/TSX paths under `packages/mobile` and add a syntax-aware regression check. Do not report user cancellations or unavailable optional haptics as operational errors.

**Docs:** [`packages/mobile/AGENTS.md`](../../../packages/mobile/AGENTS.md), [`docs/sentry.md`](../../sentry.md)

---

## Current Evidence

- A TypeScript AST scan of 147 non-test mobile files found handled catches without `captureException()` or rethrowing.
- Confirmed unexpected paths include login provider discovery, provider OAuth/verification modals, external URL opening, HealthKit route work, inertial-measurement startup/save, WHOOP startup/diagnostics, BLE probe operations, and heart-rate/IMU visualization connections.
- Existing `packages/mobile/AGENTS.md` requires every unexpected catch to report, but lint does not enforce the invariant.

## Test Strategy

- Unit: add/extend component and service tests asserting `captureException()` receives the original error and a stable source tag before the UI error/fallback behavior continues.
- Static policy: parse production TypeScript catch handlers and reject handlers that consume unexpected errors without reporting or rethrowing.
- Integration/UI: exercise representative network, native-module, and connection failures while verifying the user-visible error remains actionable.

## File Structure

- Modify: affected files in `packages/mobile/app/`, `packages/mobile/components/`, and `packages/mobile/lib/` - report handled unexpected errors.
- Modify/create: colocated tests for each affected source file.
- Create/modify: a TypeScript mobile telemetry policy checker and tests - prevent recurrence without brittle text matching.
- Modify: `package.json` or mobile lint wiring - run the canonical policy check in CI.

## Tasks

### Task 1: Add Failing Tests

- [ ] Add focused failing tests for login provider discovery, auth modal failures, native connection failures, and background/service best-effort failures.
- [ ] Add a failing syntax-aware policy fixture for an unexpected catch that only logs, aggregates, or sets UI state.
- [ ] Run `rtk pnpm test:mobile` and the focused policy tests.

### Task 2: Implement the Minimal Fix

- [ ] Call the canonical mobile `captureException()` helper in every confirmed unexpected handled-error path with stable source context.
- [ ] Preserve current user-visible messages, cleanup, aggregation, and fallback behavior.
- [ ] Model expected cancellation/haptic availability without operational-error reporting.
- [ ] Wire the static policy check into the canonical lint/CI path.

### Task 3: Final Verification

- [ ] Run the syntax-aware scan across all production mobile TypeScript files and review every explicit exception.
- [ ] Run `rtk pnpm test:mobile`, `rtk pnpm --filter dofek-mobile typecheck`, and `rtk pnpm --filter dofek-mobile lint`.
- [ ] Exercise representative failures in the iOS Simulator and confirm both actionable UI errors and telemetry calls.
