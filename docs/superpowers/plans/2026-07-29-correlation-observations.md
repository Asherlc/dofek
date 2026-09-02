# Correlation Observation Inspection TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authenticated users inspect every daily observation behind a correlation and navigate to honest contributing-record or aggregate-input context on web and mobile.

**Behavior:** Correlation statistics and the bounded scatter projection remain unchanged. A new authenticated cursor-paginated endpoint returns complete newest-first paired observations with explicit X/Y dates, values, and server-resolved provenance. Web and mobile render accessible responsive observation views and allow every page to be inspected.

**Scope:** Add a shared server pairing/provenance path, a bounded date-cursor API, web/mobile tables or lists, tests, and stories. Do not add a universal record-detail route, change correlation math, migrate analytics schemas, fabricate singular lineage for aggregate or rolling metrics, or cap the total inspectable pair count.

**Docs:** [Issue #2153](https://github.com/Asherlc/dofek/issues/2153), [Vitest projects](https://vitest.dev/guide/projects), [tRPC output validation](https://trpc.io/docs/server/validators)

---

## Current Evidence

- `buildCorrelationAnalysis()` constructs every paired day used for the statistic, but `computeCorrelationV2()` exposes only `downsample(analysis.pairs, 300)` for the scatter plot.
- A point exposes only the X calendar date, so a lagged Y observation's date is not inspectable.
- `joinByDate()` discards record identity and source provenance before the result reaches the router.
- `correlation.computeV2` accepts `days: number | null` without a maximum, and web exposes `All`; returning every observation inline would therefore create an unbounded response.
- Existing queries are user-scoped. Canonical sources expose exact activity IDs and provider/source context for daily metrics, sleep, nutrition, activities, and body measurements, while rolling metrics represent aggregate inputs rather than a singular record.

## Test Strategy

- Unit: prove newest-first stable cursor pagination, all-time page union equals full n, lagged X/Y dates, and honest record versus aggregate-input contributor labels.
- Integration: run the repository/router against isolated real Postgres and ClickHouse fixtures to prove authenticated user scoping, canonical provider provenance, and contributing activity IDs.
- UI/mobile/web parity: prove both clients render dates/values, distinguish aggregate inputs, navigate exact activity records and provider collections, expose accessible pagination controls, and preserve current loading/error/chart behavior.

## File Structure

- Modify: `packages/server/src/repositories/correlation-repository.ts` - share canonical pairing and load provenance.
- Modify: `packages/server/src/repositories/correlation-repository.test.ts` - pairing, lag, provenance, and pagination unit coverage.
- Create: `packages/server/src/repositories/correlation-repository.integration.test.ts` - real database user/provenance coverage.
- Modify: `packages/server/src/routers/correlation.ts` - add authenticated bounded observation endpoint and schemas.
- Modify: `packages/server/src/routers/correlation.test.ts` and `packages/server/src/routers/router-sql.integration.test.ts` - validate the public contract and SQL execution.
- Modify: `packages/web/src/pages/CorrelationExplorerPage.tsx`, its test, and story - responsive accessible observation table and navigation.
- Modify: `packages/mobile/app/correlation.tsx`, its test, and story - responsive accessible observation list and navigation.

## Tasks

### Task 1: Add Failing Server Tests

**Files:**
- Modify: `packages/server/src/repositories/correlation-repository.test.ts`
- Create: `packages/server/src/repositories/correlation-repository.integration.test.ts`
- Modify: `packages/server/src/routers/correlation.test.ts`

- [ ] Write failing tests for full-n cursor traversal, cursor stability, lag-date fidelity, contributor selection, output validation, and cross-user exclusion.
- [ ] Run `pnpm test -- --run packages/server/src/repositories/correlation-repository.test.ts packages/server/src/routers/correlation.test.ts`.
- [ ] Run `pnpm test:integration -- --run packages/server/src/repositories/correlation-repository.integration.test.ts`.
- [ ] Confirm the tests fail because the observation endpoint and provenance do not exist.

### Task 2: Implement the Minimal Server Contract

**Files:**
- Modify: `packages/server/src/repositories/correlation-repository.ts`
- Modify: `packages/server/src/routers/correlation.ts`
- Modify: `packages/server/src/routers/router-sql.integration.test.ts`

- [ ] Share one pairing path between statistics and observation pagination.
- [ ] Add a newest-first date cursor with a small server-enforced page-size maximum and no total-count cap.
- [ ] Return explicit X/Y metric IDs, dates, values, contributor kind, labels, provider context, and exact activity IDs when available.
- [ ] Keep `computeV2` statistics and chart projection unchanged.
- [ ] Run the Task 1 commands and confirm they pass.

### Task 3: Add Failing Web and Mobile Tests

**Files:**
- Modify: `packages/web/src/pages/CorrelationExplorerPage.test.tsx`
- Modify: `packages/mobile/app/correlation.test.tsx`

- [ ] Write failing tests for row/list content, lagged dates, exact and aggregate navigation, accessibility, and next/previous pagination.
- [ ] Run `pnpm test -- --run packages/web/src/pages/CorrelationExplorerPage.test.tsx packages/mobile/app/correlation.test.tsx`.
- [ ] Confirm the tests fail because observation rendering does not exist.

### Task 4: Implement Dual-Platform Observation Views

**Files:**
- Modify: `packages/web/src/pages/CorrelationExplorerPage.tsx`
- Modify: `packages/web/src/pages/CorrelationExplorerPage.stories.tsx`
- Modify: `packages/mobile/app/correlation.tsx`
- Modify: `packages/mobile/app/correlation.stories.tsx`

- [ ] Render server values and provenance without computing associations in either client.
- [ ] Add accessible responsive table/list semantics and bounded page navigation.
- [ ] Add representative exact-record, aggregate-input, lagged, loading, and empty Storybook states.
- [ ] Run the Task 3 command and confirm it passes.

### Task 5: Final Verification and Delivery

- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm test:integration -- --run packages/server/src/repositories/correlation-repository.integration.test.ts packages/server/src/routers/router-sql.integration.test.ts`.
- [ ] Run the web and mobile Storybook/runtime checks required by their package guidance.
- [ ] Review `git diff --check` and `git diff origin/main...HEAD`.
- [ ] Commit, push, open a PR with `Fixes #2153`, link issue and PR, monitor checks/reviews, address feedback, and merge.
