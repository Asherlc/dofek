# PostHog User Identification TDD Plan

> **For agentic workers:** Write and run the failing tests before changing production code.

**Goal:** Associate web analytics with the authenticated Dofek user and clear that association after logout.

**Behavior:** After authentication bootstrap returns a user, the web client identifies that user to PostHog with the stable database ID, name, and email. After a successful logout request, it resets PostHog before navigation completes.

**Scope:** Web only, because PostHog is currently installed and initialized only in `packages/web`; adding a second mobile analytics SDK is out of scope.

**Docs:** [PostHog user identification](https://posthog.com/docs/product-analytics/identify)

---

## Current Evidence

- `packages/web/src/lib/posthog.ts` initializes PostHog and captures page views but exposes no user identity lifecycle.
- `packages/web/src/lib/auth-context.tsx` is the canonical web authentication lifecycle and already receives the validated `AuthUser`.
- The current [PostHog identification guidance](https://posthog.com/docs/product-analytics/identify) says to identify as soon as the frontend knows the authenticated user and to reset on logout.

## Test Strategy

- Unit: Verify the PostHog adapter forwards the stable user ID and person properties to `identify()` and delegates logout cleanup to `reset()`.
- UI/auth lifecycle: Render `AuthProvider` with mocked auth and analytics adapters; verify authenticated bootstrap identifies, unauthenticated bootstrap does not identify, and successful logout resets.
- Platform parity: No mobile change because the mobile package does not use PostHog; this change completes the lifecycle of the existing web-only integration.

## File Structure

- Modify: `packages/web/src/lib/posthog.test.ts` — adapter regression tests.
- Modify: `packages/web/src/lib/posthog.ts` — typed identity and reset helpers.
- Create: `packages/web/src/lib/auth-context.test.tsx` — auth lifecycle regression tests.
- Modify: `packages/web/src/lib/auth-context.tsx` — connect authenticated bootstrap/logout to PostHog.

## Tasks

### Task 1: Add Failing Tests

- [x] Add adapter tests for `identify()` and `reset()`.
- [x] Add auth-provider tests for authenticated, anonymous, and logout paths.
- [x] Run `pnpm exec vitest run packages/web/src/lib/posthog.test.ts packages/web/src/lib/auth-context.test.tsx`.
- [x] Confirm failures are caused by the missing identity lifecycle.

### Task 2: Implement Minimal Fix

- [x] Add typed PostHog identity/reset helpers.
- [x] Identify after the authenticated user is known.
- [x] Reset only after the logout request succeeds so a failed logout cannot desynchronize analytics from the still-live server session.
- [x] Run the focused tests and confirm they pass.

### Task 3: Final Verification

- [x] Run `pnpm lint`.
- [x] Run root, server, web, and mobile typechecks.
- [x] Run the full Docker-free test suite.
- [ ] Commit, push, open the linked PR, and monitor review and CI through merge.
