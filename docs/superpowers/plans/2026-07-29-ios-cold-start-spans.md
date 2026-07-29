# iOS Cold-Start Spans TDD Plan

**Goal:** Attribute iOS cold-start time across native OTA launch, JavaScript readiness, authentication, and deferred service bootstrap, then remove only the measured splash-path bottleneck.

**Behavior:** Every Release cold start emits one correlated startup trace with phase durations and launch context; the native splash stops waiting on network update delivery when measured evidence confirms the configured launch wait dominates startup.

**Scope:** Mobile startup telemetry, focused unit tests, Expo Updates launch policy if supported by measurements, Release Simulator before/after evidence, and incident documentation. Non-goals include dashboard-query optimization, changing authenticated data loading, moving service work back onto the critical path, or weakening update signature verification.

**Docs:** [`docs/performance/loading-performance-runbook.md`](../../performance/loading-performance-runbook.md), [`packages/mobile/README.md`](../../../packages/mobile/README.md), [Expo Updates startup configuration](https://docs.expo.dev/versions/latest/sdk/updates/), [Expo splash-screen guidance](https://docs.expo.dev/versions/latest/sdk/splash-screen/), [Sentry custom tracing](https://docs.sentry.io/platforms/react-native/tracing/instrumentation/custom-instrumentation/)

---

## Current Evidence

- The audit observed roughly seven seconds of native splash on a Release cold start at source `e4c429ea2`.
- `packages/mobile/app.json` sets `updates.checkAutomatically` to `ON_LOAD` and `updates.fallbackToCacheTimeout` to `5000`, allowing the native OTA procedure to hold launch for five seconds before using cached assets.
- [Expo documents](https://docs.expo.dev/versions/latest/sdk/updates/)
  `fallbackToCacheTimeout` as the launch-time wait before falling back to the
  newest local update and exposes `Updates.launchDuration` for the measured
  native launch time.
- `packages/mobile/app/_layout.tsx` keeps the splash visible until `AuthProvider` finishes SecureStore restore and, when a token exists, `auth.me`.
- Authenticated HealthKit, accelerometer, Watch, and WHOOP services are already gated behind `runAfterUiIdle()`, so checked-in code places them after splash hide; instrumentation must confirm that ordering rather than assume it.
- A seven-day Sentry span query for startup/app-start/cold-start names returned no results, so current production telemetry cannot allocate the delay.
- Axiom discovery is currently blocked because the connected token is missing or expired. No backend optimization is justified by the available evidence.

## Test Strategy

- Unit: test a startup trace coordinator with deterministic clocks, exactly-once phase completion, Expo launch metadata, failures, and final trace closure.
- Mobile integration-by-composition: test auth bootstrap and root-layout wiring through their public provider/layout behavior, using mocked telemetry and native modules.
- Static config: validate `app.json` with Expo config/prebuild tooling rather than a dedicated config unit test.
- Runtime: build a signed Release Simulator app, force-stop between launches, capture startup logs and visible-first-screen time before and after any launch-policy change.
- UI/mobile/web parity: startup behavior is native iOS-only; no web change is required because no shared API or visible feature contract changes.

## File Structure

- Create: `packages/mobile/lib/startup-telemetry.ts` - correlated startup trace and phase lifecycle.
- Create: `packages/mobile/lib/startup-telemetry.test.ts` - deterministic phase attribution tests.
- Modify: `packages/mobile/lib/telemetry.ts` - enable only the intended startup tracing sample.
- Modify: `packages/mobile/lib/auth-context.tsx` - mark auth bootstrap start/completion and outcome.
- Modify: `packages/mobile/app/_layout.tsx` - mark JavaScript readiness, splash hide, and deferred service bootstrap.
- Modify if proven: `packages/mobile/app.json` - stop holding cold launch for network OTA delivery.
- Modify: `packages/mobile/README.md` - document the launch policy and startup evidence.
- Modify: `docs/production-incident-baseline.md` - record symptom, evidence, root cause, fix, remaining risk, and validation.

## Tasks

### Task 1: Establish Baseline Evidence

- [x] Generate the canonical Release iOS project and use XcodeBuildMCP with a dedicated Simulator.
- [x] Capture cold-start logs, `Updates.launchDuration`, auth timing, visible-screen timing, and the first slow line.
- [x] Classify the slowdown using the loading-performance runbook.
- [x] Record the Axiom authentication blocker and the absence of existing Sentry startup spans.

### Task 2: Add Failing Startup Telemetry Tests

**Files:**
- Create: `packages/mobile/lib/startup-telemetry.test.ts`
- Modify: `packages/mobile/lib/auth-context.test.ts`

- [x] Expect OTA, JavaScript, auth, splash, and service phases to share one startup trace.
- [x] Expect every phase to finish once with duration and outcome attributes.
- [x] Expect auth success, unauthenticated completion, deferred background restore, and failure to close the auth phase correctly.
- [x] Run `pnpm exec vitest run --project mobile packages/mobile/lib/startup-telemetry.test.ts packages/mobile/lib/auth-context.test.ts`.
- [x] Confirm failure because the coordinator and lifecycle calls do not exist.

### Task 3: Implement Startup Spans

**Files:**
- Create: `packages/mobile/lib/startup-telemetry.ts`
- Modify: `packages/mobile/lib/telemetry.ts`
- Modify: `packages/mobile/lib/auth-context.tsx`
- Modify: `packages/mobile/app/_layout.tsx`

- [x] Create the smallest startup trace coordinator supported by the installed Sentry SDK.
- [x] Record Expo launch duration/source, JavaScript readiness, auth outcome, splash hide, and deferred service bootstrap without adding blocking work.
- [x] Emit structured local/OTLP logs alongside the trace so Release Simulator evidence remains inspectable.
- [x] Run the focused mobile tests and confirm they pass.

### Task 4: Apply the Evidence-Backed Launch Fix

**Files:**
- Modify if proven: `packages/mobile/app.json`

- [x] Compare the measured native OTA launch duration with JavaScript, auth, and service durations.
- [x] Retain the current launch fallback because no controlled launch approached it; the conditional launch-policy change was not supported by evidence.
- [x] Validate the generated native configuration and signed Release bundle.
- [x] Do not change auth or service behavior unless their measured spans identify them as the critical-path bottleneck.

### Task 5: Final Verification And Documentation

- [x] Build and cold-launch the signed Release app at least three times with the instrumented steady-state configuration.
- [x] Confirm the real first screen appears, startup spans/logs allocate all requested phases, and unauthenticated service bootstrap is skipped.
- [x] Run `pnpm lint`, `pnpm tsc --noEmit`, server/web/mobile typechecks, focused mobile tests, and the full unit/mobile suite until its unrelated Docker teardown hang.
- [x] Update mobile docs and the production incident baseline with measured evidence and official citations.
- [ ] Commit, push, open a PR with `Fixes #2193`, backlink the issue, and monitor CI/reviews through merge.
