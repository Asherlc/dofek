# Responsive Correlation and Life Event Controls TDD Plan

> **For agentic workers:** Write each failing regression before changing production code. Track the tasks below in order.

**Goal:** Keep Correlation controls and selected life-event analysis controls visible, readable, and operable at 320 px, 390 px, and 200% root text.

**Behavior:** Narrow layouts stack controls instead of clipping or widening the document; the existing compact layout returns at the `sm` breakpoint.

**Scope:** Fix the remaining responsive web defects from issue [#2187](https://github.com/Asherlc/dofek/issues/2187). Preserve the life-event list/add-form fix from [PR #2278](https://github.com/Asherlc/dofek/pull/2278), server contracts, and desktop behavior. Native mobile has no equivalent Correlation or life-event surface, so adding one is outside this responsive-web fix.

**Docs:** Approved strategy and measured evidence are recorded in [issue comment #5118643319](https://github.com/Asherlc/dofek/issues/2187#issuecomment-5118643319).

---

## Current Evidence

- At 320 px with a 32 px root font, Correlation lag buttons extend to x=576 and are clipped.
- At 390 px with a 32 px root font, the Correlation lag row still extends to x=576.
- At 320 px with default text, selected life-event controls expand the document to 409 px.
- At 320 px with a 32 px root font, selected life-event controls expand the document to 788 px and Delete ends at x=707.

## Test Strategy

- Unit: assert the mobile-first and `sm` responsive class contracts in `CorrelationExplorerPage` and `LifeEventsPanel`.
- Browser acceptance: use Cypress at 320 px and 390 px, with both default and 200% root text, to verify every targeted control remains within its viewport and no targeted surface overflows horizontally.
- Storybook: add narrow Correlation and opened life-event analysis scenarios for visual inspection.
- Integration: no server or database behavior changes; E2E setup seeds the minimum existing life-event record needed to open the selected-event analysis.

## File Structure

- Modify: `packages/web/src/pages/CorrelationExplorerPage.test.tsx` — failing Correlation responsive contract test.
- Modify: `packages/web/src/components/LifeEventsPanel.test.tsx` — failing selected-event header responsive contract test.
- Modify: `cypress/e2e/responsive-controls.cy.ts` — 320/390 px and large-text browser acceptance.
- Modify: `cypress.config.ts` — remove seeded life events during existing E2E cleanup.
- Modify: `packages/web/src/pages/CorrelationExplorerPage.tsx` — responsive Correlation controls.
- Modify: `packages/web/src/components/LifeEventsPanel.tsx` — responsive selected-event analysis header.
- Modify: `packages/web/src/pages/CorrelationExplorerPage.stories.tsx` — narrow control story.
- Modify: `packages/web/src/components/LifeEventsPanel.stories.tsx` — opened narrow analysis story.

## Tasks

### Task 1: Add Failing Unit Regressions

- [x] Assert Correlation selectors, lag choices, comparison text, and experiment action use mobile-first stacking/grid contracts with `sm` desktop overrides.
- [x] Assert selected life-event metadata, window choices, and Delete control use mobile-first stacking/grid contracts with `sm` desktop overrides.
- [x] Run `rtk pnpm exec vitest run --project unit packages/web/src/pages/CorrelationExplorerPage.test.tsx packages/web/src/components/LifeEventsPanel.test.tsx`.
- [x] Confirm the tests fail against the current horizontal layouts.

### Task 2: Add Browser Acceptance

- [x] Seed one existing life-event row for the authenticated E2E user.
- [x] Exercise Correlation and Tracking at 320 px and 390 px.
- [x] Repeat both widths with a 32 px root font.
- [x] Assert targeted controls are visible, remain inside the viewport, and do not create horizontal overflow.

### Task 3: Implement the Minimum Responsive Fix

- [x] Stack metric selectors and comparison text below `sm`.
- [x] Use a two-column mobile lag grid with wrapping explanatory text.
- [x] Stack selected-event metadata and controls below `sm`.
- [x] Use a four-column mobile window grid and a separately reachable Delete action.
- [x] Run the focused unit tests and confirm they pass.

### Task 4: Update Executable Stories

- [x] Add a 320 px Correlation story.
- [x] Add a 320 px selected life-event analysis story that opens the event in its play function.
- [x] Run `rtk pnpm --filter dofek-web build-storybook`.

### Task 5: Validate and Deliver

- [ ] Run `rtk pnpm e2e:web -- --spec cypress/e2e/responsive-controls.cy.ts`.
- [ ] Run required lint, typechecks, focused tests, and Docker-free test tiers.
- [ ] Commit and push each meaningful passing chunk.
- [ ] Open a PR with `Fixes #2187`, link it from the issue, monitor CI/reviews, address feedback, and merge.
