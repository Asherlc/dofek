# Today Plan Vertical Slice TDD Plan

> **For agentic workers:** Follow TDD. For each task: write a failing test first, run it to confirm failure, implement the smallest change that passes, re-run the focused tests, then move on. Use the checkbox (`- [ ]` / `- [x]`) syntax for tracking.

**Goal:** Ship a read-only, deterministic Today Plan card on web and mobile home screens from server-owned recovery and strain-target logic.

**Behavior:** Given fresh recovery data, the server returns one primary action, two supporting facts, confidence and freshness context. Without recovery data, the server returns an explicit insufficient-data state with an actionable message. Web and mobile render the same server payload at the top of their home experiences without recomputing health meaning.

**Scope:**
- Included: consolidate duplicate strain-target result assembly; pure Today Plan rules; `todayPlan.get` tRPC procedure; web/mobile cards + stories/tests; home-screen placement.
- Non-goals (owned by other roadmap workspaces): accept/modify/dismiss, outcome check-in, product events, notifications/widgets, goal persistence, experiments, expanded Data Trust Center provenance UI.

**Docs:** [Product roadmap PR #2034](https://github.com/Asherlc/dofek/pull/2034); existing `@dofek/scoring/strain-target`; `recovery.strainTarget`; mobile training-tab strain target assembly.

---

## Current Evidence

- Roadmap requires one server-owned primary action with supporting facts, freshness/confidence, insufficient-data handling, deterministic rules, and web/mobile parity from the first release.
- `packages/server/src/routers/recovery.ts` and `packages/server/src/services/mobile-training-tab.ts` duplicate nearly identical strain-target assembly over `analytics.daily_recovery` and `analytics.daily_strain`.
- Web Dashboard and mobile Today tab already surface readiness/strain widgets but do not present a single primary action card.

## Test Strategy

- Unit: Today Plan recommendation rules (zone → action title/summary, supporting facts, confidence, insufficient-data).
- Unit: Shared strain-target result builder used by recovery + mobile training tab.
- Router/unit: `todayPlan.get` contract for ready and insufficient payloads.
- UI/mobile/web parity: component tests and Storybook stories for ready, insufficient, and loading states; home screens query and render the card first.

## File Structure

- Create: `packages/scoring/src/today-plan.ts` / `.test.ts` — pure rules + types
- Create: `packages/server/src/services/strain-target-result.ts` / `.test.ts` — shared builder
- Create: `packages/server/src/services/today-plan.ts` / `.test.ts` — load inputs + build response
- Create: `packages/server/src/routers/today-plan.ts` / `.test.ts` — tRPC surface
- Modify: `packages/server/src/router.ts`, recovery router, mobile-training-tab — register + reuse builder
- Create: `packages/web/src/components/TodayPlanCard.tsx` (+ test/stories); wire into `Dashboard.tsx`
- Create: `packages/mobile/components/TodayPlanCard.tsx` (+ test/stories); wire into `app/(tabs)/index.tsx`
- Modify: `packages/scoring/package.json` exports for `./today-plan`

## Tasks

### Task 1: Add Failing Today Plan Rule Tests

**Files:**
- Create: `packages/scoring/src/today-plan.test.ts`

- [x] Write failing tests for Push/Maintain/Recovery actions, two supporting facts, confidence tiers, and insufficient-data.
- [x] Run `rtk pnpm --filter @dofek/scoring test src/today-plan.test.ts` (or workspace-equivalent vitest path).
- [x] Confirm the tests fail because the module does not exist yet.

### Task 2: Implement Today Plan Rules

**Files:**
- Create: `packages/scoring/src/today-plan.ts`
- Modify: `packages/scoring/package.json`

- [x] Implement the smallest pure builder that satisfies the failing tests.
- [x] Export `./today-plan` from the package.
- [x] Confirm the scoring tests pass.

### Task 3: Consolidate Strain Target Result Builder (tests first)

**Files:**
- Create: `packages/server/src/services/strain-target-result.test.ts`
- Create: `packages/server/src/services/strain-target-result.ts`
- Modify: `packages/server/src/routers/recovery.ts`
- Modify: `packages/server/src/services/mobile-training-tab.ts`

- [x] Write failing tests for the shared builder covering readiness missing → null/undefined and a populated result.
- [x] Implement the builder and switch both call sites to it without behavior change.
- [x] Run focused recovery + mobile-training-tab + new builder tests.

### Task 4: Today Plan Service + Router (tests first)

**Files:**
- Create: `packages/server/src/services/today-plan.test.ts` / `.ts`
- Create: `packages/server/src/routers/today-plan.test.ts` / `.ts`
- Modify: `packages/server/src/router.ts`

- [x] Write failing service/router tests for ready and insufficient_data contracts.
- [x] Implement loader over existing `daily_recovery`, `daily_strain`, and `daily_sleep` read models.
- [x] Register `todayPlan` on the app router.
- [x] Confirm focused server tests pass.

### Task 5: Web + Mobile Cards (tests first)

**Files:**
- Create web/mobile `TodayPlanCard` components, tests, and stories
- Modify Dashboard and mobile Today tab

- [x] Write failing component tests for ready, insufficient, and loading states.
- [x] Implement presentational cards that only render server fields.
- [x] Place the card at the top of web Dashboard and mobile Today after processing/status chrome.
- [x] Add Storybook stories for significant states.
- [x] Confirm focused web/mobile tests pass.

### Task 6: Final Verification

- [ ] Run `rtk pnpm lint`, focused unit tests, and package typechecks required by AGENTS.md.
- [ ] Commit focused changes, push, open a PR against `main`, and monitor CI/review feedback.
