# Accessible Chart Explanations TDD Plan

**Goal:** Make chart explanations visibly identifiable, keyboard and touch accessible, and explicitly dismissible on web and mobile.

**Behavior:** Every existing `ChartDescriptionTooltip` consumer inherits a visible `About` control with a 44-by-44 target. Web opens the explanation in the existing accessible dialog and restores focus when it closes. Mobile opens the explanation in a native alert with an explicit Close action.

**Scope:** Modify only the canonical web and mobile `ChartDescriptionTooltip` components, their colocated tests, focused stories, the shared web dialog's optional accessible-description wiring, and the shared mobile Pressable test mock needed to execute public press callbacks. Do not add a dependency, change individual chart consumers, or introduce a second disclosure primitive.

**References:**

- [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced) recommends 44-by-44 CSS-pixel custom targets for easier pointer and touch operation.
- [Apple accessibility guidance](https://developer.apple.com/design/human-interface-guidelines/accessibility) lists 44-by-44 points as the default iOS control size and recommends explicit dismissal instead of timed dismissal.
- [Radix Dialog documentation](https://www.radix-ui.com/primitives/docs/components/dialog) documents its WAI-ARIA dialog behavior, keyboard focus management, Escape dismissal, and focus return.

## Current Evidence

- Web renders a 16-by-16 plain `span` containing `i`. It is not a button, cannot receive keyboard focus, has no visible focus state, and reveals an always-mounted tooltip only through CSS hover.
- Mobile renders a Pressable containing only `i`, but the visible control is 18-by-18 points and its 8-point `hitSlop` provides only a 34-by-34 effective target.
- The two canonical components serve all current web and mobile chart-description consumers, so per-consumer edits are unnecessary.

## Test Strategy

- Web unit: require a visible labeled dialog trigger with 44-pixel minimum dimensions and focus-visible styling; prove activation, explicit Close, Escape/outside dismissal, and focus return.
- Mobile unit: require a visible labeled button with 44-point minimum dimensions and a pressed state; prove it opens the native explanation with an explicit Close action.
- Storybook: retain the focused web story and add a focused mobile story for the canonical control.

## File Structure

- Modify: `packages/web/src/components/ChartDescriptionTooltip.test.tsx`
- Modify: `packages/web/src/components/ChartDescriptionTooltip.tsx`
- Modify: `packages/web/src/components/ChartDescriptionTooltip.stories.tsx`
- Modify: `packages/web/src/components/ModalDialog.tsx`
- Modify: `packages/mobile/components/ChartDescriptionTooltip.test.tsx`
- Modify: `packages/mobile/components/ChartDescriptionTooltip.tsx`
- Modify: `packages/mobile/components/MetricCard.test.tsx`
- Modify: `packages/mobile/test-setup.ts`
- Add: `packages/mobile/test-setup.test.tsx`
- Add: `packages/mobile/components/ChartDescriptionTooltip.stories.tsx`

## Tasks

### Task 1: Add Failing Accessibility Tests

- [x] Require the web control to be a visible, labeled, focusable 44-pixel button.
- [x] Require the web explanation to mount only when activated and dismiss through Close, Escape, and outside interaction while restoring trigger focus.
- [x] Require the mobile control to be visibly labeled, at least 44 points, and to expose a pressed state.
- [x] Require the native explanation to include an explicit Close action.
- [x] Run `pnpm vitest run --project unit --project mobile packages/web/src/components/ChartDescriptionTooltip.test.tsx packages/mobile/components/ChartDescriptionTooltip.test.tsx` and confirm failure for the current static/small controls.

### Task 2: Implement the Canonical Controls

- [x] Reuse `ModalDialog` for the web explanation and add no dependency.
- [x] Render the mobile explanation through the existing native Alert API.
- [x] Keep component props and every consumer unchanged.
- [x] Run the focused tests and confirm they pass.

### Task 3: Stories and Final Verification

- [x] Update the web story and add the mobile canonical-control story.
- [x] Run focused tests, relevant typechecks, Biome, Storybook builds, and the repository unit tier.
- [ ] Push the linked branch and open a PR with `Fixes #2088`.
- [ ] Address all actionable review feedback and CI root causes, manually merge, and verify issue/project completion.
