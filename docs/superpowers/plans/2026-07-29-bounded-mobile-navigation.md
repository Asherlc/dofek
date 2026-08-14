# Bounded Mobile Navigation TDD Plan

**Goal:** Replace the small-screen web navigation that pushes page content downward with a bounded, accessible top-sheet menu.

**Behavior:** Opening navigation on phone and tablet widths leaves the page layout in place, moves keyboard focus into a scroll-bounded modal sheet, and provides link, Close-button, Escape-key, and outside-pointer dismissal. Closing restores focus to the menu trigger. Crossing the desktop breakpoint closes the sheet and leaves the existing sidebar navigation unchanged.

**Scope:** Issue [#2188](https://github.com/Asherlc/dofek/issues/2188). Modify the web `AppHeader`, its colocated tests, and its Storybook stories. Reuse the repository's existing `ModalDialog` abstraction over Radix Dialog; do not add another dialog, popover, drawer, or menu dependency. The native app is a documented non-goal because its global navigation is five fixed Expo Router tabs and exposes no expandable equivalent.

**Docs:** Radix documents automatic modal focus trapping, Escape dismissal, screen-reader title announcement, and close-focus behavior in its [Dialog primitive](https://www.radix-ui.com/primitives/docs/components/dialog). The W3C modal-dialog pattern requires focus to move inside, remain contained during Tab navigation, close on Escape, and return to a logical element after closing in the [Dialog (Modal) Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

---

## Current Evidence

- `AppHeader.tsx` conditionally inserts ten small-screen navigation links inside the header's normal document flow.
- Chrome 150 at a 390-by-844 viewport reproduces the audit behavior against the existing AppHeader Storybook story: opening navigation increases the header height, Escape leaves it open, and clicking outside leaves it open.
- `PageLayout.tsx` places `AppHeader` immediately before the content shell, so the expanded header displaces section navigation and main content.
- `ModalDialog.tsx` is the canonical portal-based modal primitive and already implements focus containment, background inertness, Escape handling, focus restoration, and optional outside-pointer dismissal.
- `packages/mobile/app/(tabs)/_layout.tsx` renders five fixed native tabs (`Today`, `Recovery`, `Training`, `Activities`, and `Nutrition`) with no expandable global menu.

## Test Strategy

- Unit: AppHeader tests cover modal semantics, first-link focus, Tab containment, focus restoration, explicit Close, Escape, outside-pointer, navigation-link dismissal, scroll bounds, and automatic close when the viewport crosses `lg`.
- Responsive regression: tests preserve the compact mobile trigger and desktop sidebar while proving the opened navigation is a fixed portal instead of in-flow header content.
- Storybook/runtime: add an open-mobile-navigation significant variant; verify phone (390 px), tablet (768 px), and desktop (1024 px or wider) behavior in Chrome, including unchanged main-content position.
- Mobile parity: inspect and document the fixed native tab layout; no mobile code change is applicable.

## File Structure

- Modify: `packages/web/src/components/AppHeader.test.tsx` — failing interaction, focus, scroll-bound, and responsive tests.
- Modify: `packages/web/src/components/AppHeader.tsx` — bounded top-sheet implementation using `ModalDialog`.
- Modify: `packages/web/src/components/AppHeader.stories.tsx` — opened mobile-navigation visual variant.
- Modify: `cypress/e2e/navigation.cy.ts` — responsive browser regression proving page content is not displaced.

## Tasks

### Task 1: Add Failing Unit and Responsive Tests

**Files:**
- Modify: `packages/web/src/components/AppHeader.test.tsx`
- Modify: `cypress/e2e/navigation.cy.ts`

- [ ] Test modal naming, visible Close action, and scroll-bounded fixed positioning.
- [ ] Test first-link focus, Tab containment, Escape dismissal, and trigger-focus restoration.
- [ ] Test outside-pointer, Close-button, and destination-link dismissal.
- [ ] Test automatic dismissal when the viewport crosses the `lg` breakpoint.
- [ ] Test at a phone viewport that opening navigation does not change main-content position.
- [ ] Run `rtk pnpm test:unit -- --run packages/web/src/components/AppHeader.test.tsx`.
- [ ] Confirm the new unit tests fail because the current navigation is in flow and lacks the dismissal/focus behavior.

### Task 2: Implement the Minimum Fix

**Files:**
- Modify: `packages/web/src/components/AppHeader.tsx`

- [ ] Render the small-screen destination list in the existing `ModalDialog` portal as a top sheet.
- [ ] Provide an accessible title, visible Close action, vertical navigation links, and bounded internal scrolling.
- [ ] Close on link, Close, Escape, outside interaction, and transition to the desktop breakpoint.
- [ ] Preserve the current desktop sidebar and compact mobile header.
- [ ] Run `rtk pnpm test:unit -- --run packages/web/src/components/AppHeader.test.tsx`.
- [ ] Confirm the focused tests pass.

### Task 3: Update Storybook and Runtime Verification

**Files:**
- Modify: `packages/web/src/components/AppHeader.stories.tsx`

- [ ] Add a significant open-mobile-navigation story while retaining default, loading, empty/no-user, action, and alert variants.
- [ ] Run `rtk pnpm --dir packages/web build-storybook`.
- [ ] Run the focused Cypress navigation spec against the isolated E2E stack because this PR changes that spec.
- [ ] Verify Chrome behavior at 390 px, 768 px, and 1024 px or wider: content position remains stable, focus remains bounded, every dismissal path works, internal overflow is bounded, and the desktop sidebar is unchanged.

### Task 4: Final Verification and Delivery

- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/server tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/web tsc --noEmit`.
- [ ] Run `rtk pnpm test`.
- [ ] Push every commit, open a PR with `Fixes #2188`, link it from the issue, and monitor checks and review feedback through squash merge.
