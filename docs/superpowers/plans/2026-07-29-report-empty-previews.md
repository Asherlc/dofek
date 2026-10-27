# Report Empty Previews TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `write-tests` before implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain the exact data requirement and future structure of empty Reports and Alerts without inventing personal values or conclusions.

**Behavior:** Empty weekly and monthly reports render a server-owned, report-kind-specific requirement and value-free section preview on web and mobile. Empty Alerts render one shared preview of the real alert structure on both platforms.

**Scope:** Keep existing report calculations, query windows, populated report UI, and alert generation unchanged. Do not add sample metric values, personal conclusions, new endpoints, or unrelated reporting features.

**Docs:** [Issue #2173](https://github.com/Asherlc/dofek/issues/2173)

---

## Current Evidence

- Weekly and monthly empty states currently say only that data is absent or insufficient.
- The report repositories return no report only when there are no activity, sleep, or recovery observations; one observed day satisfies the actual minimum.
- Processing alerts always contain what happened (`title` and `message`), when it happened (`occurredAt`), and what to do next (`actionLabel`).
- Web and mobile duplicate empty-state copy instead of consuming canonical semantics.

## Test Strategy

- Unit: Prove report-kind discriminants, one-day requirements, exact value-free preview labels, and the shared Alerts structure copy.
- Integration: Run each report repository against ClickHouse with an empty user and a user with one observed day; prove the empty contract appears only for the empty user.
- UI/mobile/web parity: Prove both clients render server-owned report copy unchanged and the same shared Alerts preview copy.
- Storybook/runtime: Cover report and alert variants in web and mobile stories, build both Storybooks, and inspect the relevant rendered states.

## File Structure

- Create: `packages/server/src/contracts/report-empty-state.ts` - canonical report-kind-specific empty contract.
- Modify: `packages/server/src/repositories/weekly-report-repository.ts` - return weekly empty metadata when no report exists.
- Modify: `packages/server/src/repositories/monthly-report-repository.ts` - return monthly empty metadata when no report exists.
- Modify: repository unit/integration tests - prove empty and one-day transitions.
- Modify: `packages/providers-meta/src/processing-alerts.ts` - canonical Alerts empty structure copy.
- Create: web/mobile `EmptyStatePreview` components with colocated tests and stories.
- Modify: web/mobile Reports and Alerts surfaces and tests to consume canonical copy.
- Modify: existing report and Alerts stories to exercise empty variants.

## Tasks

### Task 1: Add Failing Server and Shared-Contract Tests

**Files:**

- Create: `packages/server/src/contracts/report-empty-state.test.ts`
- Modify: weekly/monthly repository unit and integration tests
- Modify: `packages/providers-meta/src/processing-alerts.test.ts`

- [ ] Write failing tests for explicit weekly/monthly discriminants, `minimumObservedDays: 1`, field-backed preview labels, and the no-estimate note.
- [ ] Prove empty ClickHouse users receive empty metadata and one observed day transitions to a populated report with no empty metadata.
- [ ] Write a failing test for the shared Alerts preview structure.
- [ ] Run `rtk pnpm vitest run --project unit packages/server/src/contracts/report-empty-state.test.ts packages/providers-meta/src/processing-alerts.test.ts packages/server/src/repositories/weekly-report-repository.test.ts packages/server/src/repositories/monthly-report-repository.test.ts`.
- [ ] Run the focused repository integration tests through `rtk pnpm test:integration -- packages/server/src/repositories/weekly-report-repository.integration.test.ts packages/server/src/repositories/monthly-report-repository.integration.test.ts`.
- [ ] Confirm failures are caused by the missing canonical contracts.

### Task 2: Implement the Canonical Contracts

**Files:**

- Create: `packages/server/src/contracts/report-empty-state.ts`
- Modify: `packages/server/src/repositories/weekly-report-repository.ts`
- Modify: `packages/server/src/repositories/monthly-report-repository.ts`
- Modify: `packages/server/src/types.ts`
- Modify: `packages/providers-meta/src/processing-alerts.ts`

- [ ] Implement the smallest discriminated server contract and repository return changes.
- [ ] Keep preview content label-only and explicitly state that no estimate is shown.
- [ ] Implement one shared Alerts structure constant.
- [ ] Re-run the focused unit and integration commands and confirm they pass.

### Task 3: Add Failing Web and Mobile Tests

**Files:**

- Create: web/mobile `EmptyStatePreview.test.tsx`
- Modify: weekly/monthly report component and screen tests
- Modify: web/mobile Alerts tests

- [ ] Write failing component tests for requirement, preview items, and no-estimate copy.
- [ ] Write failing screen tests proving server report copy is rendered verbatim.
- [ ] Write failing Alerts tests proving both clients render the canonical shared structure.
- [ ] Run `rtk pnpm vitest run --project unit packages/web/src/components/EmptyStatePreview.test.tsx packages/web/src/components/WeeklyReportCard.test.tsx packages/web/src/components/MonthlyReportContent.test.tsx packages/web/src/pages/AlertsPage.test.tsx`.
- [ ] Run `rtk pnpm vitest run --project mobile packages/mobile/components/EmptyStatePreview.test.tsx packages/mobile/app/reports.test.tsx packages/mobile/app/alerts.test.tsx`.
- [ ] Confirm failures are caused by the missing preview UI.

### Task 4: Implement Dual-Platform Rendering and Stories

**Files:**

- Create: web/mobile `EmptyStatePreview.tsx` and `.stories.tsx`
- Modify: web/mobile report and Alerts surfaces
- Modify: existing report and Alerts stories

- [ ] Render server-owned report metadata without client-side requirement derivation.
- [ ] Render the shared Alerts structure constant on both platforms.
- [ ] Add value-free report and alert stories for both Storybooks.
- [ ] Re-run the focused web/mobile tests and confirm they pass.

### Task 5: Final Verification

- [ ] Run `rtk pnpm lint`.
- [ ] Run root, server, web, mobile, and providers typechecks.
- [ ] Run `rtk pnpm test:changed` and required integration coverage.
- [ ] Build web and mobile Storybooks and inspect the relevant empty states.
- [ ] Commit, push, open a PR with `Fixes #2173`, add the issue backlink, and monitor all CI/review feedback through merge.
