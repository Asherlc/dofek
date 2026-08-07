# Life Events Responsive Controls TDD Plan

Write the failing regression test before changing the component.

**Goal:** Keep the Life Events event pills and `+ Add event` control readable and non-overlapping on narrow web viewports and with enlarged text.

**Behavior:** Below the small breakpoint, the event list and add control occupy separate stacked rows, the event list may shrink and wrap, and the add control reserves the full available row. At the small breakpoint and above, the existing horizontal layout returns.

**Scope:** Responsive web only. Preserve event selection, pagination, form behavior, server contracts, and the desktop presentation. This is a user-approved exception to the dual-platform parity rule: the reported defect is in the mobile-width web layout, `LifeEventsPanel` exists only in `packages/web`, and `packages/mobile` has no equivalent Life Events surface to update or test. Adding one would create an unrelated native feature rather than restore parity.

**Evidence:** Issue [#2159](https://github.com/Asherlc/dofek/issues/2159) and audit finding `TRACK-06` report that `+ Add event` overlaps the Travel Week event on mobile-width web layouts.

---

## Current Evidence

- `packages/web/src/components/LifeEventsPanel.tsx` puts the wrapping event list and a non-shrinking add button in one always-horizontal flex row.
- The event-list flex item retains its default automatic minimum width, so it can compete with the add button for space instead of shrinking within the row.
- `packages/web/src/components/LifeEventsPanel.stories.tsx` fixes the story frame at 760 px, preventing the existing story from reproducing a narrow viewport accurately.

## Test Strategy

- Unit: render a representative Travel Week event and assert the mobile-first stacking, shrinkability, and full-width add-control contracts, plus their `sm` desktop overrides.
- Storybook: add a representative Travel Week story in a fluid frame.
- Runtime responsive audit: build production Storybook and inspect element rectangles and horizontal overflow at 320, 375, and 390 CSS px.
- Large-text audit: at 320 CSS px, set the root font size to 32 px (200% of the default 16 px), repeat the rectangle and overflow checks, and visually inspect a screenshot.
- Integration: no server or database behavior changes, so no new integration test is needed.

## File Structure

- Modify: `packages/web/src/components/LifeEventsPanel.test.tsx` — add the failing responsive regression.
- Modify: `packages/web/src/components/LifeEventsPanel.tsx` — stack controls below `sm`, allow the event list to shrink, and reserve the add-control row.
- Modify: `packages/web/src/components/LifeEventsPanel.stories.tsx` — make the story frame fluid and add a Travel Week fixture.

## Tasks

### Task 1: Add the Failing Regression

- [ ] Render a Travel Week event in the colocated component test.
- [ ] Assert that the controls stack below `sm`, return to a row at `sm`, and that the event list can shrink.
- [ ] Assert that the add control is full width below `sm` and automatic width at `sm`.
- [ ] Run the focused test and confirm it fails against the current layout.

### Task 2: Implement the Responsive Layout

- [ ] Add the minimum mobile-first flex utilities to stack the control groups.
- [ ] Add `min-w-0` to the wrapping event-list flex item.
- [ ] Reserve the full narrow row for the add control and restore its intrinsic width at `sm`.
- [ ] Run the focused test and confirm it passes.

### Task 3: Make the Reproduction Executable

- [ ] Replace the fixed-width Storybook frame with a fluid frame capped at the existing desktop width.
- [ ] Add a Travel Week story using representative event data.
- [ ] Build production Storybook.
- [ ] Verify no intersection or horizontal overflow at 320, 375, and 390 CSS px.
- [ ] Repeat the 320 px check at a 32 px root font size and inspect screenshots.

### Task 4: Final Verification and Delivery

- [ ] Run relevant lint, typecheck, unit tests, and repository checks.
- [ ] Review the complete diff for scope, accessibility, and desktop regressions.
- [ ] Commit, push, and open one PR with `Fixes #2159`.
- [ ] Link the PR from the issue, move the issue to In review, and monitor CI and review feedback through merge.
