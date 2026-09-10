# Sentry Issue Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the verified Redis deploy outage and make Zepp's upstream HTTP 500 failures retryable, then resolve the corresponding Sentry issues after production validation.

**Architecture:** Pin the Redis container image to the exact production-tested digest so unrelated stack deploys cannot replace it through a mutable tag. Keep the shared 502–504 service-unavailable classification unchanged, but let the Zepp HTTP client opt into status 500 through the common fetch wrapper; the existing sync retry path then defers Zepp API outages rather than reporting them as terminal errors.

**Tech Stack:** Docker Swarm stack configuration, TypeScript, Vitest, `@dofek/provider-http`, Sentry.

**Spec:** User-approved approach in this conversation on 2026-08-20; production evidence: `DOFEK-SERVER-67`, `DOFEK-SERVER-P`, `DOFEK-SERVER-5G`, and `DOFEK-SERVER-3B`.

## Global Constraints

- Apply only the two verified root-cause fixes; do not add retry knobs, fallback paths, or unrelated resilience changes.
- Production images use immutable, current stable pins; Redis is pinned to the digest currently running successfully in production.
- Configuration-only changes do not receive source-text or unit regression tests; validate by YAML parsing and the existing deployment config checks.
- Use TDD for the provider HTTP behavior change: write and observe a failing test before changing production code.
- Resolve Sentry issues only after production evidence verifies the relevant fix.

---

### Task 1: Add an opt-in HTTP 500 service-unavailability classification for Zepp

**Files:**
- Modify: `packages/provider-http/src/rate-limit.test.ts`
- Modify: `packages/provider-http/src/rate-limit.ts`
- Modify: `src/providers/amazfit-zepp.test.ts`
- Modify: `src/providers/amazfit-zepp.ts`

**Interfaces:**
- Consumes: `createRateLimitAwareFetch(fetchFn, options): typeof globalThis.fetch`
- Produces: default callers retain 502–504 classification; a caller that opts into status 500 receives `ProviderServiceUnavailableError` for that response.

- [x] **Step 1: Write the failing test**

  In the existing status-classification test, prove that default callers receive a normal HTTP 500 response, while a wrapper configured with an additional `500` status receives `ProviderServiceUnavailableError`:

  ```ts
  for (const statusCode of [502, 503, 504]) {
  ```

  Also add a Zepp public-client regression that proves its configured wrapper turns HTTP 500 into `ProviderServiceUnavailableError`.

- [x] **Step 2: Run the focused test to verify it fails**

  Run: `pnpm test -- packages/provider-http/src/rate-limit.test.ts`

  Expected: the configured `500` iteration fails because the wrapper returns a normal `Response`, not `ProviderServiceUnavailableError`.

- [x] **Step 3: Write the minimal implementation**

  Add an optional `additionalServiceUnavailableStatusCodes` configuration to the shared wrapper and enable it only for `AmazfitZeppClient` / `AmazfitZeppProvider`:

  ```ts
  createRateLimitAwareFetch(fetchFn, {
    providerId: "amazfit-zepp",
    additionalServiceUnavailableStatusCodes: [500],
  });
  ```

- [x] **Step 4: Run the focused test to verify it passes**

  Run: `pnpm test -- packages/provider-http/src/rate-limit.test.ts`

  Expected: PASS.

### Task 2: Make Redis deploys immutable

**Files:**
- Modify: `deploy/stack.yml:583`

**Interfaces:**
- Consumes: Docker image reference format `repository:tag@sha256:digest`.
- Produces: a stable Redis service image reference that resolves to `redis:7-alpine@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf`.

- [x] **Step 1: Pin the image**

  Replace:

  ```yaml
  image: redis:7-alpine
  ```

  with:

  ```yaml
  image: redis:7-alpine@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf
  ```

- [x] **Step 2: Validate the stack configuration**

  Run: `docker compose -f deploy/stack.yml config --quiet`

  Expected: exit status 0. This is configuration validation; do not add a static config test.

### Task 3: Propagate provider service-unavailable failures to the existing retry path

**Files:**
- Modify: `src/providers/amazfit-zepp.test.ts`
- Modify: `src/providers/amazfit-zepp.ts`
- Modify: `src/jobs/process-sync-job.test.ts`
- Modify: `src/jobs/process-sync-job.ts`
- Modify: `src/jobs/worker.test.ts`
- Modify: `src/jobs/worker.ts`

**Interfaces:**
- Consumes: `ProviderServiceUnavailableError` produced by the common provider HTTP client for HTTP 500.
- Produces: a Zepp sync that rethrows the typed error; `processSyncJob` rethrows it to BullMQ's existing configured retry/backoff; the worker does not report that known transient error to Sentry on failed attempts.

- [x] **Step 1: Write the failing regression tests**

  Add public-boundary tests that prove a Zepp HTTP 500 is rethrown without a provider-level `captureException`, `processSyncJob` rejects with `ProviderServiceUnavailableError` without reporting it, and the worker failed handler skips Sentry capture for that same error type.

- [x] **Step 2: Run the focused tests to verify they fail**

  Run:

  ```bash
  node node_modules/vitest/vitest.mjs run src/providers/amazfit-zepp.test.ts src/jobs/process-sync-job.test.ts src/jobs/worker.test.ts
  ```

  Expected: the new tests fail because only `ProviderRateLimitError` is propagated/suppressed.

- [x] **Step 3: Write the minimal propagation implementation**

  Rethrow `ProviderServiceUnavailableError` at each Zepp sync boundary. In `processSyncJob`, update progress and rethrow that error before generic infrastructure and terminal-error handling so BullMQ applies its already-configured retry/backoff. In the worker's failed handler, log the known service outage at warning level without calling Sentry; preserve Sentry capture for all other failed jobs.

- [x] **Step 4: Run the focused tests to verify they pass**

  Run:

  ```bash
  node node_modules/vitest/vitest.mjs run src/providers/amazfit-zepp.test.ts src/jobs/process-sync-job.test.ts src/jobs/worker.test.ts
  ```

  Expected: PASS.

### Task 4: Verify, release, and resolve Sentry state

**Files:**
- Modify: `docs/production-incident-baseline.md`

**Interfaces:**
- Consumes: the normal CI deploy workflow and Sentry issue status API.
- Produces: deployed fix evidence and resolved statuses for `DOFEK-SERVER-67`, `DOFEK-SERVER-P`, and `DOFEK-SERVER-5G`.

- [x] **Step 1: Run the applicable local checks**

  Run:

  ```bash
  pnpm test -- packages/provider-http/src/rate-limit.test.ts
  pnpm lint
  pnpm tsc --noEmit
  cd packages/server && pnpm tsc --noEmit
  ```

  Expected: all commands pass.

- [ ] **Step 2: Commit and push the verified change**

  Commit with a message that references the Sentry issue IDs, then push so the normal production deployment workflow applies the change.

- [ ] **Step 3: Verify production after deployment**

  Confirm the Redis service still uses the exact digest, `scripts/check-clickhouse-cdc.ts` passes, and fresh production Sentry searches show no new `ENOTFOUND redis`, `ECONNRESET`, or Zepp HTTP 500 errors from the new release.

- [ ] **Step 4: Record the operational evidence**

  Append a concise incident-baseline entry with the deployment timestamp, the paired Redis error evidence, the immutable image fix, the 500 classification fix, and the validation outcome.

- [ ] **Step 5: Resolve verified issues**

  Set `DOFEK-SERVER-67`, `DOFEK-SERVER-P`, and `DOFEK-SERVER-5G` to resolved in Sentry, including the production validation evidence in each resolution note.
