# Resolve PostHog-Owned Defects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix repository-owned PostHog defects and stop expected user-input failures from entering error tracking while holding transient, provider, and infrastructure failures.

**Architecture:** Preserve the existing error-reporting boundary. Make expected authentication and import-validation failures explicitly classifiable, keep unexpected failures reportable, and repair the two current server defects at their call boundaries: BullMQ Redis custom commands and provider method binding.

**Tech Stack:** TypeScript, Vitest, BullMQ, Redis, Express, React/React Native, PostHog error tracking, Sentry-compatible error reporting.

**Spec:**

- Repository-owned defects: fix the mobile auth exchange Redis command misuse and the unbound Strava webhook method.
- User input: do not call `captureException` for invalid credentials, invalid password-reset requests, or Strong CSV validation/import-content failures. Continue surfacing actionable messages to the user.
- Transient/provider/infrastructure failures: do not change runtime behavior; place their current PostHog issues on hold after the fix is released.
- Existing technical diagnostics and unexpected errors must remain reportable.

## Global Constraints

- Follow test-first development: each behavior change gets a failing regression test before implementation.
- Preserve atomic one-time Redis code consumption; do not replace it with a non-atomic `GET`/`DEL` sequence.
- Keep web and mobile authentication telemetry behavior aligned.
- Do not add environment variables, dependencies, or HTTP development servers.
- Run targeted tests, typechecks, lint, and the repository’s required verification before committing.
- Commit and push each completed change to the existing branch.

## Task 1: Repair the Redis mobile-auth exchange command

**Files:** `packages/server/src/lib/mobile-auth-exchange-store.ts`, `packages/server/src/lib/mobile-auth-exchange-store.test.ts`

- [x] Update the Redis-client regression test doubles to model BullMQ’s supported `defineCommand`/`runCommand` interface and assert the atomic custom command invocation.
- [x] Run the focused test and confirm it fails because the production code still calls the unsupported `sendCommand` shape.
- [x] Implement an atomic Lua GET-and-DEL custom command through BullMQ’s Redis client adapter, preserving the existing TTL and payload validation behavior.
- [x] Run the focused store test and the server typecheck.

## Task 2: Preserve provider method binding for targeted webhooks

**Files:** `packages/server/src/routes/webhooks.ts`, `packages/server/src/routes/webhooks.test.ts`

- [x] Add a failing route regression test whose `syncWebhookEvent` reads `this.id`, matching the live Strava stack failure when the method is detached.
- [x] Run the focused webhook test and verify the detached method reproduces the TypeError/fallback.
- [x] Invoke the provider’s targeted sync method with its provider receiver intact.
- [x] Run the focused webhook test and server typecheck.

## Task 3: Exclude expected user-input failures from error reporting

**Files:** `packages/auth/src/auth.ts`, `packages/auth/src/auth.test.ts`, `packages/format/src/user-facing-error.ts`, `packages/format/src/user-facing-error.test.ts`, `packages/web/src/lib/query-client.ts`, `packages/web/src/lib/query-client.test.ts`, `packages/web/src/routes/login.tsx`, `packages/web/src/routes/-login.test.tsx`, `packages/web/src/routes/reset-password.tsx`, `packages/web/src/routes/-reset-password.test.tsx`, `packages/mobile/app/login.tsx`, `packages/mobile/app-tests/login.test.tsx`, `src/jobs/import-validation-error.ts`, `src/jobs/process-import-job.ts`, `src/jobs/process-import-job.test.ts`, `src/jobs/worker.ts`, `src/jobs/worker.test.ts`

- [x] Add failing auth-domain tests for the exact server-authored invalid-credential and invalid-reset messages, including a nearby unexpected error that must remain reportable.
- [x] Add failing web and mobile login tests proving invalid credentials are shown to the user without `captureException`, while service failures still call it.
- [x] Add a named Strong CSV validation error classifier and failing import/worker tests proving malformed or invalid Strong uploads remain terminal but are not captured.
- [x] Implement the shared auth classifier, gate web/mobile auth reporting with it, preserve the Strong validation error name, classify Strong/Apple import-content failures, and apply the same suppression at the worker failure boundary.
- [x] Run all affected unit tests and both platform typechecks.

## Task 4: Verify and update PostHog issue state

**PostHog project:** `347753`

- [x] Re-query the fixed issue fingerprints and confirm the live stacks correspond to the repaired code paths.
- [x] Resolve the repository-owned issues that are fixed or already stale because current code and regression tests cover them (including the old BLE and provider-stats releases).
- [x] Put transient network, provider, ClickHouse, and infrastructure issues on the supported PostHog hold status without changing application behavior.
- [x] Re-query the issue list to verify fixed issues are no longer active and held issues are not being treated as defects under active remediation.

## Task 5: Final verification and handoff

- [x] Run the repository lint, relevant unit suites, and required TypeScript checks without ad-hoc waits or disabled gates. Source/policy lint, the Docker-free aggregate tests, affected suites, and root typecheck passed; analytics SQL lint was blocked only because ClickHouse was unavailable on `127.0.0.1:8123`.
- [x] Review the diff for unrelated changes, secrets, silent catches, and stale comments.
- [x] Append the production-incident baseline entry if the PostHog work represents an operational debugging session, including root cause, fix, validation, and remaining held risk.
- [x] Commit the completed implementation, push the branch, and report commit/remote status plus the short retrospective and documentation/skill improvement proposals.
